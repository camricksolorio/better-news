// Replays the snapshot through v2 using only verdicts already paid for (the llm_calls cache) and writes the stories it
// built, plus where each labelled event's same-event pairs ended up, to eval/v2-run-<date>.json for /admin/v2.
// Makes no classifier calls and spends nothing: a pair with no cached verdict stays unjudged. Usage:
//   pnpm eval:v2-dump [--snapshot eval/snapshot-*.jsonl] [--events eval/events-*.jsonl] [--out eval/v2-run-DATE.json]
//     [--t-low 0.84] [--k-max 25] [--max-gap-hours 36] [--max-span-hours 48] [--tau-link 0.8] [--min-judged 3] [--max-dissent 0.25]
// Use the same settings as the eval:events run you want to look at, so the cached verdicts cover the pairs it judged.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, isNotNull, like } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { llmCalls } from "@/db/schema";
import type { LlmClient } from "@/lib/llm";
import { ADJUDICATION_PROMPT_VERSION, createAdjudicator } from "@/lib/pipeline/adjudicate";
import { DEFAULT_CONSOLIDATE_CONFIG } from "@/lib/pipeline/consolidate-config";
import { createMemoryVerdictStore, type StoredVerdict } from "@/lib/pipeline/judge";
import { parseEventsJsonl, toEvalEvent } from "@/lib/eval/event-labels-io";
import type { SnapshotArticle } from "@/lib/eval/replay";
import { toAdjudicationArticle } from "@/lib/eval/adjudicator";
import { planTicks, runStrategy } from "@/lib/eval/ticks";
import { createV2Strategy } from "@/lib/eval/v2-strategy";
import { buildDump } from "@/lib/eval/v2-dump";

const latest = (prefix: string) => "eval/" + readdirSync("eval").filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl")).sort().at(-1)!;

async function main() {
  const { values } = parseArgs({
    options: {
      snapshot: { type: "string" }, events: { type: "string" }, out: { type: "string" },
      "t-low": { type: "string" }, "k-max": { type: "string" }, "max-gap-hours": { type: "string" },
      "max-span-hours": { type: "string" }, "tau-link": { type: "string" }, "min-judged": { type: "string" }, "max-dissent": { type: "string" },
    },
  });
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const num = (v: string | undefined, d: number) => (v === undefined ? d : Number(v));
  const base = DEFAULT_CONSOLIDATE_CONFIG;
  const cfg = {
    ...base,
    tLow: num(values["t-low"], base.tLow),
    kMax: num(values["k-max"], base.kMax),
    maxGapHours: num(values["max-gap-hours"], base.maxGapHours),
    maxSpanHours: num(values["max-span-hours"], base.maxSpanHours),
    tauLink: num(values["tau-link"], base.tauLink),
    minJudged: num(values["min-judged"], base.minJudged),
    maxDissent: num(values["max-dissent"], base.maxDissent),
    adjudicator: { model: base.adjudicator.model, promptVersion: ADJUDICATION_PROMPT_VERSION },
  };

  const snapshotFile = values.snapshot ?? "eval/snapshot-2026-10-24.jsonl";
  const all: SnapshotArticle[] = readFileSync(snapshotFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const snapshot = all.filter((a) => !a.excludedReason);
  const events = parseEventsJsonl(readFileSync(values.events ?? latest("events-"), "utf8")).map(toEvalEvent);

  // Cached verdicts only: an uncached pair throws, which leaves it unjudged instead of calling (and paying) the classifier.
  const client = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  const db = drizzle(client, { schema });
  const rows = await db
    .select({ key: llmCalls.cacheKey, response: llmCalls.response })
    .from(llmCalls)
    .where(and(like(llmCalls.cacheKey, `adjudicate:${cfg.adjudicator.promptVersion}:${cfg.adjudicator.model}:%`), eq(llmCalls.ok, true), isNotNull(llmCalls.response)));
  await client.end();
  const cache = new Map<string, unknown>();
  for (const r of rows) if (r.key) cache.set(r.key, r.response);
  console.log(`${cache.size} cached verdicts for ${cfg.adjudicator.model}`);

  const cachedOnly = {
    classify: async (args: { cacheKey?: string }) => {
      const hit = args.cacheKey ? cache.get(args.cacheKey) : undefined;
      if (hit === undefined) throw new Error("not cached");
      return { ...(hit as { answers: never; model: string }), cached: true };
    },
    chat: async () => {
      throw new Error("chat is not used for jev models");
    },
  } as unknown as Pick<LlmClient, "chat" | "classify">;
  const { adjudicate } = createAdjudicator(cachedOnly, { ...cfg.adjudicator, tau: 0 } as never, { purpose: "adjudicate-v2" });

  const store = createMemoryVerdictStore();
  let missing = 0;
  const strategy = createV2Strategy({
    cfg,
    store,
    judge: async (a, b): Promise<StoredVerdict> => {
      const v = await adjudicate(toAdjudicationArticle(a), toAdjudicationArticle(b));
      return { relation: v.relation, pSame: v.pSame, model: v.model ?? cfg.adjudicator.model };
    },
    onFailure: () => missing++,
  });
  const result = await runStrategy(planTicks(snapshot, {}), strategy);

  const dump = buildDump({
    snapshot,
    snapshotName: snapshotFile,
    clusterOf: result.clusterOf,
    candidates: result.candidatePairs ?? new Set(),
    verdicts: new Map(store.entries()),
    events,
    tauLink: cfg.tauLink,
    config: { tLow: cfg.tLow, kMax: cfg.kMax, maxGapHours: cfg.maxGapHours, maxSpanHours: cfg.maxSpanHours, tauLink: cfg.tauLink, minJudged: cfg.minJudged, maxDissent: cfg.maxDissent, adjudicator: cfg.adjudicator.model },
  });
  const out = values.out ?? `eval/v2-run-${dump.generatedAt.slice(0, 10)}.json`;
  writeFileSync(out, JSON.stringify(dump));

  console.log(`wrote ${out}: ${dump.stories} stories (${dump.multi.length} with 2+ articles, ${dump.singletons} singletons); ${missing} pairs had no cached verdict`);
  const total = { merged: 0, not_retrieved: 0, unjudged: 0, judged_low: 0, judged_high: 0 };
  for (const e of dump.events.filter((x) => x.humanLabeled)) for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += e.counts[k];
  const n = Object.values(total).reduce((x, y) => x + y, 0);
  console.log(`same-event pairs on the ${dump.events.filter((e) => e.humanLabeled).length} labelled events (${n}): ` + Object.entries(total).map(([k, v]) => `${k} ${v} (${((v / n) * 100).toFixed(1)}%)`).join(", "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
