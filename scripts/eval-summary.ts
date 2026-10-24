// Summary evaluation (story-summary-v1 D6, D11), in three steps. Files live under eval/.
//   pnpm eval:summary generate --model gpt-4o-mini [--model gpt-6-luna] [--limit 10] [--confirm]
//     Summarizes every golden story with each model (direct OpenAI calls, no fallback). Spends money, so it only
//     prints an estimate unless --confirm is passed. Writes eval/summary-runs/<date>-<model>.jsonl.
//   pnpm eval:summary pack [--runs a.jsonl,b.jsonl] [--seed 1]
//     Builds a blinded packet for local agents (Claude or Gemini): eval/summary-packets/<date>/packet.json, the
//     rubric, and a key that maps candidate labels back to models. No API calls.
//   pnpm eval:summary score [--packet eval/summary-packets/<date>]
//     Reads the agents' verdicts-<agent>.json files from the packet folder and prints per-model scores against
//     the ship bar. No API calls.
// Golden file: eval/golden-summaries.jsonl, one story per line: { id, title, summary: [bullets], articles | guids }.
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { inArray } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { feedItems } from "@/db/schema";
import { createLlmClient } from "@/lib/llm";
import { PRICES_PER_MILLION, SUMMARY_MODELS, SUMMARY_MODEL_DEFAULT } from "@/lib/llm-config";
import { SUMMARY_PROMPT_VERSION, summarizeStory, summaryMessages } from "@/lib/pipeline/summarize";
import {
  RUBRIC,
  SHIP_BAR_ZERO_UNSUPPORTED,
  buildPacket,
  parseGoldenFile,
  parseVerdictFile,
  scoreModels,
  type GoldenStory,
  type PacketKey,
  type RunRow,
} from "@/lib/eval/summary";

const EVAL_DIR = path.join(process.cwd(), "eval");
const GOLDEN_FILE = path.join(EVAL_DIR, "golden-summaries.jsonl");
const RUNS_DIR = path.join(EVAL_DIR, "summary-runs");
const PACKETS_DIR = path.join(EVAL_DIR, "summary-packets");
const today = () => new Date().toISOString().slice(0, 10);
const readJsonl = <T>(file: string) =>
  readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);

async function loadGolden(db: ReturnType<typeof drizzle<typeof schema>> | null): Promise<GoldenStory[]> {
  if (!existsSync(GOLDEN_FILE)) throw new Error(`No golden dataset at ${path.relative(process.cwd(), GOLDEN_FILE)}`);
  const records = parseGoldenFile(readFileSync(GOLDEN_FILE, "utf8"));
  const guids = [...new Set(records.flatMap((r) => r.guids ?? []))];
  const byGuid = new Map<string, schema_item>();
  if (guids.length) {
    if (!db) throw new Error("The golden file lists articles by guid, so DATABASE_URL is needed to look them up");
    for (let i = 0; i < guids.length; i += 500) {
      const rows = await db
        .select({ guid: feedItems.guid, sourceId: feedItems.sourceId, title: feedItems.title, summary: feedItems.summary, publishedAt: feedItems.publishedAt })
        .from(feedItems)
        .where(inArray(feedItems.guid, guids.slice(i, i + 500)));
      for (const r of rows) byGuid.set(r.guid, r);
    }
  }
  return records.map((r) => {
    const articles =
      r.articles ??
      r.guids!.map((g) => {
        const item = byGuid.get(g);
        if (!item) throw new Error(`golden story ${r.id}: no feed item with guid ${g}`);
        return { source: item.sourceId, title: item.title, snippet: item.summary, time: item.publishedAt?.toISOString() };
      });
    return { id: r.id, title: r.title, summary: r.summary, articles };
  });
}
type schema_item = { guid: string; sourceId: string; title: string; summary: string | null; publishedAt: Date | null };

