// Draws the join audit (D37): replays the snapshot with the real classifier, takes a random sample of the joins,
// and writes it to join_audit_items for review at /admin/audit. It never calls a model: its client has no network, so
// every verdict must already be in the cache (run `pnpm eval:cluster ... --confirm` with the same settings first).
// Usage: pnpm eval:audit --snapshot eval/snapshot-*.jsonl [--adjudicator jev-latest] [--tau 0.93] [--t-low 0.84]
//          [--window-hours 12] [--n 150] [--seed 1] [--audit-id <name>] [--confirm]
// Without --confirm it only reports how many joins there are and what it would insert.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { inArray } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { feedItems } from "@/db/schema";
import { createLlmClient } from "@/lib/llm";
import { DEFAULT_CLUSTER_CONFIG } from "@/lib/pipeline/assign";
import { DEFAULT_ADJUDICATOR, createAdjudicator } from "@/lib/pipeline/adjudicate";
import { replay, type SnapshotArticle } from "@/lib/eval/replay";
import { snapshotAdjudicator } from "@/lib/eval/adjudicator";
import { insertAudit, sampleJoins } from "@/lib/audit";

async function main() {
  const { values } = parseArgs({
    options: {
      snapshot: { type: "string" },
      adjudicator: { type: "string" },
      tau: { type: "string" },
      "t-low": { type: "string" },
      "window-hours": { type: "string" },
      n: { type: "string" },
      seed: { type: "string" },
      "audit-id": { type: "string" },
      confirm: { type: "boolean" },
    },
  });
  if (!values.snapshot) throw new Error("--snapshot <file> is required");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

  const model = values.adjudicator ?? DEFAULT_ADJUDICATOR.model;
  const tau = values.tau ? Number(values.tau) : DEFAULT_ADJUDICATOR.tau;
  const cfg = {
    ...DEFAULT_CLUSTER_CONFIG,
    tLow: values["t-low"] ? Number(values["t-low"]) : DEFAULT_CLUSTER_CONFIG.tLow,
    windowHours: values["window-hours"] ? Number(values["window-hours"]) : DEFAULT_CLUSTER_CONFIG.windowHours,
  };
  const n = Number(values.n ?? 150);
  const auditId = values["audit-id"] ?? `join-audit-${new Date().toISOString().slice(0, 10)}-${model}-t${tau}-low${cfg.tLow}-${cfg.windowHours}h`;

  const snapshot: SnapshotArticle[] = readFileSync(values.snapshot, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const client = postgres(process.env.DATABASE_URL, { prepare: false, max: 2 });
  const db = drizzle(client, { schema });
  try {
    // No model calls: a verdict missing from the cache fails the replay instead of costing money.
    const noNetwork = (() => {
      throw new Error("model calls are disabled in the audit sampler");
    }) as unknown as typeof fetch;
    const llm = createLlmClient({ db, fetch: noNetwork, sleep: async () => {} });
    const { adjudicate: judge } = createAdjudicator(llm, { ...DEFAULT_ADJUDICATOR, model, tau });
    const { adjudicate, stats } = snapshotAdjudicator({ snapshot, tau, judge: (a, m) => judge(a, m) });
    let result;
    try {
      result = await replay(snapshot, [], cfg, { adjudicate, abortOn: () => true });
    } catch {
      throw new Error("a verdict is not cached for this configuration; run eval:cluster with --confirm and the same settings first (this script never calls a model)");
    }
    console.log(`replay: ${result.joins.length} joins among ${result.articles} articles (${stats.cached} verdicts from the cache, ${stats.calls} model calls)`);

    const picks = sampleJoins(result.joins, n, values.seed ? Number(values.seed) : 1);
    const guids = [...new Set(picks.flatMap((p) => [p.articleId, p.memberId]))];
    const rows = await db.select({ id: feedItems.id, guid: feedItems.guid }).from(feedItems).where(inArray(feedItems.guid, guids));
    const idByGuid = new Map(rows.map((r) => [r.guid, r.id]));
    const resolvable = picks.filter((p) => idByGuid.has(p.articleId) && idByGuid.has(p.memberId));
    console.log(`audit "${auditId}": ${resolvable.length} of ${picks.length} sampled joins are in the database${resolvable.length < picks.length ? " (the rest were not found)" : ""}`);
    if (!values.confirm) {
      console.log("Dry run. Re-run with --confirm to write the audit.");
      return;
    }
    await insertAudit(db, auditId, resolvable.map((p) => ({ articleId: idByGuid.get(p.articleId)!, memberId: idByGuid.get(p.memberId)!, verdict: p.verdict })));
    console.log(`wrote ${resolvable.length} items. Review at /admin/audit?id=${encodeURIComponent(auditId)}`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
