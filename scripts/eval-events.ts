// Replays a snapshot through a clustering strategy tick by tick and scores it against the labelled events
// (story-clustering-v2 Phase 2). Usage:
//   pnpm eval:events [--snapshot eval/snapshot-2026-10-24.jsonl] [--events eval/events-*.jsonl]
//     [--labels eval/labels-*.jsonl ...] [--strategy v1|v2] [--orders 1] [--t-low 0.84] [--adjudicator jev-latest]
//     [--confirm] [--max-calls 5000] [--worst 5]
//   v1 only: [--window-hours 12] [--tau 0.93]
//   v2 only: [--k-max 25] [--max-gap-hours 36] [--max-span-hours 48] [--tau-link 0.8] [--min-judged 3] [--max-dissent 0.25]
//            (adjudicator defaults to the pinned jev-1.14.0; verdicts are shared across orders)
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
import { ADJUDICATION_PROMPT_VERSION, DEFAULT_ADJUDICATOR, chatMessages, createAdjudicator } from "@/lib/pipeline/adjudicate";
import { DEFAULT_CONSOLIDATE_CONFIG } from "@/lib/pipeline/consolidate-config";
import { createMemoryVerdictStore, type StoredVerdict } from "@/lib/pipeline/judge";
import { parseJsonl } from "@/lib/labels";
import type { SnapshotArticle } from "@/lib/eval/replay";
import { BudgetExceededError, measuringAdjudicator, snapshotAdjudicator, toAdjudicationArticle } from "@/lib/eval/adjudicator";
import { orderSpread } from "@/lib/eval/events";
import { reportRun, type OrderReport } from "@/lib/eval/event-report";
import { parseEventsJsonl, toEvalEvent } from "@/lib/eval/event-labels-io";
import { planTicks, runStrategy, type Strategy } from "@/lib/eval/ticks";
import { createV1Strategy } from "@/lib/eval/v1-strategy";
import { createV2Strategy } from "@/lib/eval/v2-strategy";

