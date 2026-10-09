import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { feedItems, stories, storyAssignments } from "@/db/schema";
import { connectTestDb, resetTestDb } from "@/tests/test-db";
import { DEFAULT_CLUSTER_CONFIG, assignArticle, type Adjudicator } from "./assign";
import { CircuitOpenError, QuotaExhaustedError } from "@/lib/llm";
import { MAX_CLUSTER_ATTEMPTS, runClusterStage } from "./cluster";
import { createDbStore } from "./store-db";
import type { Db } from "@/db/types";
import { createMemoryStore } from "./store-memory";

const { client, db } = connectTestDb();
afterAll(() => client.end());
beforeEach(() => resetTestDb(client));

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 1, 12, 0);
const far = () => Date.now() + 60_000;
const yes: Adjudicator = async () => ({ same: true });
// These tests were written for a 36h window and a 0.75 floor; the classifier always agrees.
const cfg36 = { ...DEFAULT_CLUSTER_CONFIG, tLow: 0.75, windowHours: 36 };
const at = (deg: number) => {
  const v = new Array(768).fill(0);
  v[0] = Math.cos((deg * Math.PI) / 180);
  v[1] = Math.sin((deg * Math.PI) / 180);
  return v;
};

let n = 0;
async function embedded(hours: number, deg: number, over: Partial<typeof feedItems.$inferInsert> = {}) {
  const [row] = await db
    .insert(feedItems)
    .values({
      sourceId: "src",
      guid: `g${n++}`,
      title: `t${n}`,
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

const get = async (id: string) => (await db.select().from(feedItems).where(eq(feedItems.id, id)))[0];
const story = async (id: string) => (await db.select().from(stories).where(eq(stories.id, id)))[0];

describe("runClusterStage", () => {
  it("clusters embedded rows, marks them, and logs each decision", async () => {
    const a = await embedded(0, 0);
    const b = await embedded(1, 0, { sourceId: "other" });
    const c = await embedded(2, 90);
    const result = await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: yes });
    expect(result).toMatchObject({ processed: 3, remaining: 0, failed: 0 });
    const [ra, rb, rc] = await Promise.all([get(a.id), get(b.id), get(c.id)]);
    expect(ra.storyId).toBe(rb.storyId);
    expect(rc.storyId).not.toBe(ra.storyId);
    expect(ra.clusteredAt).toBeInstanceOf(Date);
    const s = await story(ra.storyId!);
    expect(s).toMatchObject({ articleCount: 2, sourceCount: 2 });
    const log = await db.select().from(storyAssignments).orderBy(asc(storyAssignments.createdAt));
    expect(log.map((l) => l.method).sort()).toEqual(["llm", "new_story", "new_story"]);
    expect(log[0].pipelineVersion).toMatch(/^[0-9a-f]{12}$/);
  });

  it("ignores rows embedded with a different model, and does not use them as candidates", async () => {
    const other = await embedded(0, 0, { embeddingModel: "old-model" });
    const mine = await embedded(1, 0);
    const result = await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: yes });
    expect(result).toMatchObject({ processed: 1, remaining: 0 });
    expect((await get(other.id)).clusteredAt).toBeNull();
    expect((await get(mine.id)).clusteredAt).not.toBeNull();
  });

  it("turns on HNSW iterative scans for the candidate query (kNN spike, 2026-10-05)", async () => {
    const setting = await db.transaction(async (tx) => {
      const store = createDbStore(tx as unknown as Db, "test");
      await store.candidates(
        { id: "x", sourceId: "s", time: new Date(), embedding: at(0), thin: false },
        DEFAULT_CLUSTER_CONFIG,
      );
      const [row] = (await tx.execute(sql`SHOW hnsw.iterative_scan`)) as unknown as { "hnsw.iterative_scan": string }[];
      return row["hnsw.iterative_scan"];
    });
    expect(setting).toBe("relaxed_order");
  });

  it("candidates name the story's earliest article and the member most similar to the article (D34)", async () => {
    const first = await embedded(0, 0);
    const second = await embedded(1, 20);
    await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: yes });
    const [cand] = await db.transaction(async (tx) =>
      createDbStore(tx as unknown as Db, "test").candidates(
        { id: "x", sourceId: "s", time: new Date(T0 + 2 * H), embedding: at(22), thin: false },
        cfg36,
      ),
    );
    expect(cand).toMatchObject({ firstArticleId: first.id, topMemberId: second.id });
  });

  it("skips ingested rows that have no embedding yet", async () => {
    await embedded(0, 0, { embedding: null, embeddingModel: null, embeddingInputVersion: null });
    const result = await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: yes });
    expect(result).toMatchObject({ processed: 0, remaining: 0 });
  });

  it("a late article that fits a closed story joins it, and the story stays closed", async () => {
    await embedded(0, 0);
    await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: yes });
    await db.execute(sql`UPDATE stories SET status = 'closed'`);
    const late = await embedded(30, 0);
    await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: yes });
    const row = await get(late.id);
    const s = await story(row.storyId!);
    expect(s).toMatchObject({ status: "closed", articleCount: 2 });
  });

  it("an earlier-than-anchor article moves the anchor back only when every member still fits", async () => {
    const a = await embedded(0, 0);
    await embedded(20, 0);
    await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: yes });
    const early = await embedded(-10, 0);
    const tooEarly = await embedded(-20, 0);
    await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: yes });
    const s = await story((await get(a.id)).storyId!);
    expect(new Date(s.firstArticleAt).getTime()).toBe(T0 - 10 * H);
    expect(new Date(s.windowEndsAt).getTime()).toBe(T0 - 10 * H + 36 * H);
    expect((await get(early.id)).storyId).toBe(s.id);
    expect((await get(tooEarly.id)).storyId).not.toBe(s.id);
  });

  it("an article embedded late (out of order) still joins the right story", async () => {
    const newer = await embedded(10, 0);
    await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: yes });
    const older = await embedded(8, 3);
    await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: yes });
    expect((await get(older.id)).storyId).toBe((await get(newer.id)).storyId);
  });

  it("uses created_at when a feed gave no published date", async () => {
    const row = await embedded(0, 0, { publishedAt: null });
    await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: yes });
    const s = await story((await get(row.id)).storyId!);
    expect(Math.abs(new Date(s.firstArticleAt).getTime() - Date.now())).toBeLessThan(60_000);
  });

  it("the close sweep closes only expired open stories", async () => {
    await embedded(0, 0); // window ended in 2026-10-02: past relative to now
    const future = new Date(Date.now() + 10 * H);
    await embedded(0, 90, { publishedAt: future });
    const result = await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: yes });
    expect(result.closed).toBe(1);
    const all = await db.select().from(stories);
    expect(all.map((s) => s.status).sort()).toEqual(["closed", "open"]);
  });

  it("backfill mode defers the close sweep until nothing remains", async () => {
    await embedded(0, 0);
    await embedded(1, 90);
    const partial = await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: yes, deferCloseSweep: true, limit: 1 });
    expect(partial).toMatchObject({ processed: 1, remaining: 1, closed: 0 });
    const done = await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: yes, deferCloseSweep: true });
    expect(done).toMatchObject({ remaining: 0, closed: 2 });
  });

  it("stops when the lease is lost, and resuming gives the same result as one run", async () => {
    for (let i = 0; i < 4; i++) await embedded(i, 0);
    const first = await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: yes, afterArticle: async () => false });
    expect(first).toMatchObject({ processed: 1, remaining: 3 });
    await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: yes });
    expect(await db.select().from(stories)).toHaveLength(1);
    expect((await db.select().from(stories))[0].articleCount).toBe(4);
  });

  it("re-running is a no-op", async () => {
    await embedded(0, 0);
    await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: yes });
    const again = await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: yes });
    expect(again).toMatchObject({ processed: 0, remaining: 0 });
    expect(await db.select().from(storyAssignments)).toHaveLength(1);
  });

  describe("failed articles (attempt tracking, like the embed stage)", () => {
    const boom: Adjudicator = async () => {
      throw new Error("classifier 503");
    };
    // `first` reaches no candidate and becomes a story; `second` reaches the classifier.
    async function pair() {
      const first = await embedded(0, 0);
      const second = await embedded(1, 0, { sourceId: "other" });
      return { first, second };
    }

    it("counts the attempt, records the error, backs off 1h, and does not block other articles", async () => {
      const { first, second } = await pair();
      const other = await embedded(2, 90);
      const result = await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: boom });
      expect(result).toMatchObject({ processed: 2, failed: 1, remaining: 0 });
      const row = await get(second.id);
      expect(row).toMatchObject({ clusterAttempts: 1, clusterError: "classifier 503", clusteredAt: null });
      const [{ hours }] = (await db.execute(sql`SELECT extract(epoch FROM cluster_next_attempt_at - now()) / 3600 AS hours FROM feed_items WHERE id = ${second.id}`)) as unknown as { hours: number }[];
      expect(Number(hours)).toBeGreaterThan(0.9);
      expect(Number(hours)).toBeLessThanOrEqual(1);
      expect((await get(first.id)).clusteredAt).not.toBeNull();
      expect((await get(other.id)).clusteredAt).not.toBeNull();
    });

    it("is not retried on the next call while backing off, so a loop on `remaining` terminates", async () => {
      await pair();
      await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: boom });
      const again = await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: boom });
      expect(again).toMatchObject({ processed: 0, failed: 0, remaining: 0 });
    });

    it("is retried once the backoff has passed, and a success clears the error", async () => {
      const { second } = await pair();
      await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: boom });
      await db.execute(sql`UPDATE feed_items SET cluster_next_attempt_at = now() - interval '1 second'`);
      const result = await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: yes });
      expect(result).toMatchObject({ processed: 1, failed: 0, remaining: 0 });
      expect(await get(second.id)).toMatchObject({ clusterError: null, clusterNextAttemptAt: null, clusterAttempts: 1 });
      expect((await get(second.id)).clusteredAt).not.toBeNull();
    });

    it("backs off 2h on the second failure and caps at 12h", async () => {
      const { second } = await pair();
      const hoursAhead = async () =>
        Number(((await db.execute(sql`SELECT extract(epoch FROM cluster_next_attempt_at - now()) / 3600 AS h FROM feed_items WHERE id = ${second.id}`)) as unknown as { h: number }[])[0].h);
      await db.execute(sql`UPDATE feed_items SET cluster_attempts = 1 WHERE id = ${second.id}`);
      await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: boom });
      expect(await hoursAhead()).toBeGreaterThan(1.9);
      await db.execute(sql`UPDATE feed_items SET cluster_attempts = 4, cluster_next_attempt_at = NULL WHERE id = ${second.id}`);
      await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: boom });
      expect(await hoursAhead()).toBeGreaterThan(11.9);
      expect(await hoursAhead()).toBeLessThanOrEqual(12);
    });

    it(`leaves the queue after ${MAX_CLUSTER_ATTEMPTS} attempts`, async () => {
      const { second } = await pair();
      await db.execute(sql`UPDATE feed_items SET cluster_attempts = ${MAX_CLUSTER_ATTEMPTS} WHERE id = ${second.id}`);
      const result = await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: yes });
      expect(result).toMatchObject({ processed: 1, remaining: 0 });
      expect((await get(second.id)).clusteredAt).toBeNull();
    });

    it.each([
      ["an open breaker", new CircuitOpenError("jev")],
      ["a spent quota", new QuotaExhaustedError("daily quota", "gemini")],
    ])("%s stops the run without penalizing the article", async (_, error) => {
      const { second } = await pair();
      const result = await runClusterStage(db, {
        deadline: far(),
        config: cfg36,
        adjudicate: async () => {
          throw error;
        },
      });
      expect(result).toMatchObject({ processed: 1, failed: 0, remaining: 1 });
      expect(await get(second.id)).toMatchObject({ clusterAttempts: 0, clusterError: null, clusterNextAttemptAt: null });
    });
  });

  it("limits work by source and date range", async () => {
    const keep = await embedded(5, 0, { sourceId: "a" });
    await embedded(5, 90, { sourceId: "b" });
    await embedded(50, 45, { sourceId: "a" });
    const result = await runClusterStage(db, {
      deadline: far(),
      source: "a",
      from: new Date(T0),
      to: new Date(T0 + 10 * H),
    });
    expect(result.processed).toBe(1);
    expect((await get(keep.id)).clusteredAt).not.toBeNull();
  });

  it("makes the same decisions as the in-memory store used by the eval harness", async () => {
    const plan: [number, number, string][] = [
      [0, 0, "a"], [1, 20, "b"], [2, 40, "a"], [3, 5, "c"], [30, 2, "b"], [38, 0, "a"],
      [-5, 1, "c"], [60, 90, "a"], [61, 95, "b"], [20, 85, "a"], [4, 33, "b"], [5, 31, "c"],
    ];
    const rows = [];
    for (const [h, deg, src] of plan) rows.push(await embedded(h, deg, { sourceId: src }));
    await runClusterStage(db, { deadline: far(), config: cfg36, adjudicate: yes });

    const mem = createMemoryStore();
    const sorted = [...rows].sort(
      (x, y) => new Date(x.publishedAt!).getTime() - new Date(y.publishedAt!).getTime() || (x.id < y.id ? -1 : 1),
    );
    for (const r of sorted) {
      await assignArticle(
        mem,
        { id: r.id, sourceId: r.sourceId, time: new Date(r.publishedAt!), embedding: r.embedding!, thin: false },
        cfg36,
        yes,
      );
    }
    const dbGroups = new Map<string, string[]>();
    for (const r of rows) {
      const sid = (await get(r.id)).storyId!;
      dbGroups.set(sid, [...(dbGroups.get(sid) ?? []), r.id].sort());
    }
    const memGroups = new Map<string, string[]>();
    for (const a of mem.assignments) memGroups.set(a.storyId, [...(memGroups.get(a.storyId) ?? []), a.articleId].sort());
    // Story ids differ between stores, so compare the partitions.
    const norm = (m: Map<string, string[]>) => [...m.values()].map((g) => g.join(",")).sort();
    expect(norm(dbGroups)).toEqual(norm(memGroups));
    expect(norm(dbGroups).length).toBeLessThan(plan.length); // the scenario really clusters something
  });
});
