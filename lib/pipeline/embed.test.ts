import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { feedItems } from "@/db/schema";
import { connectTestDb, resetTestDb } from "@/tests/test-db";
import { CircuitOpenError, LlmError, QuotaExhaustedError } from "@/lib/llm";
import { runEmbedStage } from "./embed";

const { client, db } = connectTestDb();
afterAll(() => client.end());
beforeEach(() => resetTestDb(client));

const vec = (x: number) => Array.from({ length: 768 }, (_, i) => (i === 0 ? x : 0));
const far = () => Date.now() + 60_000;

let n = 0;
async function ingest(over: Partial<typeof feedItems.$inferInsert> = {}) {
  const [row] = await db
    .insert(feedItems)
    .values({
      sourceId: "src",
      guid: `g${n++}`,
      title: `Title ${n}`,
      link: `https://www.example.com/a/${n}?utm_source=rss`,
      summary: "<p>Some summary</p>",
      publishedAt: new Date(Date.UTC(2026, 9, 1, 0, n)),
      ...over,
    })
    .returning();
  return row;
}

const get = async (id: string) => (await db.select().from(feedItems).where(eq(feedItems.id, id)))[0];

const okLlm = () => ({
  embed: vi.fn(async ({ inputs }: { inputs: string[] }) => ({ vectors: inputs.map((_, i) => vec(i + 1)) })),
});