// The jev request carries the question and the definition on top of the two articles; calibrated on the 2026-11-08
// runs (4,347 and 31,961 calls billed about 650 input tokens each against ~436 counted from the article text alone).
const JEV_OVERHEAD_TOKENS = 215;
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
      "k-max": { type: "string" },
      "max-gap-hours": { type: "string" },
      "max-span-hours": { type: "string" },
      "tau-link": { type: "string" },
      "min-judged": { type: "string" },
      "max-dissent": { type: "string" },
      tau: { type: "string" },
      adjudicator: { type: "string" },
      confirm: { type: "boolean" },
      "max-calls": { type: "string" },
      worst: { type: "string" },
    },
  });
  const strategyName = values.strategy ?? "v1";
  if (strategyName !== "v1" && strategyName !== "v2") throw new Error(`unknown strategy "${strategyName}" (v1 or v2)`);

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
  const num = (v: string | undefined, d: number) => (v === undefined ? d : Number(v));
  const v2base = {
    ...DEFAULT_CONSOLIDATE_CONFIG,
    tLow: num(values["t-low"], DEFAULT_CONSOLIDATE_CONFIG.tLow),
    kMax: num(values["k-max"], DEFAULT_CONSOLIDATE_CONFIG.kMax),
    maxGapHours: num(values["max-gap-hours"], DEFAULT_CONSOLIDATE_CONFIG.maxGapHours),
    maxSpanHours: num(values["max-span-hours"], DEFAULT_CONSOLIDATE_CONFIG.maxSpanHours),
    tauLink: num(values["tau-link"], DEFAULT_CONSOLIDATE_CONFIG.tauLink),
    minJudged: num(values["min-judged"], DEFAULT_CONSOLIDATE_CONFIG.minJudged),
    maxDissent: num(values["max-dissent"], DEFAULT_CONSOLIDATE_CONFIG.maxDissent),
  };
  const model = values.adjudicator ?? (strategyName === "v2" ? DEFAULT_CONSOLIDATE_CONFIG.adjudicator.model : DEFAULT_ADJUDICATOR.model);
  const v2cfg = { ...v2base, adjudicator: { model, promptVersion: ADJUDICATION_PROMPT_VERSION } };
  const tau = values.tau ? Number(values.tau) : DEFAULT_ADJUDICATOR.tau;
  const orders = Math.max(1, Number(values.orders ?? 1));
  const labelled = events.filter((e) => e.humanLabeled).length;

  console.log(
    strategyName === "v2"
      ? `strategy=v2 T_low=${v2cfg.tLow} k=${v2cfg.kMax} gap=${v2cfg.maxGapHours}h span=${v2cfg.maxSpanHours}h tau_link=${v2cfg.tauLink} min_judged=${v2cfg.minJudged} max_dissent=${v2cfg.maxDissent} adjudicator=${model} orders=${orders}`
      : `strategy=v1 T_low=${cfg.tLow} window=${cfg.windowHours}h adjudicator=${model} tau=${tau} orders=${orders}`,
  );
  console.log(`snapshot: ${snapshot.length} articles (${all.length - snapshot.length} excluded); events: ${events.length} (${labelled} labelled by you); pair labels: ${pairLabels.length}`);

  // Dry run: how many calls would the replay make, and what would they cost?
  if (!values.confirm) {
    const price = PRICES_PER_MILLION[model] ?? (model.startsWith("jev") ? PRICES_PER_MILLION["jev-latest"] : undefined);
    if (!price) throw new Error(`No price for ${model}; add it to PRICES_PER_MILLION first`);
    if (strategyName === "v2") {
      // A judge that answers "different" for everything: nothing merges, so this counts the pairs retrieval proposes
      // and the scope each tick would judge. Real runs add the pairs the algorithm asks for (frozen stories, densify).
      let calls = 0;
      let chars = 0;
      const byGuid = new Map(snapshot.map((a) => [a.guid, a]));
      const judge = async (a: SnapshotArticle, b: SnapshotArticle): Promise<StoredVerdict> => {
        calls++;
        chars += chatMessages(toAdjudicationArticle(a), toAdjudicationArticle(b)).reduce((n, m) => n + m.content.length, 0);
        return { relation: "different", pSame: 0, model };
      };
      const strategy = createV2Strategy({ cfg: v2cfg, judge, store: createMemoryVerdictStore() });
      const result = await runStrategy(planTicks(snapshot, {}), strategy);
      const perCall = calls === 0 ? 0 : chars / calls / 4 + (model.startsWith("jev") ? JEV_OVERHEAD_TOKENS : 0);
      const cost = (n: number) => (n * perCall * price.input + n * 60 * price.output) / 1_000_000;
      const pairs = result.candidatePairs?.size ?? 0;
      console.log(`${pairs} candidate pairs retrieved (${(pairs / snapshot.length).toFixed(1)} per article); ${calls} are in scope to judge, ~${Math.round(perCall)} input tokens per call`);
      console.log(`estimate: ${calls}-${Math.round(calls * 1.2)} calls (the upper figure allows 20% for frozen stories and densify rounds), ${usd(cost(calls))}-${usd(cost(calls * 1.2))} for ${model}, before the verdict cache`);
      console.log(`per day at this volume: about ${Math.round(calls / 8)} calls, ${usd(cost(calls) / 8)}`);
      void byGuid;
      if (orders > 1) console.log(`(shared verdicts: the other ${orders - 1} orders judge only pairs the first did not)`);
      console.log("Dry run. Re-run with --confirm to make the calls (add --max-calls N to cap them).");
      return;
    }
    const { adjudicate, measured } = measuringAdjudicator(snapshot);
    await runStrategy(planTicks(snapshot, {}), createV1Strategy({ cfg, adjudicate }));
    const perCall = measured.calls === 0 ? 0 : measured.inputChars / measured.calls / 4 + (model.startsWith("jev") ? JEV_OVERHEAD_TOKENS : 0);
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
  const { adjudicate: judge } = createAdjudicator(llm, { ...DEFAULT_ADJUDICATOR, model, tau }, { purpose: strategyName === "v2" ? "adjudicate-v2" : "adjudicate" });
  const maxCalls = values["max-calls"] ? Number(values["max-calls"]) : undefined;
  const snap = snapshotAdjudicator({ snapshot, tau, judge: (a, m) => judge(a, m), maxCalls });
  const adjudicate: Adjudicator = snap.adjudicate;
  const failed: string[] = [];

  // v2 judges pairs without a threshold: it keeps p_same and lets the consolidation decide. Verdicts are shared
  // across orders, so a pair is paid for once however many orders are replayed.
  const v2stats = { calls: 0, cached: 0, invalid: 0, failedPairs: 0 };
  const v2store = createMemoryVerdictStore();
  const v2judge = async (a: SnapshotArticle, b: SnapshotArticle): Promise<StoredVerdict> => {
    if (maxCalls !== undefined && v2stats.calls >= maxCalls) throw new BudgetExceededError(maxCalls);
    const v = await judge(toAdjudicationArticle(a), toAdjudicationArticle(b));
    if (v.cached) v2stats.cached++;
    else v2stats.calls++;
    if (v.relation === "invalid") v2stats.invalid++;
    return { relation: v.relation, pSame: v.pSame, model: v.model ?? model };
  };
  const makeStrategy = (): Strategy =>
    strategyName === "v2"
      ? createV2Strategy({
          cfg: v2cfg,
          judge: v2judge,
          store: v2store,
          abortOn: (e) => e instanceof BudgetExceededError,
          onFailure: () => v2stats.failedPairs++,
        })
      : createV1Strategy({
          cfg,
          adjudicate,
          abortOn: (e) => e instanceof BudgetExceededError,
          onFailure: (g) => failed.push(g),
        });

  const reports: OrderReport[] = [];
  try {
    for (let o = 0; o < orders; o++) {
      // Order 0 is the canonical arrival order; the others shuffle within each tick and jitter each article's tick.
      const plan = planTicks(snapshot, o === 0 ? {} : { shuffleSeed: o, jitter: true });
      reports.push(reportRun(await runStrategy(plan, makeStrategy()), events, sourceOf, pairLabels));
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
  console.log(`stories=${first.stories}; retrieval recall: ${first.retrieval ? `${pct(first.retrieval.recall)} (${first.retrieval.found} of ${first.retrieval.pairs} in×in pairs)` : "n/a for v1 (no retrieval step)"}`);
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
    .where(and(eq(llmCalls.purpose, strategyName === "v2" ? "adjudicate-v2" : "adjudicate"), gte(llmCalls.createdAt, startedAt)));
  console.log(
    strategyName === "v2"
      ? `\nclassifier: ${v2stats.calls} calls, ${v2stats.cached} from the verdict cache, ${v2stats.invalid} unreadable, ${v2stats.failedPairs} failed pairs`
      : `\nclassifier: ${snap.stats.calls} calls, ${snap.stats.cached} from the verdict cache, ${snap.stats.invalid} unreadable, ${snap.stats.failed} failed (${failed.length} articles left unclustered)`,
  );
  console.log(`cost ${usd(Number(row.cost))} this run, ${usd((Number(row.cost) / snapshot.length) * 100)} per 100 articles`);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
