import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { feedItems, stories, storyAssignments, evalPairLabels } from "@/db/schema";
import { connectTestDb, dbError, resetTestDb } from "@/tests/test-db";

const { client, db } = connectTestDb();
afterAll(() => client.end());
beforeEach(() => resetTestDb(client));

const vec = (x = 1) => Array.from({ length: 768 }, (_, i) => (i === 0 ? x : 0));
const t = (iso: string) => new Date(iso);

async function makeStory(over: Partial<typeof stories.$inferInsert> = {}) {
  const [s] = await db
    .insert(stories)
    .values({
      firstArticleAt: t("2026-10-01T00:00:00Z"),
      lastArticleAt: t("2026-10-01T01:00:00Z"),
      windowEndsAt: t("2026-10-02T12:00:00Z"),
      centroid: vec(),
      ...over,
    })
    .returning();
  return s;
}

let n = 0;
async function makeItem(over: Partial<typeof feedItems.$inferInsert> = {}) {
  const [i] = await db
    .insert(feedItems)
    .values({ sourceId: "x", guid: `g${n++}`, title: "t", link: "https://x/1", ...over })
    .returning();
  return i;
}

describe("feed_items invariants", () => {
  it("rejects clustered_at without an embedding", async () => {
    const s = await makeStory();
    expect(await dbError(makeItem({ storyId: s.id, clusteredAt: new Date() }))).toMatch(/feed_items_clustered_check/);
  });

  it("rejects clustered_at without a story", async () => {
    expect(await dbError(makeItem({
        embedding: vec(),
        embeddingModel: "m",
        embeddingInputVersion: "v1",
        clusteredAt: new Date(),
      }))).toMatch(/feed_items_clustered_check/);
  });

  it("rejects an embedding without model or input version", async () => {
    expect(await dbError(makeItem({ embedding: vec() }))).toMatch(/feed_items_embedding_meta_check/);
    expect(await dbError(makeItem({ embedding: vec(), embeddingModel: "m" }))).toMatch(/feed_items_embedding_meta_check/);
  });

  it("accepts a fully clustered row", async () => {
    const s = await makeStory();
    await expect(
      makeItem({
        embedding: vec(),
        embeddingModel: "m",
        embeddingInputVersion: "v1",
        storyId: s.id,
        clusteredAt: new Date(),
      }),
    ).resolves.toBeTruthy();
  });

  it("rejects clearing the embedding on a clustered row", async () => {
    const s = await makeStory();
    const i = await makeItem({
      embedding: vec(),
      embeddingModel: "m",
      embeddingInputVersion: "v1",
      storyId: s.id,
      clusteredAt: new Date(),
    });
    expect(await dbError(db.execute(sql`UPDATE feed_items SET embedding = NULL WHERE id = ${i.id}`))).toMatch(/feed_items_clustered_check/);
  });
});

describe("stories invariants", () => {
  it("rejects an unknown status", async () => {
    expect(await dbError(makeStory({ status: "pending" }))).toMatch(/stories_status_check/);
  });

  it("rejects first_article_at after last_article_at", async () => {
    expect(await dbError(makeStory({ firstArticleAt: t("2026-10-01T05:00:00Z"), lastArticleAt: t("2026-10-01T01:00:00Z") }))).toMatch(/stories_span_check/);
  });

  it("rejects a window that ends before the last article", async () => {
    expect(await dbError(makeStory({ windowEndsAt: t("2026-10-01T00:30:00Z") }))).toMatch(/stories_window_check/);
  });

  it("allows open to closed but not closed to open", async () => {
    const s = await makeStory();
    await db.execute(sql`UPDATE stories SET status = 'closed' WHERE id = ${s.id}`);
    expect(await dbError(db.execute(sql`UPDATE stories SET status = 'open' WHERE id = ${s.id}`))).toMatch(/cannot be reopened/);
  });

  it("still allows other updates to a closed story", async () => {
    const s = await makeStory({ status: "closed" });
    await expect(
      db.execute(sql`UPDATE stories SET article_count = 5 WHERE id = ${s.id}`),
    ).resolves.toBeTruthy();
  });
});

describe("story_assignments append-only", () => {
  async function makeAssignment() {
    const s = await makeStory();
    const i = await makeItem();
    const [a] = await db
      .insert(storyAssignments)
      .values({ articleId: i.id, storyId: s.id, method: "new_story" })
      .returning();
    return a;
  }

  it("allows inserts", async () => {
    await expect(makeAssignment()).resolves.toBeTruthy();
  });

  it("rejects UPDATE", async () => {
    const a = await makeAssignment();
    expect(await dbError(db.execute(sql`UPDATE story_assignments SET method = 'manual' WHERE id = ${a.id}`))).toMatch(/append-only/);
  });

  it("rejects DELETE", async () => {
    const a = await makeAssignment();
    expect(await dbError(db.execute(sql`DELETE FROM story_assignments WHERE id = ${a.id}`))).toMatch(/append-only/);
  });

  it("rejects an unknown method", async () => {
    const s = await makeStory();
    const i = await makeItem();
    expect(await dbError(db.insert(storyAssignments).values({ articleId: i.id, storyId: s.id, method: "guess" }))).toMatch(/story_assignments_method_check/);
  });
});

describe("eval_pair_labels", () => {
  it("rejects an unknown label and an unordered pair", async () => {
    const [a, b] = (await Promise.all([makeItem(), makeItem()])).sort((x, y) => (x.id < y.id ? -1 : 1));
    expect(await dbError(db.insert(evalPairLabels).values({ articleA: a.id, articleB: b.id, label: "maybe", labeler: "human" }))).toMatch(/eval_pair_labels_label_check/);
    expect(await dbError(db.insert(evalPairLabels).values({ articleA: b.id, articleB: a.id, label: "same", labeler: "human" }))).toMatch(/eval_pair_labels_order_check/);
    await expect(
      db.insert(evalPairLabels).values({ articleA: a.id, articleB: b.id, label: "same", labeler: "human" }),
    ).resolves.toBeTruthy();
  });
});
