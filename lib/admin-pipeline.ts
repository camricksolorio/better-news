// Data behind the cost panel (/admin/costs) and the pipeline health panel (/admin/pipeline).
import { sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { QUOTA_TIME_ZONE } from "@/lib/llm-config";
import { runHealthChecks, type Health } from "@/lib/pipeline/health";
import { MAX_EMBED_ATTEMPTS } from "@/lib/pipeline/embed";
import { MAX_CLUSTER_ATTEMPTS } from "@/lib/pipeline/cluster";

// R3: running cost stays under this per day.
export const DAILY_BUDGET_USD = 0.5;

export type CostRow = { day: string; purpose: string; model: string; calls: number; failedCalls: number; inputTokens: number; outputTokens: number; costUsd: number };
export type CostDay = { day: string; costUsd: number; overBudget: boolean };

// By Pacific day, the day Google's quotas reset on, like the usage ledger (lib/usage.ts).
export async function costsByDay(db: Db, days = 14): Promise<{ rows: CostRow[]; days: CostDay[] }> {
  const raw = (await db.execute(sql`
    SELECT (created_at AT TIME ZONE ${QUOTA_TIME_ZONE})::date::text AS day, purpose, model,
           count(*)::int AS calls,
           count(*) FILTER (WHERE NOT ok)::int AS failed_calls,
           coalesce(sum(input_tokens), 0)::int AS input_tokens,
           coalesce(sum(output_tokens), 0)::int AS output_tokens,
           coalesce(sum(cost_usd), 0)::float AS cost
    FROM llm_calls
    WHERE created_at > now() - make_interval(days => ${days + 1})
    GROUP BY 1, 2, 3
    ORDER BY 1 DESC, cost DESC, purpose, model
  `)) as unknown as { day: string; purpose: string; model: string; calls: number; failed_calls: number; input_tokens: number; output_tokens: number; cost: number }[];
  const rows = raw.map((r) => ({ day: r.day, purpose: r.purpose, model: r.model, calls: r.calls, failedCalls: r.failed_calls, inputTokens: r.input_tokens, outputTokens: r.output_tokens, costUsd: r.cost }));
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.costUsd);
  return { rows, days: [...byDay].map(([day, costUsd]) => ({ day, costUsd, overBudget: costUsd > DAILY_BUDGET_USD })) };
}

export type StageRun = { stage: "embed" | "cluster"; startedAt: Date; finishedAt: Date | null; status: "ok" | "failed" | "running"; processed: number | null; remaining: number | null; failed: number | null; error: string | null };
export type PipelineStatus = {
  stages: StageRun[];
  counts: { needsEmbedding: number; awaitingCluster: number; clustered: number };
  oldestUnprocessedHours: number | null;
  stuck: { embed: number; cluster: number };
  openStories: number;
  // The last 24 hours of llm_calls.
  last24h: { calls: number; failed: number; rateLimited: number; fallback: number };
  health: Health;
};

export async function loadPipelineStatus(db: Db): Promise<PipelineStatus> {
  const runs = (await db.execute(sql`
    SELECT DISTINCT ON (stage) stage, started_at, finished_at, processed, remaining, failed, error
    FROM pipeline_runs ORDER BY stage, started_at DESC
  `)) as unknown as { stage: "embed" | "cluster"; started_at: Date; finished_at: Date | null; processed: number | null; remaining: number | null; failed: number | null; error: string | null }[];

  const [c] = (await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE embedding IS NULL)::int AS needs_embedding,
      count(*) FILTER (WHERE embedding IS NOT NULL AND clustered_at IS NULL)::int AS awaiting_cluster,
      count(*) FILTER (WHERE clustered_at IS NOT NULL)::int AS clustered,
      extract(epoch FROM now() - min(created_at) FILTER (WHERE clustered_at IS NULL)) / 3600 AS oldest_hours,
      count(*) FILTER (WHERE embed_attempts >= ${MAX_EMBED_ATTEMPTS})::int AS stuck_embed,
      count(*) FILTER (WHERE cluster_attempts >= ${MAX_CLUSTER_ATTEMPTS})::int AS stuck_cluster,
      (SELECT count(*)::int FROM stories WHERE status = 'open') AS open_stories
    FROM feed_items
  `)) as unknown as { needs_embedding: number; awaiting_cluster: number; clustered: number; oldest_hours: string | null; stuck_embed: number; stuck_cluster: number; open_stories: number }[];

  const [l] = (await db.execute(sql`
    SELECT count(*)::int AS calls,
           count(*) FILTER (WHERE NOT ok)::int AS failed,
           count(*) FILTER (WHERE quota_id IS NOT NULL OR error LIKE '%429%')::int AS rate_limited,
           count(*) FILTER (WHERE provider = 'openrouter')::int AS fallback
    FROM llm_calls WHERE created_at > now() - interval '24 hours'
  `)) as unknown as { calls: number; failed: number; rate_limited: number; fallback: number }[];

  return {
    stages: runs.map((r) => ({
      stage: r.stage,
      startedAt: new Date(r.started_at),
      finishedAt: r.finished_at ? new Date(r.finished_at) : null,
      status: !r.finished_at ? "running" : r.error ? "failed" : "ok",
      processed: r.processed,
      remaining: r.remaining,
      failed: r.failed,
      error: r.error,
    })),
    counts: { needsEmbedding: c.needs_embedding, awaitingCluster: c.awaiting_cluster, clustered: c.clustered },
    oldestUnprocessedHours: c.oldest_hours === null ? null : Number(c.oldest_hours),
    stuck: { embed: c.stuck_embed, cluster: c.stuck_cluster },
    openStories: c.open_stories,
    last24h: { calls: l.calls, failed: l.failed, rateLimited: l.rate_limited, fallback: l.fallback },
    health: await runHealthChecks(db),
  };
}
