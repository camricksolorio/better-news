// Models, endpoints, price table, and failure-policy numbers for lib/llm.ts (D21, D23).

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export const EMBEDDING_MODEL = "gemini-embedding-2";
export { EMBEDDING_DIMENSIONS } from "@/db/schema";
export const EMBED_BATCH_SIZE = 25;
export const EMBED_MAX_INPUTS = 100;

export const ADJUDICATION_MODEL = "gemini-3.5-flash-lite";
// Same model through OpenRouter, used when Gemini fails or its breaker is open.
export const ADJUDICATION_FALLBACK_MODEL = "google/gemini-3.5-flash-lite";

export const FAILURE_POLICY = {
  embedTimeoutMs: 20_000,
  chatTimeoutMs: 30_000,
  maxAttempts: 4,
  backoffBaseMs: 1_000,
  breakerThreshold: 3,
};

// USD per 1M tokens, paid standard tier, looked up 2026-10-03. The free tier costs $0;
// these are estimates either way. Models missing here fall back to the provider-reported cost.
export const PRICES_PER_MILLION: Record<string, { input: number; output: number }> = {
  "gemini-embedding-2": { input: 0.2, output: 0 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "google/gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  // OpenRouter list prices, looked up 2026-10-05; used for silver labeling (D12, non-Gemini).
  "anthropic/claude-sonnet-5.5": { input: 2, output: 10 },
  "openai/gpt-5.6-terra": { input: 2, output: 12 },
  "deepseek/deepseek-v4.1-flash": { input: 0.003, output: 2.4 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = PRICES_PER_MILLION[model];
  if (!price) return null;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

// Gemini free-tier limits for gemini-embedding-2, read from AI Studio on 2026-10-05. A probe the
// same day showed the per-minute "requests" quota counts every input in a batch (one request of
// 100 inputs used the whole 100/min), so the limits below are in inputs. Whether the daily cap
// counts inputs too is unverified until the first per-day 429; the usage ledger records it.
export type EmbedQuota = {
  perMinuteInputs: number;
  perMinuteTokens: number;
  perDayInputs: number;
  // Stay this fraction under the per-minute limits.
  margin: number;
};

export const EMBED_QUOTA_FREE: EmbedQuota = {
  perMinuteInputs: 100,
  perMinuteTokens: 30_000,
  perDayInputs: 1_000,
  margin: 0.9,
};

// GEMINI_TIER=paid turns client-side pacing off (paid limits are far above our volume).
export function defaultEmbedQuota(): EmbedQuota | null {
  return process.env.GEMINI_TIER === "paid" ? null : EMBED_QUOTA_FREE;
}

// Daily quotas reset at midnight Pacific.
export const QUOTA_TIME_ZONE = "America/Los_Angeles";
