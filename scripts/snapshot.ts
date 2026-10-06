// Freezes articles and their embeddings to eval/snapshot-YYYY-MM-DD.jsonl so all tuning runs
// against fixed data. Usage: pnpm eval:snapshot [--from 2026-09-29] [--to <ISO date>]
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { feedItems } from "@/db/schema";
import { EMBEDDING_MODEL } from "@/lib/llm-config";
import { parseVector } from "@/lib/pipeline/store-db";
import { isThin } from "@/lib/text";
import type { SnapshotArticle } from "@/lib/eval/replay";

async function main() {
  const { values } = parseArgs({ options: { from: { type: "string" }, to: { type: "string" } } });
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  // Full ingestion days start 2026-09-29; 9/27 is partial and 9/28 is nearly empty (see the plan).
  const from = new Date(values.from ?? "2026-09-29T00:00:00Z");
  const to = values.to ? new Date(values.to) : null;

  const client = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  const db = drizzle(client, { schema });
  const effective = sql`coalesce(${feedItems.publishedAt}, ${feedItems.createdAt})`;

  const rows = await db
    .select({
      guid: feedItems.guid,
      sourceId: feedItems.sourceId,
      title: feedItems.title,
      summary: feedItems.summary,
      time: effective,
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

  const lines = rows.map((r): string => {
    const article: SnapshotArticle = {
      guid: r.guid,
      sourceId: r.sourceId,
      title: r.title,
      summary: r.summary,
      time: new Date(r.time as unknown as string).toISOString(),
      thin: isThin(r.summary),
      embedding: parseVector(r.embedding),
    };
    return JSON.stringify(article);
  });
  const path = `eval/snapshot-${new Date().toISOString().slice(0, 10)}.jsonl`;
  writeFileSync(path, lines.join("\n") + "\n");
  console.log(`wrote ${lines.length} articles to ${path}`);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
