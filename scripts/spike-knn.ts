// Spike: does the window-filtered kNN stay accurate and fast on a large history? Loads real
// snapshot vectors plus synthetic noisy copies spread over ~100 days into a SCRATCH local database
// (never production), then compares the production query's results with exact search, with and
// without pgvector 0.8 iterative index scans.
// Usage: createdb better_news_spike && pnpm eval:knn [--rows 100000] [--queries 150]
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { SnapshotArticle } from "@/lib/eval/replay";
import { mulberry32 } from "@/lib/eval/pairs";

const URL = process.env.SPIKE_DATABASE_URL ?? "postgres://localhost:5432/better_news_spike";
const HOUR = 3_600_000;

async function main() {
  const { values } = parseArgs({ options: { rows: { type: "string" }, queries: { type: "string" } } });
  const rows = Number(values.rows ?? 100_000);
  const nQueries = Number(values.queries ?? 150);
  if (!/localhost|127\.0\.0\.1/.test(URL)) throw new Error("The spike only runs against a local scratch database");
  const sql = postgres(URL, { max: 2, onnotice: () => {} });

  const file = `eval/${readdirSync("eval").filter((f) => /^snapshot-.*\.jsonl$/.test(f)).sort().at(-1)}`;
  const real: SnapshotArticle[] = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

  await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public");
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });

  // History: `rows` articles over 100 days; the last 3 days are the real articles' vectors.
  const rand = mulberry32(5);
  const end = Date.UTC(2026, 9, 6);
  const start = end - 100 * 24 * HOUR;
  const norm = (v: number[]) => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)); return v.map((x) => x / n); };
  console.log(`loading ${rows} rows ...`);
  const t0 = Date.now();
  for (let off = 0; off < rows; off += 400) {
    const batch = Math.min(400, rows - off);
    const stories: unknown[][] = [];
    const items: unknown[][] = [];
    for (let k = 0; k < batch; k++) {
      const src = real[Math.floor(rand() * real.length)];
      const vec = norm(src.embedding.map((x) => x + (rand() - 0.5) * 0.05));
      const t = start + rand() * (end - start);
      const sid = randomUUID();
      const lit = JSON.stringify(vec);
      stories.push([sid, new Date(t).toISOString(), new Date(t + 36 * HOUR).toISOString(), lit]);
      items.push([randomUUID(), `s${off + k}`, `g${off + k}`, `t`, `https://x/${off + k}`, new Date(t).toISOString(), lit, sid]);
    }
    await sql.unsafe(
      `INSERT INTO stories (id, first_article_at, last_article_at, window_ends_at, centroid) VALUES ${stories.map((_, i) => `($${i * 4 + 1}::uuid,$${i * 4 + 2}::timestamptz,$${i * 4 + 2}::timestamptz,$${i * 4 + 3}::timestamptz,$${i * 4 + 4}::vector)`).join(",")}`,
      stories.flat() as never[],
    );
    await sql.unsafe(
      `INSERT INTO feed_items (id, source_id, guid, title, link, published_at, embedding, embedding_model, embedding_input_version, story_id, clustered_at) VALUES ${items.map((_, i) => `($${i * 8 + 1}::uuid,$${i * 8 + 2},$${i * 8 + 3},$${i * 8 + 4},$${i * 8 + 5},$${i * 8 + 6}::timestamptz,$${i * 8 + 7}::vector,'m','v1',$${i * 8 + 8}::uuid,now())`).join(",")}`,
      items.flat() as never[],
    );
  }
  await sql`ANALYZE feed_items`;
  await sql`ANALYZE stories`;
  console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // Queries: real vectors posted "now" (the last day), as the live pipeline would.
  const queries = Array.from({ length: nQueries }, () => {
    const a = real[Math.floor(rand() * real.length)];
    return { vec: JSON.stringify(a.embedding), t: new Date(end - rand() * 24 * HOUR).toISOString() };
  });

  const production = (vec: string, t: string) =>
    `SELECT f.id, 1 - (f.embedding <=> '${vec}'::vector) AS sim FROM feed_items f JOIN stories s ON s.id = f.story_id
     WHERE f.clustered_at IS NOT NULL AND s.last_article_at - interval '36 hours' <= '${t}'::timestamptz AND '${t}'::timestamptz <= s.window_ends_at
     ORDER BY f.embedding <=> '${vec}'::vector LIMIT 10`;

  async function run(setup: string[], exact = false) {
    const lat: number[] = [];
    const results: string[][] = [];
    for (const q of queries) {
      const out = await sql.begin(async (tx) => {
        for (const s of setup) await tx.unsafe(s);
        if (exact) { await tx.unsafe("SET LOCAL enable_indexscan = off"); await tx.unsafe("SET LOCAL enable_bitmapscan = off"); }
        const t = performance.now();
        const r = await tx.unsafe(production(q.vec, q.t));
        lat.push(performance.now() - t);
        return r.map((x) => x.id as string);
      });
      results.push(out);
    }
    lat.sort((a, b) => a - b);
    return { results, p50: lat[Math.floor(lat.length / 2)], p95: lat[Math.floor(lat.length * 0.95)] };
  }

  const truth = await run([], true);
  const fmt = (n: number) => n.toFixed(1);
  console.log(`\nexact (seq scan): p50 ${fmt(truth.p50)} ms, p95 ${fmt(truth.p95)} ms, mean rows ${fmt(truth.results.reduce((n, r) => n + r.length, 0) / nQueries)}`);
  const configs: [string, string[]][] = [
    ["HNSW default (ef_search 40, no iterative scan)", []],
    ["HNSW ef_search 200", ["SET LOCAL hnsw.ef_search = 200"]],
    ["HNSW iterative_scan = relaxed_order", ["SET LOCAL hnsw.iterative_scan = relaxed_order"]],
    ["HNSW iterative_scan = strict_order", ["SET LOCAL hnsw.iterative_scan = strict_order"]],
    ["relaxed_order + max_scan_tuples 100000", ["SET LOCAL hnsw.iterative_scan = relaxed_order", "SET LOCAL hnsw.max_scan_tuples = 100000"]],
  ];
  for (const [name, setup] of configs) {
    const r = await run(setup);
    let recall = 0;
    let rowsOut = 0;
    r.results.forEach((got, i) => {
      const want = new Set(truth.results[i]);
      recall += want.size === 0 ? 1 : got.filter((x) => want.has(x)).length / want.size;
      rowsOut += got.length;
    });
    console.log(`${name}: recall@10 ${(recall / nQueries).toFixed(3)}, mean rows ${fmt(rowsOut / nQueries)}, p50 ${fmt(r.p50)} ms, p95 ${fmt(r.p95)} ms`);
  }
  const plan = await sql.unsafe(`EXPLAIN ${production(queries[0].vec, queries[0].t)}`);
  console.log("\nplan (default settings):\n" + plan.map((r) => String(r["QUERY PLAN"]).replace(/'\[[^\]]*\]'/g, "'[vector]'")).join("\n"));
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
