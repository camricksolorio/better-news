// Freezes articles and their embeddings to eval/snapshot-YYYY-MM-DD.jsonl so all tuning runs
// against fixed data. Usage: pnpm eval:snapshot [--from 2026-09-29] [--to <ISO date>] [--out eval/snapshot-2026-10-24.jsonl]
// `time` is first_published_at. Excluded rows (live blogs) are included and flagged, so the replay can skip them.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { feedItems } from "@/db/schema";
import { EMBEDDING_MODEL } from "@/lib/llm-config";
import { toSnapshotArticle } from "@/lib/eval/snapshot";

async function main() {
  const { values } = parseArgs({ options: { from: { type: "string" }, to: { type: "string" }, out: { type: "string" } } });
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  // Full ingestion days start 2026-09-29; 9/27 is partial and 9/28 is nearly empty (see the plan).
  const from = new Date(values.from ?? "2026-09-29T00:00:00Z");
  const to = values.to ? new Date(values.to) : null;

  const client = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  const db = drizzle(client, { schema });
  const effective = feedItems.firstPublishedAt;

  const rows = await db
    .select({
      guid: feedItems.guid,
      sourceId: feedItems.sourceId,
      title: feedItems.title,
      summary: feedItems.summary,
      firstPublishedAt: feedItems.firstPublishedAt,
      createdAt: feedItems.createdAt,
      versionId: feedItems.currentVersionId,
      excludedReason: feedItems.excludedReason,
      embedding: feedItems.embedding,
    })
    .from(feedItems)
    .where(
      and(
        isNotNull(feedItems.embedding),
        eq(feedItems.embeddingModel, EMBEDDING_MODEL),
        sql`${effective} >= ${from.toISOString()}::timestamptz`,
        to ? sql`${effective} < ${to.toISOString()}::timestamptz` : undefined,
      ),
    )
    .orderBy(asc(effective), asc(feedItems.guid));

  const lines = rows.map((r) => JSON.stringify(toSnapshotArticle(r)));
  const path = values.out ?? `eval/snapshot-${new Date().toISOString().slice(0, 10)}.jsonl`;
  writeFileSync(path, lines.join("\n") + "\n");
  console.log(`wrote ${lines.length} articles to ${path}`);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
