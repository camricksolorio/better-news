// Replays a snapshot through the clustering core and scores it against labels.
// Usage: pnpm eval:cluster --snapshot eval/snapshot-*.jsonl --labels eval/labels-*.jsonl
//          [--t-low 0.84] [--window-hours 12]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DEFAULT_CLUSTER_CONFIG } from "@/lib/pipeline/assign";
import { parseJsonl } from "@/lib/labels";
import { replay, type SnapshotArticle } from "@/lib/eval/replay";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

async function main() {
  const { values } = parseArgs({
    options: {
      snapshot: { type: "string" },
      labels: { type: "string", multiple: true },
      "t-low": { type: "string" },
      "window-hours": { type: "string" },
      worst: { type: "string" },
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
  const r = await replay(snapshot, [...byPair.values()], cfg);
  const { metrics: m } = r;
  const title = new Map(snapshot.map((a) => [a.guid, a.title]));

  console.log(`config: T_low=${cfg.tLow} window=${cfg.windowHours}h`);
  console.log(`articles=${r.articles} stories=${r.stories} labeled pairs=${byPair.size}`);
  console.log(`precision=${pct(m.precision)} recall=${pct(m.recall)} F1=${pct(m.f1)} related-leak=${pct(m.relatedLeak)}`);
  console.log(`counts: ${JSON.stringify(m.counts)} missing=${m.unlabeledMissing}`);
  console.log(`Reached the classifier: ${r.grayCount} articles (${pct(r.grayShare)}); this baseline has no classifier, so nothing joins`);
  const worst = Number(values.worst ?? 5);
  console.log("\nworst false merges:");
  for (const e of m.falseMerges.slice(0, worst)) console.log(`  [${e.label}] ${title.get(e.a)}  <>  ${title.get(e.b)}`);
  console.log("worst false splits:");
  for (const e of m.falseSplits.slice(0, worst)) console.log(`  ${title.get(e.a)}  <>  ${title.get(e.b)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
