import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { llmCalls } from "@/db/schema";
import { connectTestDb, resetTestDb } from "@/tests/test-db";
import { CircuitOpenError, DeadlineError, LlmError, createLlmClient } from "./llm";

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
function harness(responses: (() => Response | Promise<Response>)[], opts: { deadline?: number; random?: number } = {}) {
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
  });
  return { llm, fetchMock, sleeps, advance: (ms: number) => (time += ms) };
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
