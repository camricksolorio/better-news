import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { articleVersions, feedItems } from "@/db/schema";
import { connectTestDb, resetTestDb } from "@/tests/test-db";
import { contentHash } from "@/lib/content-hash";
import type { ParsedFeedItem } from "@/lib/rss";
import { repairMissingVersions, storeFeedItems } from "./ingest";

const { client, db } = connectTestDb();
afterAll(() => client.end());
beforeEach(() => resetTestDb(client));

const item = (over: Partial<ParsedFeedItem> = {}): ParsedFeedItem => ({
  guid: "g1",
  title: "Court halts tariffs",
  link: "https://example.com/a/1",
  summary: "A federal court halted the tariffs.",
  imageUrl: null,
  publishedAt: new Date("2026-10-20T10:00:00Z"),
  ...over,
});

const row = async (guid: string) => (await db.select().from(feedItems).where(eq(feedItems.guid, guid)))[0];
const versions = async (guid: string) => {
  const r = await row(guid);
  return db.select().from(articleVersions).where(eq(articleVersions.articleId, r.id));
};

describe("storeFeedItems", () => {
  it("stores a new item with its first version, hash and clustering time", async () => {
    await storeFeedItems(db, "npr-top", [item()]);
    const r = await row("g1");
    const vs = await versions("g1");
    expect(vs).toHaveLength(1);
    expect(r.contentHash).toBe(contentHash("Court halts tariffs", "A federal court halted the tariffs."));
    expect(r.currentVersionId).toBe(vs[0].id);
    expect(r.firstPublishedAt.toISOString()).toBe("2026-10-20T10:00:00.000Z");
    expect(r.excludedReason).toBeNull();
    expect(vs[0].title).toBe("Court halts tariffs");
  });

  it("uses the first-seen time when the feed gives no date", async () => {
    await storeFeedItems(db, "npr-top", [item({ publishedAt: null })]);
    const r = await row("g1");
    expect(r.firstPublishedAt.getTime()).toBe(r.createdAt.getTime());
  });

  it("makes no new version when the text is unchanged", async () => {
    await storeFeedItems(db, "npr-top", [item()]);
    await storeFeedItems(db, "npr-top", [item()]);
    expect(await versions("g1")).toHaveLength(1);
  });

  it("makes a new version and moves current_version_id when the title changes", async () => {
    await storeFeedItems(db, "npr-top", [item()]);
    const first = (await row("g1")).currentVersionId;
    await storeFeedItems(db, "npr-top", [item({ title: "Court blocks tariffs" })]);
    const r = await row("g1");
    const vs = await versions("g1");
    expect(vs).toHaveLength(2);
    expect(r.currentVersionId).not.toBe(first);
    expect(vs.find((v) => v.id === r.currentVersionId)?.title).toBe("Court blocks tariffs");
    expect(vs.find((v) => v.id === first)?.title).toBe("Court halts tariffs");
  });

  it("returns to the earlier version, without a duplicate, when the text reverts", async () => {
    await storeFeedItems(db, "npr-top", [item()]);
    const first = (await row("g1")).currentVersionId;
    await storeFeedItems(db, "npr-top", [item({ title: "Court blocks tariffs" })]);
    await storeFeedItems(db, "npr-top", [item()]);
    expect(await versions("g1")).toHaveLength(2);
    expect((await row("g1")).currentVersionId).toBe(first);
  });

  it("makes no version for a published_at-only change, and keeps first_published_at", async () => {
    await storeFeedItems(db, "npr-top", [item()]);
    await storeFeedItems(db, "npr-top", [item({ publishedAt: new Date("2026-10-22T08:00:00Z") })]);
    const r = await row("g1");
    expect(await versions("g1")).toHaveLength(1);
    expect(r.publishedAt?.toISOString()).toBe("2026-10-22T08:00:00.000Z");
    expect(r.firstPublishedAt.toISOString()).toBe("2026-10-20T10:00:00.000Z");
  });

  it("handles a feed that repeats a guid", async () => {
    await storeFeedItems(db, "npr-top", [item(), item({ title: "Court halts tariffs (updated)" })]);
    expect(await versions("g1")).toHaveLength(1);
  });

  it("never inserts a live blog", async () => {
    const result = await storeFeedItems(db, "guardian-us", [
      item({ guid: "live1", link: "https://www.theguardian.com/us-news/live/2026/oct/23/trump-latest" }),
      item({ guid: "ok1", link: "https://www.theguardian.com/us-news/2026/oct/23/trump" }),
      item({ guid: "live2", title: "Live updates: debate night" }),
    ]);
    expect(await row("live1")).toBeUndefined();
    expect(await row("live2")).toBeUndefined();
    expect(await row("ok1")).toBeDefined();
    expect(result).toEqual({ stored: 1, excluded: 2 });
  });

  it("marks an existing row excluded when it starts matching, and stops updating it", async () => {
    await storeFeedItems(db, "guardian-us", [item({ link: "https://www.theguardian.com/us-news/2026/oct/23/trump" })]);
    await storeFeedItems(db, "guardian-us", [
      item({ link: "https://www.theguardian.com/us-news/live/2026/oct/23/trump", title: "Changed title" }),
    ]);
    const r = await row("g1");
    expect(r.excludedReason).toBe("live_blog");
    expect(r.title).toBe("Court halts tariffs");
    expect(await versions("g1")).toHaveLength(1);
  });
});

