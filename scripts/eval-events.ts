// Replays a snapshot through a clustering strategy tick by tick and scores it against the labelled events
// (story-clustering-v2 Phase 2). Usage:
//   pnpm eval:events [--snapshot eval/snapshot-2026-10-24.jsonl] [--events eval/events-*.jsonl]
//     [--labels eval/labels-*.jsonl ...] [--strategy v1] [--orders 1] [--t-low 0.84] [--window-hours 12]
//     [--tau 0.93] [--adjudicator jev-latest] [--confirm] [--max-calls 5000] [--worst 5]
// Without --confirm it only measures how many classifier calls the replay would make and what they would cost.
// Every call costs money, so approve the estimate first; verdicts are cached, so re-runs are free.
import { readFileSync, readdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, gte, sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { llmCalls } from "@/db/schema";
import { createLlmClient } from "@/lib/llm";
import { PRICES_PER_MILLION } from "@/lib/llm-config";
import { DEFAULT_CLUSTER_CONFIG, type Adjudicator } from "@/lib/pipeline/assign";
import { DEFAULT_ADJUDICATOR, createAdjudicator } from "@/lib/pipeline/adjudicate";
import { parseJsonl } from "@/lib/labels";
import type { SnapshotArticle } from "@/lib/eval/replay";
import { BudgetExceededError, measuringAdjudicator, snapshotAdjudicator } from "@/lib/eval/adjudicator";
import { orderSpread } from "@/lib/eval/events";
import { reportRun, type OrderReport } from "@/lib/eval/event-report";
import { parseEventsJsonl, toEvalEvent } from "@/lib/eval/event-labels-io";
import { planTicks, runStrategy, type Strategy } from "@/lib/eval/ticks";
import { createV1Strategy } from "@/lib/eval/v1-strategy";

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const usd = (x: number) => `$${x.toFixed(x < 1 ? 3 : 2)}`;
const latest = (prefix: string) =>
  "eval/" + readdirSync("eval").filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl")).sort().at(-1)!;

async function main() {
  const { values } = parseArgs({
    options: {
      snapshot: { type: "string" },
      events: { type: "string" },
      labels: { type: "string", multiple: true },
      strategy: { type: "string" },
      orders: { type: "string" },
      "t-low": { type: "string" },
      "window-hours": { type: "string" },
      tau: { type: "string" },
      adjudicator: { type: "string" },
      confirm: { type: "boolean" },
      "max-calls": { type: "string" },
      worst: { type: "string" },
    },
  });
  const strategyName = values.strategy ?? "v1";
  if (strategyName !== "v1") throw new Error(`strategy "${strategyName}" is not built yet (v2 comes in Phase 3); only v1 is available`);

  const snapshotFile = values.snapshot ?? "eval/snapshot-2026-10-24.jsonl";
  const all: SnapshotArticle[] = readFileSync(snapshotFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  // Excluded articles (live blogs) never reach clustering in production, so they do not in the replay either.
  const snapshot = all.filter((a) => !a.excludedReason);
  const sourceOf = new Map(snapshot.map((a) => [a.guid, a.sourceId]));

  const eventsFile = values.events ?? latest("events-");
  const events = parseEventsJsonl(readFileSync(eventsFile, "utf8")).map(toEvalEvent);
  const pairLabelFiles = values.labels ?? ["eval/labels-2026-10-06.jsonl"];
  const byPair = new Map<string, ReturnType<typeof parseJsonl>[number]>();
  for (const l of pairLabelFiles.flatMap((f) => parseJsonl(readFileSync(f, "utf8")))) {
    const key = l.a < l.b ? `${l.a}|${l.b}` : `${l.b}|${l.a}`;
    const prev = byPair.get(key);
    if (!prev || (l.labeler === "human" && prev.labeler !== "human")) byPair.set(key, l);
  }
  const pairLabels = [...byPair.values()].map((l) => ({ a: l.a, b: l.b, label: l.label }));

  const cfg = {
    ...DEFAULT_CLUSTER_CONFIG,
    tLow: values["t-low"] ? Number(values["t-low"]) : DEFAULT_CLUSTER_CONFIG.tLow,
    windowHours: values["window-hours"] ? Number(values["window-hours"]) : DEFAULT_CLUSTER_CONFIG.windowHours,
  };
  const model = values.adjudicator ?? DEFAULT_ADJUDICATOR.model;
  const tau = values.tau ? Number(values.tau) : DEFAULT_ADJUDICATOR.tau;
  const orders = Math.max(1, Number(values.orders ?? 1));
  const labelled = events.filter((e) => e.humanLabeled).length;

  console.log(`strategy=${strategyName} T_low=${cfg.tLow} window=${cfg.windowHours}h adjudicator=${model} tau=${tau} orders=${orders}`);
  console.log(`snapshot: ${snapshot.length} articles (${all.length - snapshot.length} excluded); events: ${events.length} (${labelled} labelled by you); pair labels: ${pairLabels.length}`);

  // Dry run: how many calls would the replay make, and what would they cost?
  if (!values.confirm) {
    const price = PRICES_PER_MILLION[model] ?? (model.startsWith("jev") ? PRICES_PER_MILLION["jev-latest"] : undefined);
    if (!price) throw new Error(`No price for ${model}; add it to PRICES_PER_MILLION first`);
    const { adjudicate, measured } = measuringAdjudicator(snapshot);
    await runStrategy(planTicks(snapshot, {}), createV1Strategy({ cfg, adjudicate }));
    const perCall = measured.calls === 0 ? 0 : measured.inputChars / measured.calls / 4;
    const cost = (calls: number) => (calls * perCall * price.input + calls * 60 * price.output) / 1_000_000;
    console.log(`${measured.calls} articles reach the classifier (${pct(measured.calls / snapshot.length)}), ~${Math.round(perCall)} input tokens per call`);
    console.log(`estimate: ${measured.calls}-${measured.calls * 2} calls, ${usd(cost(measured.calls))}-${usd(cost(measured.calls * 2))} for ${model}, before the verdict cache`);
    if (orders > 1) console.log(`(for the first order only; the other ${orders - 1} judge some extra pairs because articles arrive in a different order)`);
    console.log("Dry run. Re-run with --confirm to make the calls (add --max-calls N to cap them).");
    return;
  }

  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const client = postgres(process.env.DATABASE_URL, { prepare: false, max: 2 });
  const db = drizzle(client, { schema });
  const startedAt = new Date();
  const llm = createLlmClient({ db });
  const { adjudicate: judge } = createAdjudicator(llm, { ...DEFAULT_ADJUDICATOR, model, tau });
  const snap = snapshotAdjudicator({
    snapshot,
    tau,
    judge: (a, m) => judge(a, m),
    maxCalls: values["max-calls"] ? Number(values["max-calls"]) : undefined,
  });
  const adjudicate: Adjudicator = snap.adjudicate;
  const failed: string[] = [];

  const reports: OrderReport[] = [];
  try {
    for (let o = 0; o < orders; o++) {
      // Order 0 is the canonical arrival order; the others shuffle within each tick and jitter each article's tick.
      const plan = planTicks(snapshot, o === 0 ? {} : { shuffleSeed: o, jitter: true });
      const strategy: Strategy = createV1Strategy({
        cfg,
        adjudicate,
        abortOn: (e) => e instanceof BudgetExceededError,
        onFailure: (g) => failed.push(g),
      });
      reports.push(reportRun(await runStrategy(plan, strategy), events, sourceOf, pairLabels));
      console.log(`order ${o + 1}/${orders} done`);
    }
  } catch (e) {
    await client.end();
    if (!(e instanceof BudgetExceededError)) throw e;
    console.log(`\nStopped: ${e.message}. Raise --max-calls to finish; cached verdicts are kept.`);
    return;
  }

  const first = reports[0];
  console.log("");
  console.table(
    (["all", "dev", "holdout"] as const).map((k) => ({
      set: k,
      events: first.summary[k].events,
      "mean recall": pct(first.summary[k].meanRecall),
      "outlet recall": pct(first.summary[k].meanOutletRecall),
      "in ≤2 stories": pct(first.summary[k].shareAtMostTwoStories),
      "mean stories": first.summary[k].meanSplits.toFixed(2),
      related: first.summary[k].relatedMembers,
      out: first.summary[k].outMembers,
      unlabelled: first.summary[k].unlabeledMembers,
    })),
  );
  const p = first.pairs;
  console.log(`pairwise (event pairs + labelled pairs): precision=${pct(p.precision)} recall=${pct(p.recall)} related-leak=${pct(p.relatedLeak)} counts=${JSON.stringify(p.counts)}`);
  console.log(`stories=${first.stories}; retrieval recall: ${first.retrieval ? pct(first.retrieval.recall) : "n/a for v1 (no retrieval step)"}`);
  if (orders > 1) {
    const means = reports.map((r) => r.summary.all.meanRecall);
    console.log(`order spread over ${orders} orders: ${pct(orderSpread(means))} (mean recall ${means.map((m) => pct(m)).join(", ")}; bar ≤ 3.0%)`);
  }

  const worst = Number(values.worst ?? 5);
  console.log(`\nlowest-recall events:`);
  for (const s of [...first.scores].sort((a, b) => a.recall - b.recall).slice(0, worst)) {
    console.log(`  ${pct(s.recall)} in ${s.splits} stories  [${s.split}]  ${s.title}`);
  }

  const [row] = await db
    .select({ cost: sql<number>`coalesce(sum(${llmCalls.costUsd}), 0)`, n: sql<number>`count(*)::int` })
    .from(llmCalls)
    .where(and(eq(llmCalls.purpose, "adjudicate"), gte(llmCalls.createdAt, startedAt)));
  console.log(`\nclassifier: ${snap.stats.calls} calls, ${snap.stats.cached} from the verdict cache, ${snap.stats.invalid} unreadable, ${snap.stats.failed} failed (${failed.length} articles left unclustered)`);
  console.log(`cost ${usd(Number(row.cost))} this run, ${usd((Number(row.cost) / snapshot.length) * 100)} per 100 articles`);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
