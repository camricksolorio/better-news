import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { llmCalls } from "@/db/schema";
import { connectTestDb, resetTestDb } from "@/tests/test-db";
import { CircuitOpenError, DeadlineError, LlmError, QuotaExhaustedError, createLlmClient, parseQuotaFailure } from "./llm";
import type { EmbedQuota } from "./llm-config";

const { client, db } = connectTestDb();
afterAll(() => client.end());
beforeEach(() => resetTestDb(client));

const vec = () => Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const embedOk = (n: number, tokens = 1000) =>
  json({ data: Array.from({ length: n }, (_, index) => ({ index, embedding: vec() })), usage: { prompt_tokens: tokens } });
const chatOk = (content: string) =>
  json({ choices: [{ message: { content } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } });

// A fake clock: sleeping advances it, so deadline math is deterministic.
function harness(
  responses: (() => Response | Promise<Response>)[],
  opts: { deadline?: number; random?: number; embedQuota?: EmbedQuota | null } = {},
) {
  let time = 1_000_000;
  const sleeps: number[] = [];
  const fetchMock = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra fetch");
    return next();
  });
  const llm = createLlmClient({
    db,
    keys: { gemini: "g", openrouter: "o" },
    fetch: fetchMock as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
    now: () => time,
    random: () => opts.random ?? 0.5,
    deadline: opts.deadline,
    embedQuota: opts.embedQuota,
  });
  return { llm, fetchMock, sleeps, advance: (ms: number) => (time += ms), time: () => time };
}