describe("storeFeedItems: unchanged rows", () => {
  // xmin changes whenever Postgres writes a new row version, which is what re-embedding-sized index churn comes from.
  const xmin = async (guid: string) =>
    ((await db.execute(sql`SELECT xmin::text AS x FROM feed_items WHERE guid = ${guid}`)) as unknown as { x: string }[])[0].x;

  it("does not rewrite a row whose feed fields are all unchanged", async () => {
    await storeFeedItems(db, "npr-top", [item()]);
    const before = await xmin("g1");
    await storeFeedItems(db, "npr-top", [item()]);
    expect(await xmin("g1")).toBe(before);
  });

  it.each([
    ["title", { title: "Court blocks tariffs" }],
    ["link", { link: "https://example.com/a/1-new" }],
    ["summary", { summary: "A different summary." }],
    ["image", { imageUrl: "https://example.com/i.jpg" }],
    ["published date", { publishedAt: new Date("2026-10-21T00:00:00Z") }],
  ] as [string, Partial<ParsedFeedItem>][])("rewrites the row when the %s changes", async (_name, change) => {
    await storeFeedItems(db, "npr-top", [item()]);
    const before = await xmin("g1");
    await storeFeedItems(db, "npr-top", [item(change)]);
    expect(await xmin("g1")).not.toBe(before);
  });

  it("treats a null summary or date that stays null as unchanged", async () => {
    await storeFeedItems(db, "npr-top", [item({ summary: null, publishedAt: null })]);
    const before = await xmin("g1");
    await storeFeedItems(db, "npr-top", [item({ summary: null, publishedAt: null })]);
    expect(await xmin("g1")).toBe(before);
  });

  it("repairs a row that has no current version even when its text is unchanged", async () => {
    await storeFeedItems(db, "npr-top", [item()]);
    await client.unsafe("UPDATE feed_items SET current_version_id = NULL");
    await client.unsafe("DELETE FROM article_versions");
    await storeFeedItems(db, "npr-top", [item()]);
    const r = await row("g1");
    expect(r.currentVersionId).not.toBeNull();
    expect(await versions("g1")).toHaveLength(1);
  });
});

describe("repairMissingVersions", () => {
  const vec = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));

  it("gives rows left without a version (a cut-off ingest) their version, and leaves the rest alone", async () => {
    await storeFeedItems(db, "npr-top", [
      item({ guid: "orphan" }),
      item({ guid: "orphan-embedded" }),
      item({ guid: "fine" }),
      item({ guid: "live" }),
    ]);
    await client.unsafe("UPDATE feed_items SET current_version_id = NULL WHERE guid IN ('orphan','orphan-embedded','live')");
    await client.unsafe("DELETE FROM article_versions WHERE article_id IN (SELECT id FROM feed_items WHERE guid IN ('orphan','orphan-embedded','live'))");
    await client.unsafe("UPDATE feed_items SET excluded_reason = 'live_blog' WHERE guid = 'live'");
    await db
      .update(feedItems)
      .set({ embedding: vec, embeddingModel: "m", embeddingInputVersion: "v1" })
      .where(eq(feedItems.guid, "orphan-embedded"));
    const fineBefore = (await row("fine")).currentVersionId;

    expect(await repairMissingVersions(db)).toEqual({ repaired: 2 });

    const orphan = await row("orphan");
    expect(orphan.currentVersionId).not.toBeNull();
    expect(orphan.embeddingVersionId).toBeNull();
    // A vector that exists was built from the text that was current when it was embedded.
    const embedded = await row("orphan-embedded");
    expect(embedded.embeddingVersionId).toBe(embedded.currentVersionId);
    expect((await row("fine")).currentVersionId).toBe(fineBefore);
    expect((await row("live")).currentVersionId).toBeNull();
    expect(await repairMissingVersions(db)).toEqual({ repaired: 0 });
  });
});
