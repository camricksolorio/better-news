import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { evalPairLabels, feedItems, stories, storyAssignments } from "@/db/schema";
import { connectTestDb, resetTestDb } from "@/tests/test-db";
import { DEFAULT_CLUSTER_CONFIG, type Adjudicator } from "@/lib/pipeline/assign";
import { runClusterStage } from "@/lib/pipeline/cluster";
import { listStories, loadStory, markDoesntBelong } from "./admin-stories";

const { client, db } = connectTestDb();
afterAll(() => client.end());
beforeEach(() => resetTestDb(client));

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 1, 12, 0);
const far = () => Date.now() + 60_000;
const at = (deg: number) => {
  const v = new Array(768).fill(0);
  v[0] = Math.cos((deg * Math.PI) / 180);
  v[1] = Math.sin((deg * Math.PI) / 180);
  return v;
};
// The classifier agrees to everything and says so, so every join records who it was judged against.
const yes: Adjudicator = async () => ({ same: true, verdict: { relation: "same", pSame: 0.97, model: "jev-test" } });

let n = 0;
async function article(hours: number, deg: number, over: Partial<typeof feedItems.$inferInsert> = {}) {
  const [row] = await db
    .insert(feedItems)
    .values({
      sourceId: "src",
      guid: `g${n++}`,
      title: `Headline ${n} &amp; more`,
      link: `https://x.test/${n}`,
      summary: "a reasonably long description of the article, well over forty characters",
      publishedAt: new Date(T0 + hours * H),
      embedding: at(deg),
      embeddingModel: "gemini-embedding-2",
      embeddingInputVersion: "v1",
      ...over,
    })
    .returning();
  return row;
}
const cluster = () => runClusterStage(db, { deadline: far(), config: { ...DEFAULT_CLUSTER_CONFIG, tLow: 0.5 }, adjudicate: yes });
const get = async (id: string) => (await db.select().from(feedItems).where(eq(feedItems.id, id)))[0];
const story = async (id: string) => (await db.select().from(stories).where(eq(stories.id, id)))[0];
const labels = () => db.select().from(evalPairLabels);

// Three articles from three sources in one story (a, b, c in time order), clustered by the real stage.
async function threeInOne() {
  const a = await article(0, 0, { sourceId: "s1" });
  const b = await article(1, 0, { sourceId: "s2" });
  const c = await article(2, 0, { sourceId: "s3" });
  await cluster();
  const storyId = (await get(a.id)).storyId!;
  expect([(await get(b.id)).storyId, (await get(c.id)).storyId]).toEqual([storyId, storyId]);
  return { a, b, c, storyId };
}

describe("listStories", () => {
  it("lists multi-article stories newest first, with a headline, and filters by status and size", async () => {
    await article(0, 0);
    await article(1, 0);
    await article(30, 90); // a lone story
    await article(60, 45); // more than a window after the lone article, so a story of its own
    await article(61, 45);
    await cluster();
    const { rows, total } = await listStories(db);
    expect(total).toBe(2);
    expect(rows.map((r) => r.articleCount)).toEqual([2, 2]);
    expect(rows[0].lastArticleAt.getTime()).toBeGreaterThan(rows[1].lastArticleAt.getTime());
    expect(rows[0].headline).toMatch(/^Headline \d+ & more$/);
    expect((await listStories(db, { minArticles: 1 })).total).toBe(3); // the two pairs and the lone article
    expect((await listStories(db, { status: "open" })).total).toBe(0); // every window has passed by now
    expect((await listStories(db, { status: "closed", limit: 1, offset: 1 })).rows).toHaveLength(1);
  });
});

