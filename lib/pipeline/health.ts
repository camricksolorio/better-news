// Pipeline health checks (TDD "Endpoint contracts"): is each stage fresh, is anything piling up or stuck.
// Ages come from the database clock so they agree with the timestamps the stages wrote.
import { sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { MAX_CLUSTER_ATTEMPTS } from "./cluster";
import { MAX_EMBED_ATTEMPTS } from "./embed";

// Ingest and embed run once a day, so a stage is stale only after a missed run (24h cadence + slack).
export const MAX_AGE_HOURS = 36;

// Clustering is paused in production (2026-11-09): the workflow no longer calls /api/cluster, so its
// freshness, the unclustered backlog and cluster-attempt exhaustion say nothing about health. Set to
// false, and restore the "Cluster embedded articles" step in .github/workflows/ingest.yml, to resume.
export const CLUSTERING_PAUSED = true;

export type Check = { name: string; ok: boolean; detail: string };
export type Health = { ok: boolean; checks: Check[] };

type Row = {
  ingest_age: string | null;
  embed_age: string | null;
  cluster_age: string | null;
  backlog_age: string | null;
  stuck_embed: number;
  stuck_cluster: number;
};

const hours = (seconds: string | null) => (seconds === null ? null : Number(seconds) / 3600);
const fmt = (h: number) => `${h.toFixed(1)}h`;

function freshness(name: string, ageHours: number | null, what: string): Check {
  if (ageHours === null) return { name, ok: false, detail: `no ${what} yet` };
  return { name, ok: ageHours < MAX_AGE_HOURS, detail: `${what} ${fmt(ageHours)} ago (limit ${MAX_AGE_HOURS}h)` };
}

export async function runHealthChecks(db: Db, opts: { clusteringPaused?: boolean } = {}): Promise<Health> {
  const paused = opts.clusteringPaused ?? CLUSTERING_PAUSED;
  const [row] = (await db.execute(sql`
    SELECT
      (SELECT extract(epoch FROM now() - max(created_at)) FROM feed_items) AS ingest_age,
      (SELECT extract(epoch FROM now() - max(finished_at)) FROM pipeline_runs WHERE stage = 'embed' AND finished_at IS NOT NULL AND error IS NULL) AS embed_age,
      (SELECT extract(epoch FROM now() - max(finished_at)) FROM pipeline_runs WHERE stage = 'cluster' AND finished_at IS NOT NULL AND error IS NULL) AS cluster_age,
      -- Stuck rows are reported by their own check, so they are left out here.
      (SELECT extract(epoch FROM now() - min(created_at)) FROM feed_items WHERE clustered_at IS NULL AND embed_attempts < ${MAX_EMBED_ATTEMPTS} AND cluster_attempts < ${MAX_CLUSTER_ATTEMPTS}) AS backlog_age,
      (SELECT count(*)::int FROM feed_items WHERE embed_attempts >= ${MAX_EMBED_ATTEMPTS}) AS stuck_embed,
      (SELECT count(*)::int FROM feed_items WHERE cluster_attempts >= ${MAX_CLUSTER_ATTEMPTS}) AS stuck_cluster
  `)) as unknown as Row[];

  const backlog = hours(row.backlog_age);
  const stuck = paused ? row.stuck_embed : row.stuck_embed + row.stuck_cluster;
  const checks: Check[] = [
    freshness("ingest_freshness", hours(row.ingest_age), "newest article ingested"),
    freshness("embed_freshness", hours(row.embed_age), "last successful embed run"),
    ...(paused ? [] : [freshness("cluster_freshness", hours(row.cluster_age), "last successful cluster run")]),
    ...(paused
      ? []
      : [
          backlog === null
            ? { name: "backlog", ok: true, detail: "no unclustered articles" }
            : { name: "backlog", ok: backlog < MAX_AGE_HOURS, detail: `oldest unclustered article ingested ${fmt(backlog)} ago (limit ${MAX_AGE_HOURS}h)` },
        ]),
    {
      name: "stuck_rows",
      ok: stuck === 0,
      detail: stuck === 0 ? "none" : paused ? `${row.stuck_embed} rows out of embed attempts` : `${row.stuck_embed} rows out of embed attempts, ${row.stuck_cluster} out of cluster attempts`,
    },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}
