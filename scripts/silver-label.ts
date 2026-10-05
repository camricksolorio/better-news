// Silver-labels the stratified pairs with a non-Gemini model through OpenRouter and stores the
// results in eval_pair_labels (labeler "model:<id>"). This spends money, so it only prints an
// estimate unless --confirm is passed.
// Usage: pnpm eval:silver [--model anthropic/claude-sonnet-5.5] [--confirm] [--limit 10]
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { inArray } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { evalPairLabels, feedItems } from "@/db/schema";
import { createLlmClient } from "@/lib/llm";
import { PRICES_PER_MILLION } from "@/lib/llm-config";
import { loadPairFile, pairKey } from "@/lib/labeling";
import {
  SILVER_JSON_SCHEMA,
  SILVER_PROMPT_VERSION,
  estimateSilverCost,
  parseSilverVerdict,
  silverMessages,
} from "@/lib/eval/silver";

async function main() {
  const { values } = parseArgs({
    options: { model: { type: "string" }, confirm: { type: "boolean" }, limit: { type: "string" } },
  });
  const model = values.model ?? "anthropic/claude-sonnet-5.5";
  const price = PRICES_PER_MILLION[model];
  if (!price) throw new Error(`No price for ${model}; add it to PRICES_PER_MILLION first`);
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

  const client = postgres(process.env.DATABASE_URL, { prepare: false, max: 2 });
  const db = drizzle(client, { schema });
  const labeler = `model:${model}`;

  let pairs = loadPairFile();
  if (values.limit) pairs = pairs.slice(0, Number(values.limit));

  // Skip pairs this model already labeled, so a re-run only pays for what is missing.
  const guids = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
  const items = await db.select({ id: feedItems.id, guid: feedItems.guid }).from(feedItems).where(inArray(feedItems.guid, guids));
  const idByGuid = new Map(items.map((i) => [i.guid, i.id]));
  const guidById = new Map(items.map((i) => [i.id, i.guid]));
  const done = new Set(
    (await db.select().from(evalPairLabels))
      .filter((r) => r.labeler === labeler)
      .map((r) => pairKey(guidById.get(r.articleA) ?? "", guidById.get(r.articleB) ?? "")),
  );
  const todo = pairs.filter((p) => !done.has(pairKey(p.a, p.b)) && idByGuid.has(p.a) && idByGuid.has(p.b));

  const est = estimateSilverCost(todo, price);
  console.log(`model ${model}: ${todo.length} pairs to label (${pairs.length - todo.length} already done)`);
  console.log(`estimate: ~${est.inputTokens} input + ~${est.outputTokens} output tokens, about $${est.costUsd.toFixed(2)}`);
  if (!values.confirm) {
    console.log("Dry run. Re-run with --confirm to make the calls.");
    await client.end();
    return;
  }

  const llm = createLlmClient({ db });
  let ok = 0;
  let failed = 0;
  const queue = [...todo];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      try {
        const res = await llm.chat({
          provider: "openrouter",
          model,
          messages: silverMessages(p),
          jsonSchema: SILVER_JSON_SCHEMA,
          purpose: `silver-label-${SILVER_PROMPT_VERSION}`,
        });
        const verdict = parseSilverVerdict(res.json);
        if (!verdict) throw new Error("unparseable verdict");
        const [a, b] = [idByGuid.get(p.a)!, idByGuid.get(p.b)!];
        const [articleA, articleB] = a < b ? [a, b] : [b, a];
        await db
          .insert(evalPairLabels)
          .values({ articleA, articleB, label: verdict.relation, labeler, note: `[${verdict.confidence.toFixed(2)}] ${verdict.reason}` })
          .onConflictDoNothing();
        ok++;
      } catch (e) {
        failed++;
        console.error(`failed ${p.a} | ${p.b}: ${(e as Error).message.slice(0, 160)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  console.log(`labeled ${ok}, failed ${failed}`);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
