// Downloads SemEval-2022 Task 8 (Zenodo 6507872), keeps English-English pairs, fetches both articles
// from the Internet Archive links, and writes eval/public/semeval-pairs.jsonl (gitignored).
// Resumable: fetched pages are cached in eval/public/semeval-cache/. Pairs with a dead page are skipped.
// Usage: pnpm eval:semeval [--limit 200] [--concurrency 2] [--same-max 1.5] [--different-min 3.5]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { englishRows, extractArticle, labelFor } from "@/lib/eval/semeval";

const DIR = "eval/public";
const CACHE = `${DIR}/semeval-cache`;
const FILES = ["semeval-2022_task8_train-data_batch.csv", "final_eval_data.csv"];
const ZENODO = "https://zenodo.org/records/6507872/files";

async function csv(name: string): Promise<string> {
  const path = `${DIR}/${name}`;
  if (!existsSync(path)) {
    const res = await fetch(`${ZENODO}/${name}?download=1`, { headers: { "user-agent": "better-news-eval/0.1" } });
    if (!res.ok) throw new Error(`${name}: ${res.status}`);
    writeFileSync(path, await res.text());
  }
  return readFileSync(path, "utf8");
}

// Returns title/snippet, or null for a dead/unparseable page. Definitive results are cached; 429/5xx/network
// errors are retried with backoff and never cached, so a rate-limited run can be resumed.
async function article(url: string): Promise<{ title: string; snippet: string } | null> {
  const file = `${CACHE}/${Buffer.from(url).toString("base64url").slice(-80)}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "better-news-eval/0.1" } });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 5_000 * 2 ** attempt));
        continue;
      }
      const result = res.ok ? extractArticle(await res.text()) : null;
      writeFileSync(file, JSON.stringify(result));
      return result;
    } catch {
      await new Promise((r) => setTimeout(r, 5_000 * 2 ** attempt));
    }
  }
  return null;
}

async function main() {
  const { values } = parseArgs({
    options: { limit: { type: "string" }, concurrency: { type: "string" }, "same-max": { type: "string" }, "different-min": { type: "string" } },
  });
  mkdirSync(CACHE, { recursive: true });
  const rows = (await Promise.all(FILES.map(csv))).flatMap(englishRows);
  const todo = rows.slice(0, values.limit ? Number(values.limit) : undefined);
  console.log(`${rows.length} English pairs; fetching ${todo.length}`);

  const out: string[] = [];
  let next = 0;
  let dead = 0;
  const worker = async () => {
    while (next < todo.length) {
      const r = todo[next++];
      const [a, b] = await Promise.all([article(r.iaLink1), article(r.iaLink2)]);
      if (!a || !b) {
        dead++;
        continue;
      }
      const label = labelFor(r.overall, Number(values["same-max"] ?? 1.5), Number(values["different-min"] ?? 3.5));
      out.push(JSON.stringify({ pairId: r.pairId, a: r.link1, b: r.link2, overall: r.overall, label, article: { a, b } }));
      if (next % 100 === 0) console.log(`${next}/${todo.length} (${dead} dead)`);
    }
  };
  await Promise.all(Array.from({ length: Number(values.concurrency ?? 2) }, worker));
  writeFileSync(`${DIR}/semeval-pairs.jsonl`, out.join("\n") + "\n");
  console.log(`wrote ${out.length} pairs (${dead} skipped for dead pages) to ${DIR}/semeval-pairs.jsonl`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
