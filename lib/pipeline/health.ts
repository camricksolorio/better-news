// Pipeline health checks (TDD "Endpoint contracts"): is each stage fresh, is anything piling up or stuck.
// Ages come from the database clock so they agree with the timestamps the stages wrote.
import { sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { MAX_EMBED_ATTEMPTS } from "./embed";

export const MAX_AGE_HOURS = 12;

export type Check = { name: string; ok: boolean; detail: string };
export type Health = { ok: boolean; checks: Check[] };

type Row = {
  ingest_age: string | null;
  embed_age: string | null;
  cluster_age: string | null;
  backlog_age: string | null;
  stuck: number;
};

const hours = (seconds: string | null) => (seconds === null ? null : Number(seconds) / 3600);
const fmt = (h: number) => `${h.toFixed(1)}h`;

function freshness(name: string, ageHours: number | null, what: string): Check {
  if (ageHours === null) return { name, ok: false, detail: `no ${what} yet` };
  return { name, ok: ageHours < MAX_AGE_HOURS, detail: `${what} ${fmt(ageHours)} ago (limit ${MAX_AGE_HOURS}h)` };
}

export async function runHealthChecks(db: Db): Promise<Health> {
  const [row] = (await db.execute(sql`
    SELECT
      (SELECT extract(epoch FROM now() - max(created_at)) FROM feed_items) AS ingest_age,
      (SELECT extract(epoch FROM now() - max(finished_at)) FROM pipeline_runs WHERE stage = 'embed' AND finished_at IS NOT NULL AND error IS NULL) AS embed_age,
      (SELECT extract(epoch FROM now() - max(finished_at)) FROM pipeline_runs WHERE stage = 'cluster' AND finished_at IS NOT NULL AND error IS NULL) AS cluster_age,
      -- Stuck rows are reported by their own check, so they are left out here.
      (SELECT extract(epoch FROM now() - min(created_at)) FROM feed_items WHERE clustered_at IS NULL AND embed_attempts < ${MAX_EMBED_ATTEMPTS}) AS backlog_age,
      (SELECT count(*)::int FROM feed_items WHERE embed_attempts >= ${MAX_EMBED_ATTEMPTS}) AS stuck
  `)) as unknown as Row[];

  const backlog = hours(row.backlog_age);
  const checks: Check[] = [
    freshness("ingest_freshness", hours(row.ingest_age), "newest article ingested"),
    freshness("embed_freshness", hours(row.embed_age), "last successful embed run"),
    freshness("cluster_freshness", hours(row.cluster_age), "last successful cluster run"),
    backlog === null
      ? { name: "backlog", ok: true, detail: "no unclustered articles" }
      : { name: "backlog", ok: backlog < MAX_AGE_HOURS, detail: `oldest unclustered article ingested ${fmt(backlog)} ago (limit ${MAX_AGE_HOURS}h)` },
    { name: "stuck_rows", ok: row.stuck === 0, detail: row.stuck === 0 ? "none" : `${row.stuck} rows at ${MAX_EMBED_ATTEMPTS} failed embed attempts` },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}
