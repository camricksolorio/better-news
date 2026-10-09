import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { feedItems, llmCalls, pipelineRuns, stories } from "@/db/schema";
import { connectTestDb, resetTestDb } from "@/tests/test-db";
import { DAILY_BUDGET_USD, costsByDay, loadPipelineStatus } from "./admin-pipeline";

const { client, db } = connectTestDb();
afterAll(() => client.end());
beforeEach(() => resetTestDb(client));

const ago = (h: number) => sql`now() - ${h} * interval '1 hour'` as unknown as Date;
const call = (o: Partial<typeof llmCalls.$inferInsert> & { hoursAgo?: number } = {}) => {
  const { hoursAgo = 1, ...rest } = o;
  return db.insert(llmCalls).values({ purpose: "adjudicate", provider: "jev", model: "jev-1.13.0", ok: true, costUsd: 0.01, inputTokens: 600, outputTokens: 0, createdAt: ago(hoursAgo), ...rest });
};

describe("costsByDay", () => {
  it("groups by day, purpose and model with calls, failures, tokens and cost", async () => {
    await call({ costUsd: 0.01 });
    await call({ costUsd: 0.02, ok: false });
    await call({ purpose: "embed", provider: "gemini", model: "gemini-embedding-2", costUsd: 0.05, inputTokens: 1000 });
    const { rows } = await costsByDay(db);
    expect(rows).toHaveLength(2);
    const adj = rows.find((r) => r.purpose === "adjudicate")!;
    expect(adj).toMatchObject({ model: "jev-1.13.0", calls: 2, failedCalls: 1, inputTokens: 1200 });
    expect(adj.costUsd).toBeCloseTo(0.03, 6);
    // Most expensive first within a day.
    expect(rows[0].purpose).toBe("embed");
  });

  it("totals each day and flags days over the budget", async () => {
    await call({ costUsd: DAILY_BUDGET_USD + 0.1, hoursAgo: 1 });
    await call({ costUsd: 0.1, hoursAgo: 49 });
    const { days } = await costsByDay(db);
    expect(days.map((d) => d.overBudget).sort()).toEqual([false, true]);
  });

  it("leaves out calls older than the window", async () => {
    await call({ hoursAgo: 24 * 30 });
    expect((await costsByDay(db, 14)).rows).toHaveLength(0);
  });
});

describe("loadPipelineStatus", () => {
  it("reports the latest run per stage with its status", async () => {
    await db.insert(pipelineRuns).values([
      { stage: "embed", startedAt: ago(5), finishedAt: ago(5), processed: 10, remaining: 0, failed: 0 },
      { stage: "embed", startedAt: ago(1), finishedAt: ago(1), processed: 4, remaining: 2, failed: 1, error: "boom" },
      { stage: "cluster", startedAt: ago(0.5), finishedAt: null },
    ]);
    const { stages } = await loadPipelineStatus(db);
    expect(stages.find((s) => s.stage === "embed")).toMatchObject({ status: "failed", processed: 4, failed: 1, error: "boom" });
    expect(stages.find((s) => s.stage === "cluster")).toMatchObject({ status: "running", finishedAt: null });
  });

  it("counts rows by state, stuck rows, open stories, and the oldest unprocessed article", async () => {
    const vec = new Array(768).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    const [s] = await db.insert(stories).values({ firstArticleAt: new Date(), lastArticleAt: new Date(), windowEndsAt: new Date(), centroid: vec }).returning();
    await db.insert(stories).values({ firstArticleAt: new Date(), lastArticleAt: new Date(), windowEndsAt: new Date(), centroid: vec, status: "closed" });
    const base = { sourceId: "src", title: "t" };
    const embedded = { embedding: vec, embeddingModel: "m", embeddingInputVersion: "v" };
    await db.insert(feedItems).values([
      { ...base, guid: "a", link: "https://x/a", createdAt: ago(30) }, // needs embedding, the oldest unprocessed
      { ...base, guid: "b", link: "https://x/b", createdAt: ago(2), embedAttempts: 5 }, // stuck in embed
      { ...base, guid: "c", link: "https://x/c", createdAt: ago(3), ...embedded }, // awaiting cluster
      { ...base, guid: "d", link: "https://x/d", createdAt: ago(3), ...embedded, clusterAttempts: 5 }, // stuck in cluster
      { ...base, guid: "e", link: "https://x/e", createdAt: ago(40), ...embedded, storyId: s.id, clusteredAt: ago(39) }, // done, so not "unprocessed"
    ]);
    const status = await loadPipelineStatus(db);
    expect(status.counts).toEqual({ needsEmbedding: 2, awaitingCluster: 2, clustered: 1 });
    expect(status.stuck).toEqual({ embed: 1, cluster: 1 });
    expect(status.openStories).toBe(1);
    expect(status.oldestUnprocessedHours).toBeGreaterThan(29.9);
    expect(status.oldestUnprocessedHours).toBeLessThan(30.1);
  });

  it("counts failed, rate-limited and fallback calls from the last 24 hours only", async () => {
    await call();
    await call({ ok: false });
    await call({ ok: false, quotaId: "GenerateRequestsPerMinute" });
    await call({ ok: false, error: "HTTP 429 too many requests" });
    await call({ provider: "openrouter", model: "google/gemini-3.5-flash-lite" });
    await call({ ok: false, quotaId: "GenerateRequestsPerMinute", hoursAgo: 30 });
    const { last24h } = await loadPipelineStatus(db);
    expect(last24h).toEqual({ calls: 5, failed: 3, rateLimited: 2, fallback: 1 });
  });

  it("carries the same checks as /api/health", async () => {
    const { health } = await loadPipelineStatus(db);
    expect(health.checks.map((c) => c.name)).toEqual(["ingest_freshness", "embed_freshness", "cluster_freshness", "backlog", "stuck_rows"]);
  });

  it("handles an empty database", async () => {
    const s = await loadPipelineStatus(db);
    expect(s).toMatchObject({ stages: [], counts: { needsEmbedding: 0, awaitingCluster: 0, clustered: 0 }, oldestUnprocessedHours: null, openStories: 0, last24h: { calls: 0 } });
  });
});
