// Converts the extracted WCEP dataset (wcep-extracted-download/{train,val,test}.jsonl.gz) into labeled article pairs
// at eval/public/wcep-pairs.jsonl (gitignored). Usage: pnpm eval:wcep [--dir wcep-extracted-download] [--seed 1]
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { parseArgs } from "node:util";
import { buildPairs, type WcepEvent } from "@/lib/eval/wcep";

const SPLITS = ["train", "val", "test"];

async function main() {
  const { values } = parseArgs({ options: { dir: { type: "string" }, seed: { type: "string" } } });
  const dir = values.dir ?? "wcep-extracted-download";
  const events: WcepEvent[] = [];
  for (const split of SPLITS) {
    const lines = createInterface({ input: createReadStream(`${dir}/${split}.jsonl.gz`).pipe(createGunzip()) });
    for await (const line of lines) {
      if (!line) continue;
      const c = JSON.parse(line);
      // Drop the Common Crawl additions while streaming so the 380MB train file stays small in memory.
      events.push({ id: c.id, date: c.date, category: c.category, articles: c.articles.filter((a: { origin: string }) => a.origin === "WCEP") });
    }
    console.log(`${split}: ${events.length} events so far`);
  }
  const pairs = buildPairs(events, { seed: values.seed ? Number(values.seed) : 1 });
  mkdirSync("eval/public", { recursive: true });
  writeFileSync("eval/public/wcep-pairs.jsonl", pairs.map((p) => JSON.stringify(p)).join("\n") + "\n");
  const same = pairs.filter((p) => p.label === "same");
  console.log(`wrote ${pairs.length} pairs (${same.length} same, ${pairs.length - same.length} different)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
