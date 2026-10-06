// Usage ledger over llm_calls: what we sent to each model per Pacific day (the day Google's
// daily quotas reset on), and a health check that warns before the daily cap is reached.
import { sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { EMBEDDING_MODEL, QUOTA_TIME_ZONE, defaultEmbedQuota, type EmbedQuota } from "./llm-config";

export type DailyUsage = {
  day: string; // Pacific date, YYYY-MM-DD
  model: string;
  calls: number;
  failedCalls: number;
  inputs: number;
  inputTokens: number;
  costUsd: number;
  quota429s: number;
  // Set when a per-day 429 arrived: what we had sent that day before it. This is what tells us
  // whether the daily cap counts requests or inputs.
  dayCapHit: { quotaId: string; okCallsBefore: number; okInputsBefore: number } | null;
};

type Row = {
  day: string;
  model: string;
  calls: number;
  failed_calls: number;
  inputs: number;
  input_tokens: number;
  cost: number;
  quota_429s: number;
  cap_quota_id: string | null;
  ok_calls_before: number | null;
  ok_inputs_before: number | null;
};

export async function usageByDay(db: Db, days = 7): Promise<DailyUsage[]> {
  const tz = QUOTA_TIME_ZONE;
  const rows = (await db.execute(sql`
    WITH c AS (
      SELECT *, (created_at AT TIME ZONE ${tz})::date AS day
      FROM llm_calls
      WHERE created_at > now() - make_interval(days => ${days + 1})
    ),
    caps AS (
      SELECT DISTINCT ON (day, model) day, model, created_at, quota_id
      FROM c WHERE quota_id LIKE '%PerDay%' ORDER BY day, model, created_at
    )
    SELECT c.day::text AS day, c.model,
           count(*)::int AS calls,
           count(*) FILTER (WHERE NOT c.ok)::int AS failed_calls,
           coalesce(sum(c.input_count) FILTER (WHERE c.ok), 0)::int AS inputs,
           coalesce(sum(c.input_tokens) FILTER (WHERE c.ok), 0)::int AS input_tokens,
           coalesce(sum(c.cost_usd), 0)::float AS cost,
           count(*) FILTER (WHERE c.quota_id IS NOT NULL)::int AS quota_429s,
           max(caps.quota_id) AS cap_quota_id,
           (SELECT count(*)::int FROM c b WHERE b.day = c.day AND b.model = c.model AND b.ok AND b.created_at < max(caps.created_at)) AS ok_calls_before,
           (SELECT coalesce(sum(b.input_count), 0)::int FROM c b WHERE b.day = c.day AND b.model = c.model AND b.ok AND b.created_at < max(caps.created_at)) AS ok_inputs_before
    FROM c LEFT JOIN caps ON caps.day = c.day AND caps.model = c.model
    GROUP BY c.day, c.model
    ORDER BY c.day DESC, c.model
  `)) as unknown as Row[];

  return rows.map((r) => ({
    day: r.day,
    model: r.model,
    calls: r.calls,
    failedCalls: r.failed_calls,
    inputs: r.inputs,
    inputTokens: r.input_tokens,
    costUsd: r.cost,
    quota429s: r.quota_429s,
    dayCapHit: r.cap_quota_id
      ? { quotaId: r.cap_quota_id, okCallsBefore: r.ok_calls_before ?? 0, okInputsBefore: r.ok_inputs_before ?? 0 }
      : null,
  }));
}

export type Check = { name: string; ok: boolean; detail: string };

// Fails once today's embedding inputs reach `warnAt` of the daily cap, or the cap was already hit.
export async function embedQuotaCheck(
  db: Db,
  quota: EmbedQuota | null = defaultEmbedQuota(),
  warnAt = 0.8,
): Promise<Check> {
  const name = "embed-quota";
  if (!quota) return { name, ok: true, detail: "paid tier: no client-side daily cap" };
  const today = (await usageByDay(db, 1)).find(
    (u) => u.model === EMBEDDING_MODEL && u.day === pacificToday(),
  );
  const used = today?.inputs ?? 0;
  const pct = Math.round((used / quota.perDayInputs) * 100);
  if (today?.dayCapHit) {
    return { name, ok: false, detail: `daily cap hit after ${today.dayCapHit.okInputsBefore} inputs / ${today.dayCapHit.okCallsBefore} requests` };
  }
  if (used >= quota.perDayInputs * warnAt) {
    return { name, ok: false, detail: `${used}/${quota.perDayInputs} inputs used today (${pct}%)` };
  }
  return { name, ok: true, detail: `${used}/${quota.perDayInputs} inputs used today (${pct}%)` };
}

export function pacificToday(now = new Date()): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: QUOTA_TIME_ZONE }).format(now);
}
