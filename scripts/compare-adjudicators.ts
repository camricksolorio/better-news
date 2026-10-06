// Classifier comparison (D35): runs each candidate adjudicator on labeled pairs and reports a precision-versus-τ
// curve, the τ that reaches the precision target on development data, and how that τ does on the reference pairs.
// Usage: pnpm eval:compare [--models gpt-4o-mini,gemini-3.5-flash-lite,jev-latest] [--sets reference,wcep]
//          [--wcep-sample 400] [--seed 1] [--agree gpt-4o-mini,jev-latest] [--target 0.97]
//          [--confirm] [--max-calls 1500] [--concurrency 4]
// Without --confirm it only prints how many calls each run would make and what they would cost. Every call
// spends money: approve the estimate first. Verdicts are cached (llm_calls.cache_key), so re-runs are free.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { createLlmClient } from "@/lib/llm";
import { PRICES_PER_MILLION } from "@/lib/llm-config";
import { loadPairFile } from "@/lib/labeling";
import { parseJsonl } from "@/lib/labels";
import { chatMessages, createAdjudicator, ADJUDICATION_PROMPT_VERSION, type Verdict } from "@/lib/pipeline/adjudicate";
import { agree, calibration, confusion, curve, pickTau, type Scored } from "@/lib/eval/compare";
import { publicPairs, referencePairs, type LabeledPair } from "@/lib/eval/pair-sets";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${x.toFixed(x < 1 ? 3 : 2)}`;
const LABELS_FILE = "eval/labels-2026-10-06.jsonl";

function loadSets(names: string[], wcepSample: number, seed: number): Map<string, LabeledPair[]> {
  const sets = new Map<string, LabeledPair[]>();
  for (const name of names) {
    if (name === "reference") {
      sets.set(name, referencePairs(parseJsonl(readFileSync(LABELS_FILE, "utf8")), loadPairFile()));
    } else if (name === "wcep" || name === "semeval") {
      const file = `eval/public/${name}-pairs.jsonl`;
      if (!existsSync(file)) {
        console.log(`skipping ${name}: ${file} does not exist (run pnpm eval:${name})`);
        continue;
      }
      sets.set(name, publicPairs(name, readFileSync(file, "utf8"), wcepSample, seed));
    } else throw new Error(`unknown set ${name}`);
  }
  return sets;
}

const priceOf = (model: string) => PRICES_PER_MILLION[model] ?? (model.startsWith("jev") ? PRICES_PER_MILLION["jev-latest"] : undefined);

async function main() {
  const { values } = parseArgs({
    options: {
      models: { type: "string" },
      sets: { type: "string" },
      "wcep-sample": { type: "string" },
      seed: { type: "string" },
      agree: { type: "string" },
      target: { type: "string" },
      confirm: { type: "boolean" },
      "max-calls": { type: "string" },
      concurrency: { type: "string" },
    },
  });
  const models = (values.models ?? "gpt-4o-mini,gemini-3.5-flash-lite,jev-latest").split(",");
  const setNames = (values.sets ?? "reference").split(",");
  const target = Number(values.target ?? 0.97);
  const sets = loadSets(setNames, Number(values["wcep-sample"] ?? 400), Number(values.seed ?? 1));
  const total = [...sets.values()].reduce((n, s) => n + s.length, 0);
  console.log(`prompt ${ADJUDICATION_PROMPT_VERSION}; sets: ${[...sets].map(([k, v]) => `${k}=${v.length} (${v.filter((p) => p.truth).length} same)`).join(", ")}`);

  if (!values.confirm) {
    for (const model of models) {
      const price = priceOf(model);
      if (!price) throw new Error(`No price for ${model}; add it to PRICES_PER_MILLION first`);
      const chars = [...sets.values()].flat().reduce((n, p) => n + chatMessages(p.a, p.b).reduce((m, x) => m + x.content.length, 0), 0);
      const inTok = chars / 4;
      const outTok = total * (model.startsWith("jev") ? 20 : 60);
      console.log(`${model}: ${total} calls, ~${Math.round(inTok / Math.max(total, 1))} input tokens each, about ${usd((inTok * price.input + outTok * price.output) / 1e6)} before the verdict cache`);
    }
    console.log("Dry run. Re-run with --confirm to make the calls.");
    return;
  }

  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const client = postgres(process.env.DATABASE_URL, { prepare: false, max: 2 });
  const db = drizzle(client, { schema });
  const llm = createLlmClient({ db });
  const maxCalls = values["max-calls"] ? Number(values["max-calls"]) : Infinity;
  const concurrency = Number(values.concurrency ?? 4);
  let calls = 0;

  // verdicts[model][set] = verdict per pair key, or null when the call failed.
  const verdicts = new Map<string, Map<string, Map<string, Verdict | null>>>();
  for (const model of models) {
    const { adjudicate } = createAdjudicator(llm, { model, promptVersion: ADJUDICATION_PROMPT_VERSION, tau: 0 }, { purpose: "compare-adjudicators" });
    const bySet = new Map<string, Map<string, Verdict | null>>();
    for (const [name, pairs] of sets) {
      const out = new Map<string, Verdict | null>();
      const queue = [...pairs];
      const worker = async () => {
        for (let p = queue.shift(); p; p = queue.shift()) {
          if (calls >= maxCalls) throw new Error(`call budget of ${maxCalls} reached; raise --max-calls (cached verdicts are kept)`);
          try {
            const v = await adjudicate(p.a, p.b);
            if (!v.cached) calls++;
            out.set(p.key, v);
          } catch (e) {
            console.log(`  ${model} ${name}: call failed: ${(e as Error).message.slice(0, 120)}`);
            out.set(p.key, null);
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      bySet.set(name, out);
      console.log(`${model} ${name}: ${[...out.values()].filter(Boolean).length}/${pairs.length} answered`);
    }
    verdicts.set(model, bySet);
  }

  const scoredFor = (name: string, pick: (key: string) => Pick<Scored, "relation" | "pSame"> | null): Scored[] =>
    (sets.get(name) ?? []).flatMap((p) => {
      const v = pick(p.key);
      return v ? [{ truth: p.truth, pSame: v.pSame, relation: v.relation, thin: p.thin }] : [];
    });

  const candidates: { label: string; pick: (set: string, key: string) => Pick<Scored, "relation" | "pSame"> | null }[] = models.map((m) => ({
    label: m,
    pick: (set, key) => verdicts.get(m)?.get(set)?.get(key) ?? null,
  }));
  if (values.agree) {
    const [ma, mb] = values.agree.split(",");
    candidates.push({
      label: `${ma} + ${mb} agree`,
      pick: (set, key) => {
        const a = verdicts.get(ma)?.get(set)?.get(key);
        const b = verdicts.get(mb)?.get(set)?.get(key);
        return a && b ? agree(a, b) : null;
      },
    });
  }

  const dev = setNames.find((n) => n === "wcep" || n === "semeval");
  const report: Record<string, unknown> = {};
  for (const c of candidates) {
    console.log(`\n=== ${c.label} ===`);
    const entry: Record<string, unknown> = {};
    for (const name of sets.keys()) {
      const scored = scoredFor(name, (k) => c.pick(name, k));
      const points = curve(scored);
      console.log(`\n${name} (${scored.length} pairs)  relations vs truth: ${JSON.stringify(confusion(scored))}`);
      console.log("  τ     joins  precision  recall");
      for (const p of points) console.log(`  ${p.tau.toFixed(2)}  ${String(p.joins).padStart(5)}  ${pct(p.precision).padStart(8)}  ${pct(p.recall).padStart(6)}`);
      const thin = scored.filter((s) => s.thin);
      if (thin.length) {
        const tp = curve(thin, [0.9])[0];
        console.log(`  thin-article pairs at τ 0.90: ${tp.joins} joins, precision ${pct(tp.precision)} (${thin.length} thin pairs)`);
      }
      console.log("  calibration (p_same bucket: n, share truly same): " + calibration(scored).filter((b) => b.n).map((b) => `${b.from.toFixed(2)}+: ${b.n}, ${b.sameRate === null ? "-" : pct(b.sameRate)}`).join(" | "));
      entry[name] = { points, calibration: calibration(scored) };
    }
    if (dev) {
      const devPoints = curve(scoredFor(dev, (k) => c.pick(dev, k)));
      const chosen = pickTau(devPoints, target);
      console.log(chosen ? `\nτ for ≥${target} precision on ${dev}: ${chosen.tau} (recall ${pct(chosen.recall)}, ${chosen.joins} joins)` : `\nNo τ reaches ${target} precision on ${dev}.`);
      if (chosen && sets.has("reference")) {
        const ref = curve(scoredFor("reference", (k) => c.pick("reference", k)), [chosen.tau])[0];
        console.log(`  on reference at τ ${chosen.tau}: precision ${pct(ref.precision)}, recall ${pct(ref.recall)} (${ref.tp} right and ${ref.fp} wrong joins; human labels win)`);
      }
    }
    report[c.label] = entry;
  }

  mkdirSync("eval/public", { recursive: true });
  const file = `eval/public/comparison-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(file, JSON.stringify({ promptVersion: ADJUDICATION_PROMPT_VERSION, sets: Object.fromEntries([...sets].map(([k, v]) => [k, v.length])), report }, null, 1));
  console.log(`\nscores written to ${file}; ${calls} calls reached a model this run (the rest came from the cache)`);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