describe("embed", () => {
  it("returns vectors and records a call with cost from the price table", async () => {
    const { llm, fetchMock } = harness([() => embedOk(2, 1_000_000)]);
    const { vectors } = await llm.embed({ inputs: ["a", "b"] });
    expect(vectors).toHaveLength(2);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ model: "gemini-embedding-2", dimensions: 768, input: ["a", "b"] });
    const [row] = await db.select().from(llmCalls);
    expect(row).toMatchObject({ provider: "gemini", model: "gemini-embedding-2", ok: true, inputTokens: 1_000_000 });
    expect(row.costUsd).toBeCloseTo(0.2);
  });

  it("rejects more than 100 inputs per request", async () => {
    const { llm } = harness([]);
    await expect(llm.embed({ inputs: Array(101).fill("x") })).rejects.toThrow(/at most 100/);
  });

  it("does not retry non-retryable errors", async () => {
    const { llm, fetchMock } = harness([() => json({ error: "bad" }, 400)]);
    await expect(llm.embed({ inputs: ["a"] })).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a wrong vector count or dimension as a non-retryable error", async () => {
    const { llm, fetchMock } = harness([() => embedOk(1)]);
    await expect(llm.embed({ inputs: ["a", "b"] })).rejects.toThrow(/expected 2/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries 429 with exponential backoff and jitter within bounds, then succeeds", async () => {
    for (const random of [0, 0.5, 0.999]) {
      const { llm, sleeps } = harness(
        [() => json({}, 429), () => json({}, 503), () => json({}, 500), () => embedOk(1)],
        { random },
      );
      await llm.embed({ inputs: ["a"] });
      expect(sleeps).toHaveLength(3);
      sleeps.forEach((ms, attempt) => {
        const base = 1000 * 2 ** attempt;
        expect(ms).toBeGreaterThanOrEqual(base * 0.5);
        expect(ms).toBeLessThanOrEqual(base * 1.5);
      });
    }
  });

  it("gives up after 4 attempts and records the failed call", async () => {
    const { llm, fetchMock } = harness(Array.from({ length: 4 }, () => () => json({}, 429)));
    await expect(llm.embed({ inputs: ["a"] })).rejects.toBeInstanceOf(LlmError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [row] = await db.select().from(llmCalls);
    expect(row.ok).toBe(false);
    expect(row.error).toMatch(/429/);
  });

  it("honors Retry-After when it exceeds the backoff", async () => {
    const { llm, sleeps } = harness([() => json({}, 429, { "retry-after": "7" }), () => embedOk(1)], { random: 0 });
    await llm.embed({ inputs: ["a"] });
    expect(sleeps).toEqual([7000]);
  });

  it("opens the breaker after 3 consecutive failed calls, then fails fast", async () => {
    const failing = () => json({}, 500);
    const { llm, fetchMock } = harness(Array.from({ length: 12 }, () => failing), { random: 0 });
    for (let i = 0; i < 3; i++) await expect(llm.embed({ inputs: ["a"] })).rejects.toBeInstanceOf(LlmError);
    expect(fetchMock).toHaveBeenCalledTimes(12);
    expect(llm.isBreakerOpen("gemini")).toBe(true);
    await expect(llm.embed({ inputs: ["a"] })).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fetchMock).toHaveBeenCalledTimes(12);
  });

  it("a success resets the failure count", async () => {
    const fail = () => json({}, 500);
    const { llm } = harness(
      [...Array(4).fill(fail), ...Array(4).fill(fail), () => embedOk(1), ...Array(4).fill(fail), ...Array(4).fill(fail)],
      { random: 0 },
    );
    await expect(llm.embed({ inputs: ["a"] })).rejects.toThrow();
    await expect(llm.embed({ inputs: ["a"] })).rejects.toThrow();
    await llm.embed({ inputs: ["a"] });
    await expect(llm.embed({ inputs: ["a"] })).rejects.toThrow(LlmError);
    await expect(llm.embed({ inputs: ["a"] })).rejects.toThrow(LlmError);
    expect(llm.isBreakerOpen("gemini")).toBe(false);
  });

  it("starts no attempt after the deadline", async () => {
    const { llm, fetchMock } = harness([() => embedOk(1)], { deadline: 1_000_000 });
    await expect(llm.embed({ inputs: ["a"] })).rejects.toBeInstanceOf(DeadlineError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops retrying when the next backoff would pass the deadline", async () => {
    const { llm, fetchMock, sleeps } = harness(
      [() => json({}, 500), () => json({}, 500), () => embedOk(1)],
      { deadline: 1_000_000 + 1500, random: 0.5 },
    );
    await expect(llm.embed({ inputs: ["a"] })).rejects.toBeInstanceOf(LlmError);
    // 1s backoff fits (1000 < 1500), the next 2s one does not.
    expect(sleeps).toEqual([1000]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a deadline stop does not count toward the breaker", async () => {
    const { llm } = harness([], { deadline: 1_000_000 });
    for (let i = 0; i < 5; i++) await expect(llm.embed({ inputs: ["a"] })).rejects.toBeInstanceOf(DeadlineError);
    expect(llm.isBreakerOpen("gemini")).toBe(false);
  });
});

const schema = { name: "verdict", schema: { type: "object" } };
const chatArgs = { model: "gemini-3.5-flash-lite", messages: [{ role: "user" as const, content: "hi" }], purpose: "adjudicate" };

describe("chat", () => {
  it("returns parsed JSON and records tokens and cost", async () => {
    const { llm } = harness([() => chatOk('{"relation":"same"}')]);
    const out = await llm.chat({ ...chatArgs, jsonSchema: schema });
    expect(out).toMatchObject({ json: { relation: "same" }, provider: "gemini", cached: false });
    const [row] = await db.select().from(llmCalls);
    expect(row.costUsd).toBeCloseTo((1000 * 0.3 + 100 * 2.5) / 1_000_000);
  });

  it("returns json null for invalid JSON", async () => {
    const { llm } = harness([() => chatOk("not json")]);
    const out = await llm.chat({ ...chatArgs, jsonSchema: schema });
    expect(out.json).toBeNull();
  });

  it("falls back to OpenRouter after Gemini fails and logs both calls", async () => {
    const { llm } = harness([...Array(4).fill(() => json({}, 429)), () => chatOk("{}")], { random: 0 });
    const out = await llm.chat({ ...chatArgs, jsonSchema: schema });
    expect(out.provider).toBe("openrouter");
    const rows = await db.select().from(llmCalls);
    expect(rows.map((r) => [r.provider, r.ok]).sort()).toEqual([
      ["gemini", false],
      ["openrouter", true],
    ]);
  });

  it("skips Gemini once its breaker is open and goes straight to OpenRouter", async () => {
    const calls: string[] = [];
    const llm = createLlmClient({
      db,
      keys: { gemini: "g", openrouter: "o" },
      fetch: (async (url: string) => {
        calls.push(url);
        return url.includes("openrouter.ai") ? chatOk("{}") : json({}, 500);
      }) as unknown as typeof fetch,
      sleep: async () => {},
      random: () => 0,
    });
    for (let i = 0; i < 3; i++) await llm.chat({ ...chatArgs });
    expect(llm.isBreakerOpen("gemini")).toBe(true);
    const geminiCalls = calls.filter((u) => u.includes("generativelanguage")).length;
    expect(geminiCalls).toBe(12);
    const out = await llm.chat({ ...chatArgs });
    expect(out.provider).toBe("openrouter");
    expect(calls.filter((u) => u.includes("generativelanguage")).length).toBe(12);
  });

  it("throws when both providers fail", async () => {
    const { llm } = harness(Array.from({ length: 8 }, () => () => json({}, 500)), { random: 0 });
    await expect(llm.chat({ ...chatArgs })).rejects.toBeInstanceOf(LlmError);
  });

  it("provider openrouter goes only to OpenRouter with the given model, never Gemini", async () => {
    const calls: { url: string; model: string }[] = [];
    const llm = createLlmClient({
      db,
      keys: { gemini: "g", openrouter: "o" },
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, model: JSON.parse(init.body as string).model });
        return chatOk("{}");
      }) as unknown as typeof fetch,
      sleep: async () => {},
    });
    const out = await llm.chat({ ...chatArgs, provider: "openrouter", model: "anthropic/claude-sonnet-5.5" });
    expect(out).toMatchObject({ provider: "openrouter", model: "anthropic/claude-sonnet-5.5" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("openrouter.ai");
  });

  it("an OpenRouter-only call does not fall back to Gemini when it fails", async () => {
    const calls: string[] = [];
    const llm = createLlmClient({
      db,
      keys: { gemini: "g", openrouter: "o" },
      fetch: (async (url: string) => {
        calls.push(url);
        return json({}, 400);
      }) as unknown as typeof fetch,
      sleep: async () => {},
    });
    await expect(llm.chat({ ...chatArgs, provider: "openrouter", model: "x/y" })).rejects.toBeInstanceOf(LlmError);
    expect(calls.every((u) => u.includes("openrouter.ai"))).toBe(true);
  });

  it("a cache hit makes no call and writes no row", async () => {
    const { llm, fetchMock } = harness([() => chatOk('{"relation":"same"}')]);
    await llm.chat({ ...chatArgs, jsonSchema: schema, cacheKey: "k1" });
    const again = await llm.chat({ ...chatArgs, jsonSchema: schema, cacheKey: "k1" });
    expect(again).toMatchObject({ cached: true, json: { relation: "same" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await db.select().from(llmCalls)).toHaveLength(1);
  });

  it("different cache keys do not share a verdict", async () => {
    const { llm, fetchMock } = harness([() => chatOk("{}"), () => chatOk("{}")]);
    await llm.chat({ ...chatArgs, cacheKey: "a" });
    await llm.chat({ ...chatArgs, cacheKey: "b" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// The body Gemini returned in the 2026-10-05 probe (trimmed): the per-minute request quota.
const minuteBody = {
  error: {
    code: 429,
    message: "You exceeded your current quota.",
    status: "RESOURCE_EXHAUSTED",
    details: [
      { "@type": "type.googleapis.com/google.rpc.Help", links: [] },
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [
          {
            quotaMetric: "generativelanguage.googleapis.com/embed_content_free_tier_requests",
            quotaId: "EmbedContentRequestsPerMinutePerUserPerProjectPerModel-FreeTier",
            quotaValue: "100",
          },
        ],
      },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "55s" },
    ],
  },
};
const dayBody = {
  error: {
    ...minuteBody.error,
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [
          {
            quotaMetric: "generativelanguage.googleapis.com/embed_content_free_tier_requests",
            quotaId: "EmbedContentRequestsPerDayPerProjectPerModel-FreeTier",
            quotaValue: "1000",
          },
        ],
      },
    ],
  },
};

describe("quota errors", () => {
  it("parses the quota id, scope, and retry delay from a 429 body", () => {
    expect(parseQuotaFailure(JSON.stringify(minuteBody))).toEqual({
      quota: {
        id: "EmbedContentRequestsPerMinutePerUserPerProjectPerModel-FreeTier",
        metric: "generativelanguage.googleapis.com/embed_content_free_tier_requests",
        scope: "minute",
      },
      retryDelayMs: 55_000,
    });
    expect(parseQuotaFailure(JSON.stringify(dayBody)).quota?.scope).toBe("day");
    expect(parseQuotaFailure("not json")).toEqual({});
  });

  it("a per-minute 429 waits the server's retry delay, then succeeds", async () => {
    const { llm, sleeps } = harness([() => json(minuteBody, 429), () => embedOk(1)], { random: 0, embedQuota: null });
    await llm.embed({ inputs: ["a"] });
    expect(sleeps).toEqual([55_000]);
  });

  it("a per-day 429 is not retried, does not open the breaker, and records the quota id", async () => {
    const { llm, fetchMock } = harness([() => json(dayBody, 429)], { embedQuota: null });
    await expect(llm.embed({ inputs: ["a", "b"] })).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(llm.isBreakerOpen("gemini")).toBe(false);
    const [row] = await db.select().from(llmCalls);
    expect(row).toMatchObject({ ok: false, inputCount: 2, quotaId: "EmbedContentRequestsPerDayPerProjectPerModel-FreeTier" });
  });

  it("after a per-day 429, later embeds in the run fail fast without a request", async () => {
    const { llm, fetchMock } = harness([() => json(dayBody, 429)], { embedQuota: null });
    await expect(llm.embed({ inputs: ["a"] })).rejects.toBeInstanceOf(QuotaExhaustedError);
    await expect(llm.embed({ inputs: ["a"] })).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("chat falls back to OpenRouter when Gemini's daily quota is spent", async () => {
    const calls: string[] = [];
    const llm = createLlmClient({
      db,
      keys: { gemini: "g", openrouter: "o" },
      fetch: (async (url: string) => {
        calls.push(url);
        return url.includes("openrouter.ai") ? chatOk("{}") : json(dayBody, 429);
      }) as unknown as typeof fetch,
      sleep: async () => {},
    });
    const out = await llm.chat({ model: "gemini-3.5-flash-lite", messages: [{ role: "user", content: "hi" }], purpose: "adjudicate" });
    expect(out.provider).toBe("openrouter");
  });
});

describe("embedding pacing", () => {
  const quota: EmbedQuota = { perMinuteInputs: 100, perMinuteTokens: 30_000, perDayInputs: 1_000, margin: 0.9 };
  const batch = (n: number) => Array.from({ length: n }, (_, i) => `article ${i}`);

  it("never sends more than 90 inputs in any 60s window", async () => {
    const sends: { at: number; n: number }[] = [];
    const h = harness(
      Array.from({ length: 8 }, () => () => embedOk(25)),
      { embedQuota: quota },
    );
    h.fetchMock.mockImplementation((async () => {
      sends.push({ at: h.time(), n: 25 });
      return embedOk(25);
    }) as never);
    for (let i = 0; i < 8; i++) await h.llm.embed({ inputs: batch(25) });
    for (const s of sends) {
      const inWindow = sends.filter((x) => x.at > s.at - 60_000 && x.at <= s.at).reduce((n, x) => n + x.n, 0);
      expect(inWindow).toBeLessThanOrEqual(90);
    }
    // 3 batches fit per minute: 8 batches need at least two full waits.
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(120_000);
  });

  it("does not wait while under the limit", async () => {
    const h = harness([() => embedOk(25), () => embedOk(25), () => embedOk(25)], { embedQuota: quota });
    for (let i = 0; i < 3; i++) await h.llm.embed({ inputs: batch(25) });
    expect(h.sleeps).toEqual([]);
  });

  it("also paces on tokens (estimated at ~4 chars per token)", async () => {
    const big = Array.from({ length: 4 }, () => "x".repeat(30_000)); // ~7.5k tokens per input
    const h = harness([() => embedOk(1, 7500), () => embedOk(1, 7500), () => embedOk(1, 7500)], { embedQuota: quota });
    await h.llm.embed({ inputs: [big[0]] });
    await h.llm.embed({ inputs: [big[1]] });
    await h.llm.embed({ inputs: [big[2]] }); // 3 x 7.5k = 22.5k fits under 27k
    expect(h.sleeps).toEqual([]);
    const h2 = harness(Array.from({ length: 4 }, () => () => embedOk(1, 7500)), { embedQuota: quota });
    for (const text of big) await h2.llm.embed({ inputs: [text] }); // the 4th (30k total) must wait
    expect(h2.sleeps.length).toBeGreaterThan(0);
  });

  it("shares the budget with earlier runs through llm_calls", async () => {
    await db.insert(llmCalls).values({
      purpose: "embed", provider: "gemini", model: "gemini-embedding-2", ok: true, inputCount: 90, inputTokens: 5000,
      createdAt: new Date(Date.now() - 5_000),
    });
    const h = harness([() => embedOk(25)], { embedQuota: quota });
    await h.llm.embed({ inputs: batch(25) });
    // ~55s left on the earlier run's window
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThan(50_000);
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(60_000);
  });

  it("is off when no quota is configured (paid tier)", async () => {
    const h = harness(Array.from({ length: 6 }, () => () => embedOk(25)), { embedQuota: null });
    for (let i = 0; i < 6; i++) await h.llm.embed({ inputs: batch(25) });
    expect(h.sleeps).toEqual([]);
  });

  it("gives up with a deadline error instead of waiting past the deadline", async () => {
    const h = harness(Array.from({ length: 4 }, () => () => embedOk(25)), { embedQuota: quota, deadline: 1_000_000 + 30_000 });
    for (let i = 0; i < 3; i++) await h.llm.embed({ inputs: batch(25) });
    await expect(h.llm.embed({ inputs: batch(25) })).rejects.toBeInstanceOf(DeadlineError);
    expect(h.fetchMock).toHaveBeenCalledTimes(3);
  });

  it("counts a rejected 429 against the window so the next call backs off", async () => {
    const h = harness([() => json(minuteBody, 429), () => embedOk(25), () => embedOk(25)], { embedQuota: quota, random: 0 });
    await h.llm.embed({ inputs: batch(25) }); // 429, waits 55s, retries OK
    expect(h.sleeps[0]).toBe(55_000);
  });
});
