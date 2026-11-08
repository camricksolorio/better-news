// Draws the events the owner will label (story-clustering-v2 Phase 2): 3 PRD examples plus a stratified random
// sample of permissive clusters, written to eval_events / eval_event_articles with the seed article as 'in'.
// Usage: pnpm eval:event-sample [--snapshot eval/snapshot-2026-10-24.jsonl] [--seed 1] [--min-cosine 0.92] [--confirm]
// Without --confirm it only prints the draw. Re-running with --confirm skips seeds that already have an event.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { inArray, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { buildComponents, sampleEvents, type SampleArticle } from "@/lib/eval/event-sample";

// The main story of each PRD example (see the PRD's Examples); the seed is that story's earliest article.
const EXAMPLE_STORIES = [
  { title: "Alaska DOJ lawsuit", storyPrefix: "78530a03" },
  { title: "Canada tariff rollback for Collins", storyPrefix: "7b0933a9" },
  { title: "Starlink slowdown (WSJ report)", storyPrefix: "992bf9fd" },
];

async function main() {
  const { values } = parseArgs({
    options: { snapshot: { type: "string" }, seed: { type: "string" }, "min-cosine": { type: "string" }, confirm: { type: "boolean" } },
  });
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const path = values.snapshot ?? "eval/snapshot-2026-10-24.jsonl";
  const articles: (SampleArticle & { title: string })[] = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const client = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  const db = drizzle(client, { schema });

  const examples: { title: string; seedGuid: string }[] = [];
  for (const ex of EXAMPLE_STORIES) {
    const rows = (await db.execute(sql`
      SELECT f.guid FROM feed_items f JOIN stories s ON s.id = f.story_id
      WHERE s.id::text LIKE ${ex.storyPrefix + "%"}
      ORDER BY f.first_published_at, f.guid`)) as unknown as { guid: string }[];
    const inSnapshot = rows.find((r) => articles.some((a) => a.guid === r.guid));
    if (!inSnapshot) throw new Error(`example "${ex.title}": no article of story ${ex.storyPrefix} is in the snapshot`);
    examples.push({ title: ex.title, seedGuid: inSnapshot.guid });
  }

  // 0.92, not the TDD's 0.85: at 0.85 chaining joins unrelated events into one 3,553-article cluster (the three PRD
  // examples land together); at 0.92 the largest is 68 articles.
  const components = buildComponents(articles, Number(values["min-cosine"] ?? 0.92));
  const picked = sampleEvents(components, {
    perStratum: { large: 9, mid: 9, small: 9 },
    seed: Number(values.seed ?? 1),
    examples,
  });

  const titleOf = new Map(articles.map((a) => [a.guid, a.title]));
  console.log(`${components.length} permissive clusters (${components.filter((c) => c.outlets >= 2).length} with 2+ outlets)`);
  console.table(
    picked.map((p) => ({
      event: p.example ? p.title : (titleOf.get(p.seed.guid) ?? "").slice(0, 60),
      stratum: p.stratum,
      outlets: p.outlets,
      articles: p.component.articles.length,
      split: p.split,
    })),
  );
  const bySplit = { dev: 0, holdout: 0 };
  for (const p of picked) bySplit[p.split]++;
  console.log(`${picked.length} events: ${bySplit.dev} dev, ${bySplit.holdout} holdout`);

  if (!values.confirm) {
    console.log("Dry run. Re-run with --confirm to write the events.");
  } else {
    const guids = picked.map((p) => p.seed.guid);
    const ids = new Map(
      (await db.select({ id: schema.feedItems.id, guid: schema.feedItems.guid }).from(schema.feedItems).where(inArray(schema.feedItems.guid, guids))).map((r) => [r.guid, r.id]),
    );
    const already = new Set(
      (await db.select({ articleId: schema.evalEventArticles.articleId }).from(schema.evalEventArticles)).map((r) => r.articleId),
    );
    let written = 0;
    for (const p of picked) {
      const articleId = ids.get(p.seed.guid);
      if (!articleId || already.has(articleId)) continue;
      const title = p.example ? p.title : (titleOf.get(p.seed.guid) ?? p.seed.guid).slice(0, 120);
      await db.transaction(async (tx) => {
        const [event] = await tx.insert(schema.evalEvents).values({ title, split: p.split, note: p.example ? "PRD example" : `sampled (${p.stratum})` }).returning({ id: schema.evalEvents.id });
        await tx.insert(schema.evalEventArticles).values({ eventId: event.id, articleId, label: "in", labeler: "sampler" });
      });
      written++;
    }
    console.log(`Wrote ${written} events (${picked.length - written} already existed).`);
  }
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
