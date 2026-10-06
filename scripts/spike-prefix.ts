// Spike: does the "task: clustering | query: " prefix help gemini-embedding-2 separate same-story
// pairs from different-event pairs? Embeds the labeled pairs' articles under several prefix
// variants (embeddings API only, a few cents) and compares how well cosine similarity separates
// `same` from everything else. Run `embed` once, then `eval` after labels exist.
// Usage: pnpm eval:prefix embed | pnpm eval:prefix eval
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { createLlmClient } from "@/lib/llm";
import { cleanText, SUMMARY_MAX_CHARS } from "@/lib/text";
import { loadPairFile, pairKey, type Label } from "@/lib/labeling";
import { cosine } from "@/lib/pipeline/assign";
import type { SnapshotArticle } from "@/lib/eval/replay";
import { evalPairLabels, feedItems } from "@/db/schema";
import { inArray } from "drizzle-orm";

const VARIANTS: Record<string, string> = {
  none: "",
  clustering: "task: clustering | query: ",
  similarity: "task: sentence similarity | query: ",
};
const OUT = "eval/prefix-spike-embeddings.json";

const text = (a: SnapshotArticle, prefix: string) =>
  `${prefix}${cleanText(a.title)}\n\n${cleanText(a.summary).slice(0, SUMMARY_MAX_CHARS)}`;

function loadSnapshot() {
  const file = `eval/${readdirSync("eval").filter((f) => /^snapshot-.*\.jsonl$/.test(f)).sort().at(-1)}`;
  const snapshot: SnapshotArticle[] = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return new Map(snapshot.map((a) => [a.guid, a]));
}

async function embedStep() {
  const articles = loadSnapshot();
  const pairs = loadPairFile();
  const guids = [...new Set(pairs.flatMap((p) => [p.a, p.b]))].filter((g) => articles.has(g));
  const client = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const llm = createLlmClient({ db: drizzle(client, { schema }) });
  const out: Record<string, Record<string, number[]>> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
  for (const [name, prefix] of Object.entries(VARIANTS)) {
    out[name] ??= {};
    const todo = guids.filter((g) => !out[name][g]);
    for (let i = 0; i < todo.length; i += 25) {
      const batch = todo.slice(i, i + 25);
      const { vectors } = await llm.embed({ inputs: batch.map((g) => text(articles.get(g)!, prefix)), purpose: "spike-prefix" });
      batch.forEach((g, k) => (out[name][g] = vectors[k]));
    }
    console.log(`${name}: ${guids.length} articles embedded`);
  }
  writeFileSync(OUT, JSON.stringify(out));
  await client.end();
}

// AUC via the rank-sum identity: the chance a random `same` pair scores higher than a random other pair.
function auc(pos: number[], neg: number[]) {
  const all = [...pos.map((s) => ({ s, p: 1 })), ...neg.map((s) => ({ s, p: 0 }))].sort((a, b) => a.s - b.s);
  let rank = 1;
  let sum = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j < all.length && all[j].s === all[i].s) j++;
    const avg = (rank + (rank + (j - i) - 1)) / 2;
    for (let k = i; k < j; k++) if (all[k].p) sum += avg;
    rank += j - i;
    i = j;
  }
  return (sum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

async function evalStep() {
  const embeddings: Record<string, Record<string, number[]>> = JSON.parse(readFileSync(OUT, "utf8"));
  const pairs = loadPairFile();
  const client = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const db = drizzle(client, { schema });
  const guids = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
  const items = await db.select({ id: feedItems.id, guid: feedItems.guid }).from(feedItems).where(inArray(feedItems.guid, guids));
  const guidById = new Map(items.map((i) => [i.id, i.guid]));
  // Human labels win over model labels.
  const labels = new Map<string, { label: Label; human: boolean }>();
  for (const r of await db.select().from(evalPairLabels)) {
    const key = pairKey(guidById.get(r.articleA) ?? "", guidById.get(r.articleB) ?? "");
    const human = r.labeler === "human";
    const prev = labels.get(key);
    if (!prev || (human && !prev.human)) labels.set(key, { label: r.label as Label, human });
  }
  const usable = pairs.filter((p) => labels.has(pairKey(p.a, p.b)) && labels.get(pairKey(p.a, p.b))!.label !== "unsure");
  console.log(`${usable.length} labeled pairs (${[...labels.values()].filter((l) => l.human).length} human)`);
  for (const name of Object.keys(VARIANTS)) {
    const pos: number[] = [];
    const neg: number[] = [];
    for (const p of usable) {
      const a = embeddings[name]?.[p.a];
      const b = embeddings[name]?.[p.b];
      if (!a || !b) continue;
      (labels.get(pairKey(p.a, p.b))!.label === "same" ? pos : neg).push(cosine(a, b));
    }
    const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / (x.length || 1);
    console.log(`${name.padEnd(11)} AUC ${auc(pos, neg).toFixed(3)}  mean cos same ${mean(pos).toFixed(3)} / other ${mean(neg).toFixed(3)}  (${pos.length} same, ${neg.length} other)`);
  }
  await client.end();
}

const step = process.argv[2];
(step === "embed" ? embedStep() : step === "eval" ? evalStep() : Promise.reject(new Error("usage: pnpm eval:prefix embed|eval"))).catch((e) => {
  console.error(e);
  process.exit(1);
});
