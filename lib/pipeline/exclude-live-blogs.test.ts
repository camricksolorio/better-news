import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { feedItems, stories } from "@/db/schema";
import { connectTestDb, resetTestDb } from "@/tests/test-db";
import { excludeLiveBlogs } from "./exclude-live-blogs";

const { client, db } = connectTestDb();
afterAll(() => client.end());
beforeEach(() => resetTestDb(client));

let n = 0;
const item = async (sourceId: string, link: string, title = "A headline", over: Partial<typeof feedItems.$inferInsert> = {}) =>
  (await db.insert(feedItems).values({ sourceId, guid: `g${n++}`, title, link, ...over }).returning())[0];
const get = async (id: string) => (await db.select().from(feedItems).where(eq(feedItems.id, id)))[0];

describe("excludeLiveBlogs", () => {
  it("lists matches per source on a dry run and writes nothing", async () => {
    const live = await item("guardian-us", "https://www.theguardian.com/us-news/live/2026/oct/23/latest");
    await item("guardian-us", "https://www.theguardian.com/us-news/2026/oct/23/story");
    await item("npr-top", "https://www.npr.org/2026/10/24/x", "Live updates: debate night");
    const result = await excludeLiveBlogs(db, { dryRun: true });
    expect(result.bySource).toEqual({ "guardian-us": 1, "npr-top": 1 });
    expect(result.total).toBe(2);
    expect(result.samples.map((s) => s.link)).toContain(live.link);
    expect((await get(live.id)).excludedReason).toBeNull();
  });

  it("marks matches excluded, leaves stories alone, and skips rows already excluded", async () => {
    const [story] = await db
      .insert(stories)
      .values({
        firstArticleAt: new Date("2026-10-01T00:00:00Z"),
        lastArticleAt: new Date("2026-10-01T00:00:00Z"),
        windowEndsAt: new Date("2026-10-02T00:00:00Z"),
        centroid: Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)),
      })
      .returning();
    const live = await item("cbs-main", "https://www.cbsnews.com/live-updates/storm/", "Storm", {
      storyId: story.id,
      embedding: Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)),
      embeddingModel: "m",
      embeddingInputVersion: "v1",
      clusteredAt: new Date(),
    });
    const already = await item("cbs-main", "https://www.cbsnews.com/live-updates/old/", "Old", { excludedReason: "live_blog" });
    const result = await excludeLiveBlogs(db, { dryRun: false });
    expect(result.total).toBe(1);
    const after = await get(live.id);
    expect(after.excludedReason).toBe("live_blog");
    expect(after.storyId).toBe(story.id);
    expect((await get(already.id)).excludedReason).toBe("live_blog");
  });

  it("does not touch the PBS and Washington Examiner false positives", async () => {
    const pbs = await item("pbs-newshour", "https://www.pbs.org/newshour/nation/live-map-track-hurricane", "LIVE MAP: Track the hurricane");
    const wex = await item("washington-examiner", "https://www.washingtonexaminer.com/news/1/live-grenade-training/", "Live grenade training");
    const result = await excludeLiveBlogs(db, { dryRun: false });
    expect(result.total).toBe(0);
    expect((await get(pbs.id)).excludedReason).toBeNull();
    expect((await get(wex.id)).excludedReason).toBeNull();
  });
});