describe("loadStory", () => {
  it("returns members in time order with the method, scores, and who each join was judged against", async () => {
    const { a, b, c, storyId } = await threeInOne();
    const detail = (await loadStory(db, storyId))!;
    expect(detail).toMatchObject({ id: storyId, articleCount: 3, sourceCount: 3 });
    expect(detail.members.map((m) => m.id)).toEqual([a.id, b.id, c.id]);
    expect(detail.members[0]).toMatchObject({ method: "new_story", judgedAgainst: [] });
    const joined = detail.members[2];
    expect(joined.method).toBe("llm");
    expect(joined.topScore).toBeGreaterThan(0.99);
    expect(joined.judgedAgainst.map((j) => j.memberId)).toContain(a.id);
    expect(joined.judgedAgainst[0]).toMatchObject({ same: true, relation: "same", pSame: 0.97, model: "jev-test" });
    expect(joined.judgedAgainst[0].title).toMatch(/^Headline \d+ & more$/);
  });

  it("is null for an unknown story", async () => {
    expect(await loadStory(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("markDoesntBelong", () => {
  it("writes the human label and a manual assignment, and moves the article to a story of its own", async () => {
    const { a, b, c, storyId } = await threeInOne();
    const { newStoryId, labeledAgainst } = await markDoesntBelong(db, storyId, c.id, "related");

    // The label: against the member(s) the classifier judged it against.
    expect(labeledAgainst).toContain(a.id);
    const rows = await labels();
    expect(rows).toHaveLength(labeledAgainst.length);
    for (const r of rows) {
      expect(r).toMatchObject({ label: "related", labeler: "human", note: `inspector:${storyId}` });
      expect(r.articleA < r.articleB).toBe(true);
      expect([r.articleA, r.articleB]).toContain(c.id);
    }

    // The manual assignment, appended to the log.
    const log = await db.select().from(storyAssignments).where(eq(storyAssignments.articleId, c.id)).orderBy(asc(storyAssignments.createdAt));
    expect(log.map((l) => l.method)).toEqual(["llm", "manual"]);
    expect(log[1]).toMatchObject({ storyId: newStoryId, pipelineVersion: "admin" });
    expect(log[1].llmVerdict).toMatchObject({ action: "doesnt_belong", label: "related", fromStoryId: storyId });

    // The article is in a new story of its own and stays clustered.
    const moved = await get(c.id);
    expect(moved.storyId).toBe(newStoryId);
    expect(moved.clusteredAt).not.toBeNull();
    expect(await story(newStoryId)).toMatchObject({ articleCount: 1, sourceCount: 1, firstArticleAt: moved.publishedAt, lastArticleAt: moved.publishedAt });

    // The old story no longer counts it.
    expect(await story(storyId)).toMatchObject({ articleCount: 2, sourceCount: 2, lastArticleAt: new Date(T0 + 1 * H) });
    expect((await get(a.id)).storyId).toBe(storyId);
    expect((await get(b.id)).storyId).toBe(storyId);
  });

  it("recomputes the old story's anchor, window and centroid when the first article is removed", async () => {
    const a = await article(0, 0, { sourceId: "s1" });
    const b = await article(1, 20, { sourceId: "s2" });
    const c = await article(2, 20, { sourceId: "s3" });
    await runClusterStage(db, { deadline: far(), config: { ...DEFAULT_CLUSTER_CONFIG, tLow: 0.5 }, adjudicate: yes });
    const storyId = (await get(a.id)).storyId!;
    await markDoesntBelong(db, storyId, a.id, "different");
    const s = await story(storyId);
    expect(s.firstArticleAt).toEqual(new Date(T0 + 1 * H));
    expect(s.windowEndsAt).toEqual(new Date(T0 + 1 * H + DEFAULT_CLUSTER_CONFIG.windowHours * H));
    // The centroid is the mean of the remaining members (both at 20 degrees).
    const expected = at(20);
    expect(s.centroid[0]).toBeCloseTo(expected[0], 5);
    expect(s.centroid[1]).toBeCloseTo(expected[1], 5);
    expect((await get(b.id)).storyId).toBe(storyId);
    expect((await get(c.id)).storyId).toBe(storyId);
  });

  it("labels against the story's earliest other member when the article did not join through the classifier", async () => {
    const { a, b, storyId } = await threeInOne();
    // `a` started the story (new_story, nothing judged), so the label falls back to the earliest other member.
    const { labeledAgainst } = await markDoesntBelong(db, storyId, a.id, "different");
    expect(labeledAgainst).toEqual([b.id]);
    expect(await labels()).toMatchObject([{ label: "different" }]);
  });

  it("replaces an existing human label for the same pair", async () => {
    const { a, c, storyId } = await threeInOne();
    const [x, y] = a.id < c.id ? [a.id, c.id] : [c.id, a.id];
    await db.insert(evalPairLabels).values({ articleA: x, articleB: y, label: "same", labeler: "human" });
    await markDoesntBelong(db, storyId, c.id, "different");
    const mine = (await labels()).find((r) => r.articleA === x && r.articleB === y)!;
    expect(mine).toMatchObject({ label: "different", labeler: "human" });
  });

  it("leaves the moved article alone when the cluster stage runs again", async () => {
    const { c, storyId } = await threeInOne();
    const { newStoryId } = await markDoesntBelong(db, storyId, c.id, "related");
    expect(await cluster()).toMatchObject({ processed: 0, remaining: 0 });
    expect((await get(c.id)).storyId).toBe(newStoryId);
  });

  it("refuses bad requests and writes nothing", async () => {
    const { a, c, storyId } = await threeInOne();
    const lone = await article(30, 90);
    await cluster();
    const loneStory = (await get(lone.id)).storyId!;
    const stranger = await article(100, 135); // far outside every window: a story of its own
    await cluster();

    await expect(markDoesntBelong(db, storyId, c.id, "same" as never)).rejects.toThrow(/invalid label/);
    await expect(markDoesntBelong(db, loneStory, lone.id, "related")).rejects.toThrow(/only article/);
    await expect(markDoesntBelong(db, storyId, stranger.id, "related")).rejects.toThrow(/not in this story/);
    await expect(markDoesntBelong(db, "00000000-0000-0000-0000-000000000000", a.id, "related")).rejects.toThrow(/not found/);

    expect(await labels()).toHaveLength(0);
    expect((await db.select().from(storyAssignments).where(eq(storyAssignments.method, "manual")))).toHaveLength(0);
    expect(await story(storyId)).toMatchObject({ articleCount: 3 });
  });

  it("refuses a second move of the same article out of the same story", async () => {
    const { c, storyId } = await threeInOne();
    await markDoesntBelong(db, storyId, c.id, "related");
    await expect(markDoesntBelong(db, storyId, c.id, "related")).rejects.toThrow(/not in this story/);
  });
});
