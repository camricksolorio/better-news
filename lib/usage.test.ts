import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { llmCalls } from "@/db/schema";
import { connectTestDb, resetTestDb } from "@/tests/test-db";
import { EMBED_QUOTA_FREE } from "./llm-config";
import { embedQuotaCheck, pacificToday, usageByDay } from "./usage";

const { client, db } = connectTestDb();
afterAll(() => client.end());
beforeEach(() => resetTestDb(client));

const base = { purpose: "embed", provider: "gemini", model: "gemini-embedding-2" };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe("usageByDay", () => {
  it("sums inputs, tokens, and cost of successful calls per Pacific day and model", async () => {
    await db.insert(llmCalls).values([
      { ...base, ok: true, inputCount: 25, inputTokens: 6000, costUsd: 0.001 },
      { ...base, ok: true, inputCount: 25, inputTokens: 6000, costUsd: 0.001 },
      { ...base, ok: false, inputCount: 25, error: "boom" },
      { purpose: "adjudicate", provider: "gemini", model: "gemini-3.5-flash-lite", ok: true, inputTokens: 1000, outputTokens: 100, costUsd: 0.0005 },
    ]);
    const rows = await usageByDay(db, 1);
    const emb = rows.find((r) => r.model === "gemini-embedding-2")!;
    expect(emb).toMatchObject({ calls: 3, failedCalls: 1, inputs: 50, inputTokens: 12000, quota429s: 0, dayCapHit: null });
    expect(emb.costUsd).toBeCloseTo(0.002);
    expect(rows.find((r) => r.model === "gemini-3.5-flash-lite")!.calls).toBe(1);
  });

  it("records what had been sent before a per-day 429 (settles requests vs inputs)", async () => {
    await db.insert(llmCalls).values([
      { ...base, ok: true, inputCount: 25, createdAt: minutesAgo(30) },
      { ...base, ok: true, inputCount: 25, createdAt: minutesAgo(20) },
      { ...base, ok: true, inputCount: 25, createdAt: minutesAgo(10) },
      { ...base, ok: false, inputCount: 25, quotaId: "EmbedContentRequestsPerDayPerProjectPerModel-FreeTier", error: "429", createdAt: minutesAgo(5) },
    ]);
    const [emb] = await usageByDay(db, 1);
    expect(emb.quota429s).toBe(1);
    expect(emb.dayCapHit).toEqual({
      quotaId: "EmbedContentRequestsPerDayPerProjectPerModel-FreeTier",
      okCallsBefore: 3,
      okInputsBefore: 75,
    });
  });

  it("does not treat a per-minute 429 as the daily cap", async () => {
    await db.insert(llmCalls).values({ ...base, ok: false, quotaId: "EmbedContentRequestsPerMinutePerUserPerProjectPerModel-FreeTier", error: "429" });
    const [emb] = await usageByDay(db, 1);
    expect(emb.quota429s).toBe(1);
    expect(emb.dayCapHit).toBeNull();
  });
});

describe("embedQuotaCheck", () => {
  const quota = EMBED_QUOTA_FREE; // 1,000 inputs a day

  it("passes with headroom and reports usage", async () => {
    await db.insert(llmCalls).values({ ...base, ok: true, inputCount: 100 });
    const check = await embedQuotaCheck(db, quota);
    expect(check).toMatchObject({ ok: true });
    expect(check.detail).toContain("100/1000");
  });

  it("fails at 80% of the daily cap", async () => {
    await db.insert(llmCalls).values({ ...base, ok: true, inputCount: 800 });
    expect((await embedQuotaCheck(db, quota)).ok).toBe(false);
  });

  it("fails once the daily cap was hit", async () => {
    await db.insert(llmCalls).values([
      { ...base, ok: true, inputCount: 25 },
      { ...base, ok: false, quotaId: "EmbedContentRequestsPerDayPerProjectPerModel-FreeTier", error: "429", createdAt: new Date(Date.now() + 1000) },
    ]);
    const check = await embedQuotaCheck(db, quota);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("daily cap hit after 25 inputs / 1 requests");
  });

  it("passes with no client-side cap on the paid tier", async () => {
    expect((await embedQuotaCheck(db, null)).ok).toBe(true);
  });
});

describe("pacificToday", () => {
  it("uses the Pacific calendar day", () => {
    expect(pacificToday(new Date("2026-10-05T06:59:00Z"))).toBe("2026-10-04"); // 23:59 PDT
    expect(pacificToday(new Date("2026-10-05T07:01:00Z"))).toBe("2026-10-05"); // 00:01 PDT
  });
});
