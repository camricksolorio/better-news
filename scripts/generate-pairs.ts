// Picks ~300 stratified pairs from the snapshot and writes eval/pairs-YYYY-MM-DD.jsonl.
// Usage: pnpm eval:pairs [--snapshot eval/snapshot-*.jsonl] [--seed 1]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DEFAULT_CLUSTER_CONFIG } from "@/lib/pipeline/assign";
import { selectPairs } from "@/lib/eval/pairs";
import { replay, type SnapshotArticle } from "@/lib/eval/replay";
import { buildSimCache } from "@/lib/eval/sim-cache";

async function main() {
  const { values } = parseArgs({ options: { snapshot: { type: "string" }, seed: { type: "string" } } });
  const file =
    values.snapshot ?? `eval/${readdirSync("eval").filter((f) => /^snapshot-.*\.jsonl$/.test(f)).sort().at(-1)}`;
  const snapshot: SnapshotArticle[] = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const cache = buildSimCache(snapshot);
  // "Merged" means joined in the default baseline configuration.
  const base = await replay(cache.sorted, [], DEFAULT_CLUSTER_CONFIG, { memberSim: cache.memberSim });
  const pairs = selectPairs(cache, base.clusterOf, { seed: values.seed ? Number(values.seed) : 1 });

  const out = `eval/pairs-${new Date().toISOString().slice(0, 10)}.jsonl`;
  writeFileSync(out, pairs.map((p) => JSON.stringify(p)).join("\n") + "\n");
  const byCategory = new Map<string, number>();
  for (const p of pairs) byCategory.set(p.category, (byCategory.get(p.category) ?? 0) + 1);
  console.log(`wrote ${pairs.length} pairs to ${out} from ${file}`);
  console.log(Object.fromEntries(byCategory));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