async function generate(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: { model: { type: "string", multiple: true }, limit: { type: "string" }, confirm: { type: "boolean" } },
  });
  const models = values.model?.length ? values.model : [SUMMARY_MODEL_DEFAULT];
  for (const m of models) {
    if (!SUMMARY_MODELS[m]) throw new Error(`Unknown model ${m}; known: ${Object.keys(SUMMARY_MODELS).join(", ")}`);
    if (!PRICES_PER_MILLION[m]) throw new Error(`No price for ${m}; add it to PRICES_PER_MILLION first`);
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (llm_calls records every call)");
  if (values.confirm && !process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");

  const client = postgres(process.env.DATABASE_URL, { prepare: false, max: 2 });
  const db = drizzle(client, { schema });
  let golden = await loadGolden(db);
  if (values.limit) golden = golden.slice(0, Number(values.limit));

  const inputTokens = golden.reduce((n, g) => n + Math.ceil(summaryMessages(g.articles).reduce((m, x) => m + x.content.length, 0) / 4), 0);
  const outputTokens = golden.length * 400;
  console.log(`${golden.length} golden stories x ${models.length} model(s)`);
  for (const m of models) {
    const p = PRICES_PER_MILLION[m];
    console.log(`  ${m}: ~${inputTokens} input + ~${outputTokens} output tokens, about $${((inputTokens * p.input + outputTokens * p.output) / 1e6).toFixed(3)} (reasoning tokens not included)`);
  }
  if (!values.confirm) {
    console.log("Dry run. Re-run with --confirm to make the calls.");
    await client.end();
    return;
  }

  const llm = createLlmClient({ db });
  mkdirSync(RUNS_DIR, { recursive: true });
  for (const model of models) {
    const rows: RunRow[] = [];
    const queue = [...golden];
    const worker = async () => {
      for (let g = queue.shift(); g; g = queue.shift()) {
        try {
          const out = await summarizeStory(llm, { articles: g.articles, model, purpose: `summarize-eval-${SUMMARY_PROMPT_VERSION}` });
          rows.push({
            storyId: g.id, model, ok: true, summary: out.summary, dropped: out.dropped, headlineTrimmed: out.headlineTrimmed,
            inputTokens: out.usage?.inputTokens, outputTokens: out.usage?.outputTokens, costUsd: out.usage?.costUsd ?? null,
          });
        } catch (e) {
          rows.push({ storyId: g.id, model, ok: false, error: (e as Error).message.slice(0, 300) });
          console.error(`${model} failed ${g.id}: ${(e as Error).message.slice(0, 160)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    rows.sort((a, b) => a.storyId.localeCompare(b.storyId));
    const file = path.join(RUNS_DIR, `${today()}-${model}.jsonl`);
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const cost = rows.reduce((n, r) => n + (r.costUsd ?? 0), 0);
    console.log(`${model}: ${rows.filter((r) => r.ok).length} ok, ${rows.filter((r) => !r.ok).length} failed, $${cost.toFixed(4)} -> ${path.relative(process.cwd(), file)}`);
  }
  await client.end();
}

function latestRunFiles(): string[] {
  if (!existsSync(RUNS_DIR)) throw new Error("No runs yet. Run `pnpm eval:summary generate` first.");
  const latest = new Map<string, string>(); // model -> newest file
  for (const f of readdirSync(RUNS_DIR).filter((f) => f.endsWith(".jsonl")).sort()) {
    latest.set(f.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.jsonl$/, ""), path.join(RUNS_DIR, f));
  }
  return [...latest.values()];
}

async function pack(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { runs: { type: "string" }, seed: { type: "string" } } });
  const files = values.runs ? values.runs.split(",") : latestRunFiles();
  const runs: Record<string, RunRow[]> = {};
  for (const f of files) {
    const rows = readJsonl<RunRow>(f);
    if (rows.length === 0) throw new Error(`${f} is empty`);
    runs[rows[0].model] = rows;
  }
  const client = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { prepare: false, max: 1 }) : null;
  const golden = await loadGolden(client ? drizzle(client, { schema }) : null);
  await client?.end();
  const { packet, key } = buildPacket(golden, runs, values.seed ? Number(values.seed) : 1);
  const dir = path.join(PACKETS_DIR, today());
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "packet.json"), JSON.stringify(packet, null, 2));
  writeFileSync(path.join(dir, "RUBRIC.md"), RUBRIC + "\n");
  const meta = { key, goldenIds: golden.map((g) => g.id), runs: Object.fromEntries(Object.keys(runs).map((m, i) => [m, path.relative(process.cwd(), path.resolve(files[i]))])) };
  writeFileSync(path.join(dir, "key.json"), JSON.stringify(meta, null, 2));
  console.log(`packet for ${packet.stories.length} stories, models ${Object.keys(runs).join(", ")} -> ${path.relative(process.cwd(), dir)}`);
  console.log("Next: have each local agent read RUBRIC.md and packet.json and write verdicts-<agent>.json in that folder, then run `pnpm eval:summary score`.");
}

function score(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { packet: { type: "string" } } });
  const dir = values.packet ?? path.join(PACKETS_DIR, readdirSync(PACKETS_DIR).sort().pop() ?? "");
  const packet = JSON.parse(readFileSync(path.join(dir, "packet.json"), "utf8"));
  const meta = JSON.parse(readFileSync(path.join(dir, "key.json"), "utf8")) as { key: PacketKey; goldenIds: string[]; runs: Record<string, string> };
  const verdictFiles = readdirSync(dir)
    .filter((f) => /^verdicts-.*\.json$/.test(f))
    .map((f) => parseVerdictFile(JSON.parse(readFileSync(path.join(dir, f), "utf8")), packet));
  if (verdictFiles.length === 0) throw new Error(`No verdicts-<agent>.json files in ${dir}`);
  const runs = Object.fromEntries(Object.entries(meta.runs).map(([m, f]) => [m, readJsonl<RunRow>(f)]));
  const out = scoreModels({ goldenIds: meta.goldenIds, runs, key: meta.key, verdictFiles });

  const f = (n: number | null, d = 2) => (n === null ? "-" : n.toFixed(d));
  console.log(`agents: ${out.agents.join(", ")}; ${out.disagreements} candidate(s) where agents disagree on unsupported claims`);
  console.log("model            gen/fail  faithful  coverage  neutral  zero-unsupported  bullets  $/story");
  for (const m of out.models) {
    console.log(
      `${m.model.padEnd(16)} ${`${m.generated}/${m.failed}`.padEnd(9)} ${f(m.meanFaithfulness).padEnd(9)} ${f(m.meanCoverage).padEnd(9)} ${f(m.meanNeutrality).padEnd(8)} ` +
        `${`${(m.zeroUnsupportedRate * 100).toFixed(0)}%`.padEnd(17)} ${f(m.meanBullets, 1).padEnd(8)} ${m.costPerStoryUsd === null ? "-" : m.costPerStoryUsd.toFixed(5)}`,
    );
  }
  for (const m of out.models) {
    const pass = m.zeroUnsupportedRate >= SHIP_BAR_ZERO_UNSUPPORTED;
    console.log(`${pass ? "PASS" : "below bar"}: ${m.model} has zero unsupported claims on ${(m.zeroUnsupportedRate * 100).toFixed(0)}% of stories (bar ${SHIP_BAR_ZERO_UNSUPPORTED * 100}%)`);
  }
  writeFileSync(path.join(dir, "results.json"), JSON.stringify(out, null, 2));
}

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, (argv: string[]) => void | Promise<void>> = { generate, pack, score };
if (!commands[command]) {
  console.error("Usage: pnpm eval:summary <generate|pack|score> [options]");
  process.exit(1);
}
Promise.resolve(commands[command](rest)).catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