describe("runEmbedStage", () => {
  it("writes embedding, model, and input version for a successful batch", async () => {
    const a = await ingest();
    const b = await ingest();
    const llm = okLlm();
    const result = await runEmbedStage(db, llm, { deadline: far() });
    expect(result).toEqual({ processed: 2, remaining: 0, failed: 0 });
    for (const id of [a.id, b.id]) {
      const row = await get(id);
      expect(row.embedding).toHaveLength(768);
      expect(row.embeddingModel).toBe("gemini-embedding-2");
      expect(row.embeddingInputVersion).toBe("v1");
      expect(row.clusteredAt).toBeNull();
    }
    expect((await get(a.id)).canonicalLink).toBe("example.com/a/" + (n - 1));
    const inputs = llm.embed.mock.calls[0][0].inputs;
    expect(inputs[0]).toBe("task: clustering | query: " + a.title + "\n\nSome summary");
  });

  it("embeds in batches of the given size, oldest first", async () => {
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push(await ingest());
    const llm = okLlm();
    await runEmbedStage(db, llm, { deadline: far(), batchSize: 2 });
    expect(llm.embed.mock.calls.map((c) => c[0].inputs.length)).toEqual([2, 2, 1]);
    expect(llm.embed.mock.calls[0][0].inputs[0]).toContain(rows[0].title);
  });

  it("a failing batch increments attempts, records the error and backoff, without affecting other batches", async () => {
    await ingest(); // oldest: fails
    await ingest();
    const good = await ingest({ publishedAt: new Date(Date.UTC(2026, 9, 2)) });
    let call = 0;
    const llm = {
      embed: vi.fn(async ({ inputs }: { inputs: string[] }) => {
        if (call++ === 0) throw new LlmError("gemini 429: slow down", "gemini", true, 429);
        return { vectors: inputs.map(() => vec(1)) };
      }),
    };
    const result = await runEmbedStage(db, llm, { deadline: far(), batchSize: 2 });
    expect(result).toMatchObject({ processed: 1, failed: 2, remaining: 0 });
    const failedRows = await db.select().from(feedItems).where(sql`embedding IS NULL`);
    expect(failedRows).toHaveLength(2);
    for (const row of failedRows) {
      expect(row.embedAttempts).toBe(1);
      expect(row.embedError).toMatch(/429/);
      const hours = (row.embedNextAttemptAt!.getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(0.9);
      expect(hours).toBeLessThanOrEqual(1.01);
    }
    expect((await get(good.id)).embedding).not.toBeNull();
  });

  it("backs off 2h on the second failure and caps at 12h", async () => {
    const row = await ingest({ embedAttempts: 1 });
    const capped = await ingest({ embedAttempts: 4 });
    const llm = { embed: vi.fn(async () => { throw new LlmError("500", "gemini", true, 500); }) };
    await runEmbedStage(db, llm, { deadline: far() });
    const hoursFor = async (id: string) => ((await get(id)).embedNextAttemptAt!.getTime() - Date.now()) / 3_600_000;
    expect(await hoursFor(row.id)).toBeGreaterThan(1.9);
    expect(await hoursFor(row.id)).toBeLessThanOrEqual(2.01);
    // attempts 4 -> would be 16h, capped at 12h; it reaches 5 attempts and drops out of the queue
    expect(await hoursFor(capped.id)).toBeLessThanOrEqual(12.01);
    expect(await hoursFor(capped.id)).toBeGreaterThan(11.9);
    expect((await get(capped.id)).embedAttempts).toBe(5);
  });

  it("does not select a row with 5 attempts or a future next attempt", async () => {
    await ingest({ embedAttempts: 5 });
    await ingest({ embedNextAttemptAt: new Date(Date.now() + 3_600_000) });
    const llm = okLlm();
    const result = await runEmbedStage(db, llm, { deadline: far() });
    expect(llm.embed).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 0, remaining: 0, failed: 0 });
  });

  it("selects a row whose next attempt has passed", async () => {
    await ingest({ embedAttempts: 2, embedNextAttemptAt: new Date(Date.now() - 1000) });
    const result = await runEmbedStage(db, okLlm(), { deadline: far() });
    expect(result.processed).toBe(1);
  });

  it("re-running is a no-op", async () => {
    await ingest();
    await runEmbedStage(db, okLlm(), { deadline: far() });
    const llm = okLlm();
    const result = await runEmbedStage(db, llm, { deadline: far() });
    expect(llm.embed).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 0, remaining: 0, failed: 0 });
  });

  it("ends the run early when the breaker opens, leaving rows unprocessed and unpenalized", async () => {
    for (let i = 0; i < 4; i++) await ingest();
    let call = 0;
    const llm = {
      embed: vi.fn(async () => {
        if (call++ === 0) throw new LlmError("500", "gemini", true, 500);
        throw new CircuitOpenError("gemini");
      }),
    };
    const result = await runEmbedStage(db, llm, { deadline: far(), batchSize: 1 });
    expect(llm.embed).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ processed: 0, failed: 1, remaining: 3 });
    const untouched = await db.select().from(feedItems).where(sql`embed_attempts = 0 AND embedding IS NULL`);
    expect(untouched).toHaveLength(3);
  });

  it("ends the run cleanly when the daily quota is spent, leaving rows unpenalized", async () => {
    for (let i = 0; i < 3; i++) await ingest();
    const llm = { embed: vi.fn(async () => { throw new QuotaExhaustedError("daily quota", "gemini", 429); }) };
    const result = await runEmbedStage(db, llm, { deadline: far(), batchSize: 1 });
    expect(llm.embed).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ processed: 0, failed: 0, remaining: 3 });
    expect(await db.select().from(feedItems).where(sql`embed_attempts > 0`)).toHaveLength(0);
  });

  it("starts no new batch after the deadline", async () => {
    await ingest();
    const llm = okLlm();
    const result = await runEmbedStage(db, llm, { deadline: Date.now() - 1 });
    expect(llm.embed).not.toHaveBeenCalled();
    expect(result).toMatchObject({ processed: 0, remaining: 1 });
  });

  it("stops when the lease is lost", async () => {
    for (let i = 0; i < 3; i++) await ingest();
    const llm = okLlm();
    const result = await runEmbedStage(db, llm, { deadline: far(), batchSize: 1, afterBatch: async () => false });
    expect(llm.embed).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ processed: 1, remaining: 2 });
  });

  it("limits work by source and date range", async () => {
    const keep = await ingest({ sourceId: "a", publishedAt: new Date("2026-10-02T12:00:00Z") });
    await ingest({ sourceId: "b", publishedAt: new Date("2026-10-02T12:00:00Z") });
    await ingest({ sourceId: "a", publishedAt: new Date("2026-10-05T12:00:00Z") });
    const result = await runEmbedStage(db, okLlm(), {
      deadline: far(),
      source: "a",
      from: new Date("2026-10-02T00:00:00Z"),
      to: new Date("2026-10-03T00:00:00Z"),
    });
    expect(result.processed).toBe(1);
    expect((await get(keep.id)).embedding).not.toBeNull();
  });

  it("honors a per-call row limit", async () => {
    for (let i = 0; i < 5; i++) await ingest();
    const result = await runEmbedStage(db, okLlm(), { deadline: far(), batchSize: 2, limit: 3 });
    expect(result).toMatchObject({ processed: 3, remaining: 2 });
  });
});
