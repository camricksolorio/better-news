// Thin fetch client for Gemini and OpenRouter (both OpenAI-compatible), no SDK (D13).
// One client instance is one pipeline run: its circuit breakers start closed and its
// deadline bounds every retry (D23). Every call is recorded in llm_calls.
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { llmCalls } from "@/db/schema";
import {
  ADJUDICATION_FALLBACK_MODEL,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBED_MAX_INPUTS,
  FAILURE_POLICY,
  GEMINI_BASE_URL,
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
  defaultEmbedQuota,
  estimateCostUsd,
  type EmbedQuota,
} from "./llm-config";

export type Provider = "gemini" | "openrouter" | "openai";

// What a 429 said about the quota that was hit (Google's QuotaFailure detail).
export type QuotaInfo = { id: string; metric: string; scope: "minute" | "day" | "other" };

export class LlmError extends Error {
  constructor(
    message: string,
    readonly provider: Provider,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly quota?: QuotaInfo,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

// A per-day quota is spent: retrying today is pointless, and it is not the provider failing.
export class QuotaExhaustedError extends LlmError {
  constructor(message: string, provider: Provider, status?: number, quota?: QuotaInfo) {
    super(message, provider, false, status, undefined, quota);
    this.name = "QuotaExhaustedError";
  }
}

export function parseQuotaFailure(body: string): { quota?: QuotaInfo; retryDelayMs?: number } {
  try {
    const details = (JSON.parse(body) as { error?: { details?: Record<string, unknown>[] } }).error?.details ?? [];
    let quota: QuotaInfo | undefined;
    let retryDelayMs: number | undefined;
    for (const d of details) {
      const type = String(d["@type"] ?? "");
      if (type.endsWith("QuotaFailure")) {
        const v = (d.violations as { quotaId?: string; quotaMetric?: string }[] | undefined)?.[0];
        if (v) {
          const id = v.quotaId ?? "";
          quota = {
            id,
            metric: v.quotaMetric ?? "",
            scope: /PerDay/i.test(id) ? "day" : /PerMinute/i.test(id) ? "minute" : "other",
          };
        }
      } else if (type.endsWith("RetryInfo")) {
        const secs = parseFloat(String(d.retryDelay ?? ""));
        if (Number.isFinite(secs)) retryDelayMs = secs * 1000;
      }
    }
    return { quota, retryDelayMs };
  } catch {
    return {};
  }
}

export class CircuitOpenError extends LlmError {
  constructor(provider: Provider) {
    super(`circuit breaker open for ${provider}`, provider, false);
    this.name = "CircuitOpenError";
  }
}

export class DeadlineError extends LlmError {
  constructor(provider: Provider) {
    super(`deadline reached before the ${provider} call could complete`, provider, false);
    this.name = "DeadlineError";
  }
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type LlmClientOptions = {
  db: Db;
  // Epoch ms after which no new attempt starts. Typically maxDuration minus a 10s margin.
  deadline?: number;
  keys?: { gemini?: string; openrouter?: string; openai?: string };
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  // Client-side pacing for embeddings. Default: free-tier limits (null turns pacing off).
  embedQuota?: EmbedQuota | null;
};

export type CallContext = { articleId?: string; storyId?: string };

type Usage = { inputTokens: number; outputTokens: number; providerCostUsd: number | null };

type RawResult<T> = { value: T; usage: Usage };

export function createLlmClient(options: LlmClientOptions) {
  const { db } = options;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const keys = {
    gemini: options.keys?.gemini ?? process.env.GOOGLE_GEMINI_API_KEY,
    openrouter: options.keys?.openrouter ?? process.env.OPEN_ROUTER_API_KEY,
    openai: options.keys?.openai ?? process.env.OPENAI_API_KEY,
  };
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
  const policy = FAILURE_POLICY;

  const consecutiveFailures: Record<Provider, number> = { gemini: 0, openrouter: 0, openai: 0 };
  // Models whose per-day quota is spent this run: later calls fail fast without a request.
  const dailyExhausted = new Set<string>();
  const embedQuota = options.embedQuota === undefined ? defaultEmbedQuota() : options.embedQuota;

  // Sliding one-minute window of what this project has sent to the embedding model. Seeded
  // from llm_calls on first use, so separate runs (and the backfill script) share the budget.
  let window: { at: number; inputs: number; tokens: number }[] | null = null;

  async function loadWindow() {
    const rows = (await db.execute(sql`
      SELECT input_count, input_tokens, extract(epoch FROM (now() - created_at)) AS age
      FROM llm_calls
      WHERE model = ${EMBEDDING_MODEL} AND (ok OR quota_id IS NOT NULL)
        AND created_at > now() - interval '60 seconds'
    `)) as unknown as { input_count: number | null; input_tokens: number | null; age: string }[];
    return rows.map((r) => ({
      at: now() - Number(r.age) * 1000,
      inputs: r.input_count ?? 0,
      tokens: r.input_tokens ?? 0,
    }));
  }

  // Waits until sending `inputs`/`tokens` keeps the last minute under the margin.
  async function pace(inputs: number, tokens: number) {
    if (!embedQuota) return;
    window ??= await loadWindow();
    const maxInputs = Math.floor(embedQuota.perMinuteInputs * embedQuota.margin);
    const maxTokens = Math.floor(embedQuota.perMinuteTokens * embedQuota.margin);
    for (;;) {
      const t = now();
      window = window.filter((w) => w.at > t - 60_000);
      const usedInputs = window.reduce((n, w) => n + w.inputs, 0);
      const usedTokens = window.reduce((n, w) => n + w.tokens, 0);
      if ((usedInputs + inputs <= maxInputs && usedTokens + tokens <= maxTokens) || window.length === 0) return;
      // Wait for the oldest entry to leave the window, then re-check.
      const wait = Math.ceil(window[0].at + 60_000 - t + 50);
      if (t + wait >= deadline) throw new DeadlineError("gemini");
      await sleep(wait);
    }
  }

  const baseUrl = (p: Provider) =>
    p === "gemini" ? GEMINI_BASE_URL : p === "openai" ? OPENAI_BASE_URL : OPENROUTER_BASE_URL;

  function breakerOpen(provider: Provider) {
    return consecutiveFailures[provider] >= policy.breakerThreshold;
  }

  function backoffMs(attempt: number) {
    // 1s * 2^attempt, +-50% jitter
    const base = policy.backoffBaseMs * 2 ** attempt;
    return base * (0.5 + random());
  }

  // One HTTP request with a timeout; maps failures to LlmError with a retryable flag.
  async function request(
    provider: Provider,
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const key = keys[provider];
    if (!key) throw new LlmError(`no API key configured for ${provider}`, provider, false);
    const timeout = Math.min(timeoutMs, deadline - now());
    if (timeout <= 0) throw new DeadlineError(provider);

    let res: Response;
    try {
      res = await doFetch(`${baseUrl(provider)}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      const err = e as Error;
      throw new LlmError(`${provider} request failed: ${err.name}: ${err.message}`, provider, true);
    }

    if (!res.ok) {
      const full = await res.text().catch(() => "");
      const text = full.slice(0, 300);
      const headerRetry = Number(res.headers.get("retry-after"));
      const { quota, retryDelayMs } = res.status === 429 ? parseQuotaFailure(full) : {};
      const message = `${provider} ${res.status}: ${text}`;
      if (quota?.scope === "day") throw new QuotaExhaustedError(message, provider, res.status, quota);
      throw new LlmError(
        message,
        provider,
        res.status === 429 || res.status >= 500,
        res.status,
        retryDelayMs ?? (Number.isFinite(headerRetry) && headerRetry > 0 ? headerRetry * 1000 : undefined),
        quota,
      );
    }
    try {
      return await res.json();
    } catch {
      throw new LlmError(`${provider} returned a non-JSON body`, provider, true);
    }
  }

  // Retries with backoff, bounded by the deadline, and feeds the circuit breaker.
  async function withRetries<T>(
    provider: Provider,
    quotaKey: string,
    run: () => Promise<RawResult<T>>,
  ): Promise<RawResult<T>> {
    if (dailyExhausted.has(quotaKey)) {
      throw new QuotaExhaustedError(`${quotaKey}: daily quota already exhausted this run`, provider);
    }
    if (breakerOpen(provider)) throw new CircuitOpenError(provider);
    let lastError: LlmError | undefined;
    for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
      try {
        const result = await run();
        consecutiveFailures[provider] = 0;
        return result;
      } catch (e) {
        const err = e instanceof LlmError ? e : new LlmError(String(e), provider, false);
        lastError = err;
        if (!err.retryable || attempt === policy.maxAttempts - 1) break;
        const wait = Math.max(backoffMs(attempt), err.retryAfterMs ?? 0);
        if (now() + wait >= deadline) break;
        await sleep(wait);
      }
    }
    // Deadline and spent-quota stops are not the provider failing; everything else counts toward the breaker.
    if (lastError instanceof QuotaExhaustedError) dailyExhausted.add(quotaKey);
    else if (!(lastError instanceof DeadlineError)) consecutiveFailures[provider] += 1;
    throw lastError!;
  }

  async function record(row: {
    purpose: string;
    provider: Provider;
    model: string;
    usage?: Usage;
    latencyMs: number;
    error?: string;
    context?: CallContext;
    cacheKey?: string;
    response?: unknown;
    inputCount?: number;
    quotaId?: string;
  }) {
    const { usage } = row;
    const cost = usage
      ? (estimateCostUsd(row.model, usage.inputTokens, usage.outputTokens) ?? usage.providerCostUsd)
      : null;
    await db.insert(llmCalls).values({
      purpose: row.purpose,
      provider: row.provider,
      model: row.model,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      costUsd: cost,
      latencyMs: Math.round(row.latencyMs),
      ok: row.error === undefined,
      error: row.error ?? null,
      articleId: row.context?.articleId ?? null,
      storyId: row.context?.storyId ?? null,
      cacheKey: row.cacheKey ?? null,
      response: row.response ?? null,
      inputCount: row.inputCount ?? null,
      quotaId: row.quotaId ?? null,
    });
  }

  function parseUsage(raw: unknown, estimateInputChars: number): Usage {
    const usage = ((raw as { usage?: Record<string, unknown> })?.usage ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      // Gemini's embeddings endpoint may omit usage; fall back to ~4 chars per token.
      inputTokens: num(usage.prompt_tokens) ?? Math.ceil(estimateInputChars / 4),
      outputTokens: num(usage.completion_tokens) ?? 0,
      providerCostUsd: num(usage.cost),
    };
  }

  async function embed(args: {
    inputs: string[];
    purpose?: string;
  }): Promise<{ vectors: number[][] }> {
    const { inputs } = args;
    const purpose = args.purpose ?? "embed";
    if (inputs.length === 0) return { vectors: [] };
    if (inputs.length > EMBED_MAX_INPUTS) {
      throw new Error(`embed: at most ${EMBED_MAX_INPUTS} inputs per request, got ${inputs.length}`);
    }
    const started = now();
    const estTokens = Math.ceil(inputs.reduce((n, x) => n + x.length, 0) / 4);
    try {
      if (!dailyExhausted.has(EMBEDDING_MODEL)) await pace(inputs.length, estTokens);
      const { value, usage } = await withRetries<number[][]>("gemini", EMBEDDING_MODEL, async () => {
        const raw = (await request(
          "gemini",
          "/embeddings",
          { model: EMBEDDING_MODEL, input: inputs, dimensions: EMBEDDING_DIMENSIONS },
          policy.embedTimeoutMs,
        )) as { data?: { index?: number; embedding?: number[] }[] };
        const data = [...(raw.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        const vectors = data.map((d) => d.embedding);
        if (
          vectors.length !== inputs.length ||
          vectors.some((v) => !Array.isArray(v) || v.length !== EMBEDDING_DIMENSIONS)
        ) {
          throw new LlmError(
            `gemini returned ${vectors.length} embeddings (expected ${inputs.length} x ${EMBEDDING_DIMENSIONS} dims)`,
            "gemini",
            false,
          );
        }
        return {
          value: vectors as number[][],
          usage: parseUsage(raw, inputs.reduce((n, s) => n + s.length, 0)),
        };
      });
      await record({
        purpose,
        provider: "gemini",
        model: EMBEDDING_MODEL,
        usage,
        latencyMs: now() - started,
        inputCount: inputs.length,
      });
      window?.push({ at: now(), inputs: inputs.length, tokens: usage.inputTokens });
      return { vectors: value };
    } catch (e) {
      await record({
        purpose,
        provider: "gemini",
        model: EMBEDDING_MODEL,
        latencyMs: now() - started,
        error: (e as Error).message,
        inputCount: inputs.length,
        quotaId: (e as LlmError).quota?.id,
      }).catch(() => {});
      // A rejected request may still have used quota; keep it in the window so pacing backs off.
      if (e instanceof LlmError && e.status === 429) window?.push({ at: now(), inputs: inputs.length, tokens: estTokens });
      throw e;
    }
  }

  async function chatOnce(
    provider: Provider,
    model: string,
    args: { messages: ChatMessage[]; jsonSchema?: { name: string; schema: object }; temperature?: number },
  ): Promise<RawResult<string>> {
    return withRetries<string>(provider, model, async () => {
      const body: Record<string, unknown> = { model, messages: args.messages };
      if (args.temperature !== undefined) body.temperature = args.temperature;
      if (args.jsonSchema) {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: args.jsonSchema.name, schema: args.jsonSchema.schema, strict: true },
        };
      }
      if (provider === "openrouter") body.usage = { include: true };
      const raw = (await request(provider, "/chat/completions", body, policy.chatTimeoutMs)) as {
        choices?: { message?: { content?: string | null; refusal?: string | null } }[];
      };
      const message = raw.choices?.[0]?.message;
      // OpenAI structured outputs report a safety refusal here instead of content; retrying will not help.
      if (message?.refusal) throw new LlmError(`${provider} refused: ${message.refusal.slice(0, 200)}`, provider, false);
      const content = message?.content;
      if (typeof content !== "string") {
        throw new LlmError(`${provider} returned no message content`, provider, true);
      }
      return {
        value: content,
        usage: parseUsage(raw, args.messages.reduce((n, m) => n + m.content.length, 0)),
      };
    });
  }

  async function lookupCache(cacheKey: string): Promise<unknown | undefined> {
    const [hit] = await db
      .select({ response: llmCalls.response })
      .from(llmCalls)
      .where(and(eq(llmCalls.cacheKey, cacheKey), eq(llmCalls.ok, true), isNotNull(llmCalls.response)))
      .orderBy(desc(llmCalls.createdAt))
      .limit(1);
    return hit?.response ?? undefined;
  }

  // Chat goes to Gemini first, then falls back to OpenRouter; both attempts are recorded.
  async function chat(args: {
    // "openrouter" or "openai" skips Gemini and the fallback: the call goes to `model` on that
    // provider only (silver labeling uses a non-Gemini model on purpose, D12).
    provider?: Provider;
    temperature?: number;
    model: string;
    fallbackModel?: string;
    messages: ChatMessage[];
    jsonSchema?: { name: string; schema: object };
    purpose: string;
    context?: CallContext;
    // Same key => the stored verdict is returned and no call is made.
    cacheKey?: string;
  }): Promise<{ text: string; json: unknown | null; provider: Provider; model: string; cached: boolean }> {
    if (args.cacheKey) {
      const cached = await lookupCache(args.cacheKey);
      if (cached !== undefined) {
        const c = cached as { text: string; json: unknown | null; provider: Provider; model: string };
        return { ...c, cached: true };
      }
    }

    const only = args.provider && args.provider !== "gemini" ? args.provider : null;
    const attempts: { provider: Provider; model: string }[] = [{ provider: only ?? "gemini", model: args.model }];
    if (!only && keys.openrouter) {
      attempts.push({ provider: "openrouter", model: args.fallbackModel ?? ADJUDICATION_FALLBACK_MODEL });
    }

    let lastError: Error | undefined;
    for (const { provider, model } of attempts) {
      const started = now();
      try {
        const { value: text, usage } = await chatOnce(provider, model, args);
        let json: unknown | null = null;
        if (args.jsonSchema) {
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
        }
        await record({
          purpose: args.purpose,
          provider,
          model,
          usage,
          latencyMs: now() - started,
          context: args.context,
          cacheKey: args.cacheKey,
          response: args.cacheKey ? { text, json, provider, model } : undefined,
        });
        return { text, json, provider, model, cached: false };
      } catch (e) {
        lastError = e as Error;
        await record({
          purpose: args.purpose,
          provider,
          model,
          latencyMs: now() - started,
          error: lastError.message,
          context: args.context,
          quotaId: (lastError as LlmError).quota?.id,
        }).catch(() => {});
        // A blown deadline means the fallback would not finish either.
        if (e instanceof DeadlineError) break;
      }
    }
    throw lastError!;
  }

  return { chat, embed, isBreakerOpen: breakerOpen };
}

export type LlmClient = ReturnType<typeof createLlmClient>;
