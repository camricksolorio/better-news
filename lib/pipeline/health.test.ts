import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { feedItems, pipelineRuns, stories } from "@/db/schema";
import { connectTestDb, resetTestDb } from "@/tests/test-db";
import { runHealthChecks } from "./health";

const { client, db } = connectTestDb();
afterAll(() => client.end());
beforeEach(() => resetTestDb(client));

const ago = (h: number) => sql`now() - ${h} * interval '1 hour'`;
let n = 0;
const vec = () => new Array(768).fill(0).map((_, i) => (i === 0 ? 1 : 0));
// Clustered rows need a story and an embedding (database check); unclustered ones need neither.
async function article(o: { ingestedHoursAgo?: number; clustered?: boolean; attempts?: number; clusterAttempts?: number } = {}) {
  const clustered = o.clustered !== false;
  let storyId: string | undefined;
  if (clustered) {
    [{ id: storyId }] = await db.insert(stories).values({ firstArticleAt: new Date(), lastArticleAt: new Date(), windowEndsAt: new Date(), centroid: vec() }).returning({ id: stories.id });
  }
  const [row] = await db
    .insert(feedItems)
    .values({
      sourceId: "src",
      guid: `g${n++}`,
      title: "t",
      link: `https://x.test/${n}`,
      embedAttempts: o.attempts ?? 0,
      clusterAttempts: o.clusterAttempts ?? 0,
      createdAt: ago(o.ingestedHoursAgo ?? 1) as unknown as Date,
      ...(clustered ? { storyId, embedding: vec(), embeddingModel: "gemini-embedding-2", embeddingInputVersion: "v1", clusteredAt: ago(0.5) as unknown as Date } : {}),
    })
    .returning();
  return row;
}
async function run(stage: "embed" | "cluster", o: { hoursAgo?: number; error?: string; unfinished?: boolean } = {}) {
  await db.insert(pipelineRuns).values({ stage, startedAt: ago((o.hoursAgo ?? 1) + 0.01) as unknown as Date, finishedAt: o.unfinished ? null : (ago(o.hoursAgo ?? 1) as unknown as Date), error: o.error ?? null });
}
// A healthy baseline; each test then breaks exactly one thing.
async function healthy() {
  await article({ ingestedHoursAgo: 1 });
  await run("embed");
  await run("cluster");
}
const check = async (name: string) => (await runHealthChecks(db)).checks.find((c) => c.name === name)!;

describe("runHealthChecks", () => {
  it("is ok when everything is fresh", async () => {
    await healthy();
    const h = await runHealthChecks(db);
    expect(h.ok).toBe(true);
    expect(h.checks.map((c) => c.name)).toEqual(["ingest_freshness", "embed_freshness", "cluster_freshness", "backlog", "stuck_rows"]);
    expect(h.checks.every((c) => c.ok)).toBe(true);
  });

  it("an empty database fails the freshness checks and passes backlog and stuck rows", async () => {
    const h = await runHealthChecks(db);
    expect(h.ok).toBe(false);
    expect(h.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["ingest_freshness", "embed_freshness", "cluster_freshness"]);
  });

  it("ingest freshness fails alone when the newest article is 12h old", async () => {
    await healthy();
    await db.execute(sql`UPDATE feed_items SET created_at = now() - interval '13 hours'`);
    const h = await runHealthChecks(db);
    expect(h.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["ingest_freshness"]);
  });

  it("embed freshness fails alone when the last successful embed run is old", async () => {
    await article();
    await run("embed", { hoursAgo: 13 });
    await run("cluster");
    expect((await runHealthChecks(db)).checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["embed_freshness"]);
  });

  it("cluster freshness fails alone when the last successful cluster run is old", async () => {
    await article();
    await run("embed");
    await run("cluster", { hoursAgo: 13 });
    expect((await runHealthChecks(db)).checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["cluster_freshness"]);
  });

  it("a recent failed or unfinished run does not count as fresh", async () => {
    await article();
    await run("embed");
    await run("cluster", { hoursAgo: 13 });
    await run("cluster", { hoursAgo: 0.1, error: "boom" });
    await run("cluster", { hoursAgo: 0.1, unfinished: true });
    expect((await check("cluster_freshness")).ok).toBe(false);
  });

  it("backlog fails alone when an unclustered article is 12h old, and passes when it is younger", async () => {
    await healthy();
    await article({ ingestedHoursAgo: 11, clustered: false });
    expect((await check("backlog")).ok).toBe(true);
    await article({ ingestedHoursAgo: 13, clustered: false });
    expect((await runHealthChecks(db)).checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["backlog"]);
  });

  it("stuck rows fail alone, and are not also counted as backlog", async () => {
    await healthy();
    await article({ ingestedHoursAgo: 20, clustered: false, attempts: 5 });
    const h = await runHealthChecks(db);
    expect(h.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["stuck_rows"]);
    expect((await check("stuck_rows")).detail).toContain("1 rows");
  });

  it("rows out of cluster attempts also fail stuck rows alone, and are not counted as backlog", async () => {
    await healthy();
    await article({ ingestedHoursAgo: 20, clustered: false, clusterAttempts: 5 });
    const h = await runHealthChecks(db);
    expect(h.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["stuck_rows"]);
    expect((await check("stuck_rows")).detail).toBe("0 rows out of embed attempts, 1 out of cluster attempts");
  });
});
