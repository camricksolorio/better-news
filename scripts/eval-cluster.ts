// Replays a snapshot through the clustering core and scores it against labels.
// Usage: pnpm eval:cluster --snapshot eval/snapshot-*.jsonl --labels eval/labels-*.jsonl
//          [--t-low 0.84] [--window-hours 12] [--worst 5]
//          [--adjudicator gpt-4o-mini|gemini-3.5-flash-lite|jev-latest] [--tau 0.9] [--confirm] [--max-calls 2000]
// Without --adjudicator nothing joins (the embedding-only baseline). With one, the run is a dry run that prints
// an estimate and spends nothing unless --confirm is passed (every call costs money; verdicts are cached, so
// re-running or sweeping τ only pays for pairs not seen before).
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, gte, sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { llmCalls } from "@/db/schema";
import { createLlmClient } from "@/lib/llm";
import { PRICES_PER_MILLION } from "@/lib/llm-config";
import { DEFAULT_CLUSTER_CONFIG } from "@/lib/pipeline/assign";
import { DEFAULT_ADJUDICATOR, createAdjudicator } from "@/lib/pipeline/adjudicate";
import { parseJsonl } from "@/lib/labels";
import { replay, type SnapshotArticle } from "@/lib/eval/replay";
import { computeMetrics } from "@/lib/eval/metrics";
import { exactLowerBound } from "@/lib/eval/stats";
import { BudgetExceededError, measuringAdjudicator, snapshotAdjudicator } from "@/lib/eval/adjudicator";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${x.toFixed(x < 1 ? 3 : 2)}`;

async function main() {
  const { values } = parseArgs({
    options: {
      snapshot: { type: "string" },
      labels: { type: "string", multiple: true },
      "t-low": { type: "string" },
      "window-hours": { type: "string" },
      worst: { type: "string" },
      adjudicator: { type: "string" },
      tau: { type: "string" },
      confirm: { type: "boolean" },
      "max-calls": { type: "string" },
    },
  });
  if (!values.snapshot) throw new Error("--snapshot <file> is required");

  const snapshot: SnapshotArticle[] = readFileSync(values.snapshot, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const labels = (values.labels ?? []).flatMap((f) => parseJsonl(readFileSync(f, "utf8")));
  // Several labelers may judge a pair; human labels win over model labels.
  const byPair = new Map<string, (typeof labels)[number]>();
  for (const l of labels) {
    const key = `${l.a}|${l.b}`;
    const prev = byPair.get(key);
    if (!prev || (l.labeler === "human" && prev.labeler !== "human")) byPair.set(key, l);
  }

  const cfg = {
    ...DEFAULT_CLUSTER_CONFIG,
    tLow: values["t-low"] ? Number(values["t-low"]) : DEFAULT_CLUSTER_CONFIG.tLow,
    windowHours: values["window-hours"] ? Number(values["window-hours"]) : DEFAULT_CLUSTER_CONFIG.windowHours,
  };
  const model = values.adjudicator;
  const tau = values.tau ? Number(values.tau) : DEFAULT_ADJUDICATOR.tau;
  const pairLabels = [...byPair.values()];

  console.log(`config: T_low=${cfg.tLow} window=${cfg.windowHours}h${model ? ` adjudicator=${model} tau=${tau}` : " (no classifier)"}`);

  // Dry run: measure how many classifier calls this config makes and how big they are.
  if (model && !values.confirm) {
    const price = PRICES_PER_MILLION[model] ?? (model.startsWith("jev") ? PRICES_PER_MILLION["jev-latest"] : undefined);
    if (!price) throw new Error(`No price for ${model}; add it to PRICES_PER_MILLION first`);
    const { adjudicate, measured } = measuringAdjudicator(snapshot);
    await replay(snapshot, [], cfg, { adjudicate });
    // The first article is judged first; a join also needs the most similar member, so at most 2 calls per article.
    const perCall = measured.calls === 0 ? 0 : measured.inputChars / measured.calls / 4;
    const cost = (calls: number) => (calls * perCall * price.input + calls * 60 * price.output) / 1_000_000;
    console.log(`articles=${snapshot.length}; ${measured.calls} reach the classifier (${pct(measured.calls / snapshot.length)}), ~${Math.round(perCall)} input tokens per call`);
    console.log(`estimate: ${measured.calls}-${measured.calls * 2} calls (more only where the first article is judged the same), ${usd(cost(measured.calls))}-${usd(cost(measured.calls * 2))} for ${model}, before the verdict cache`);
    console.log("Dry run. Re-run with --confirm to make the calls (add --max-calls N to cap them).");
    return;
  }

  let client: ReturnType<typeof postgres> | undefined;
  let result;
  let stats;
  const startedAt = new Date();
  let db;
  if (model) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
    client = postgres(process.env.DATABASE_URL, { prepare: false, max: 2 });
    db = drizzle(client, { schema });
    const llm = createLlmClient({ db });
    const { adjudicate: judge } = createAdjudicator(llm, { ...DEFAULT_ADJUDICATOR, model, tau });
    const snap = snapshotAdjudicator({
      snapshot,
      tau,
      judge: (a, m) => judge(a, m),
      maxCalls: values["max-calls"] ? Number(values["max-calls"]) : undefined,
    });
    stats = snap.stats;
    try {
      result = await replay(snapshot, pairLabels, cfg, { adjudicate: snap.adjudicate, abortOn: (e) => e instanceof BudgetExceededError });
    } catch (e) {
      await client.end();
      if (!(e instanceof BudgetExceededError)) throw e;
      console.log(`\nStopped: ${e.message}. Raise --max-calls to finish; cached verdicts are kept.`);
      return;
    }
  } else {
    result = await replay(snapshot, pairLabels, cfg);
  }

  const r = result;
  const { metrics: m } = r;
  const title = new Map(snapshot.map((a) => [a.guid, a.title]));
  const thin = new Set(snapshot.filter((a) => a.thin).map((a) => a.guid));

  console.log(`articles=${r.articles} stories=${r.stories} labeled pairs=${byPair.size}`);
  console.log(`precision=${pct(m.precision)} recall=${pct(m.recall)} F1=${pct(m.f1)} related-leak=${pct(m.relatedLeak)}`);
  const bound = exactLowerBound(m.counts.tp, m.counts.tp + m.counts.fp);
  console.log(`precision 95% lower bound ${pct(bound)} on ${m.counts.tp + m.counts.fp} merged labeled pairs (stratified pairs, not the ship number; the join audit gives that, D37)`);
  const thinMetrics = computeMetrics(r.clusterOf, pairLabels.filter((l) => thin.has(l.a) || thin.has(l.b)));
  console.log(`thin-article pairs: precision=${pct(thinMetrics.precision)} recall=${pct(thinMetrics.recall)} (${thinMetrics.counts.tp + thinMetrics.counts.fp} merged)`);
  console.log(`counts: ${JSON.stringify(m.counts)} missing=${m.unlabeledMissing}`);
  console.log(`Reached the classifier: ${r.grayCount} articles (${pct(r.grayShare)})${model ? "" : "; this baseline has no classifier, so nothing joins"}`);
  if (stats && db) {
    const [row] = await db
      .select({ cost: sql<number>`coalesce(sum(${llmCalls.costUsd}), 0)`, n: sql<number>`count(*)::int` })
      .from(llmCalls)
      .where(and(eq(llmCalls.purpose, "adjudicate"), gte(llmCalls.createdAt, startedAt)));
    const cost = Number(row.cost);
    console.log(`classifier: ${stats.calls} calls, ${stats.cached} from the verdict cache, ${stats.invalid} unreadable, ${stats.failed} failed (${r.failed.length} articles left unclustered)`);
    console.log(`cost ${usd(cost)} this run, ${usd((cost / r.articles) * 100)} per 100 articles`);
  }
  const worst = Number(values.worst ?? 5);
  console.log("\nworst false merges:");
  for (const e of m.falseMerges.slice(0, worst)) console.log(`  [${e.label}] ${title.get(e.a)}  <>  ${title.get(e.b)}`);
  console.log("worst false splits:");
  for (const e of m.falseSplits.slice(0, worst)) console.log(`  ${title.get(e.a)}  <>  ${title.get(e.b)}`);
  await client?.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
