// The /api/embed stage (D27): embeds ingested rows and hands them to clustering through
// feed_items. It calls only the embedding API and never reads stories.
import { and, asc, count, eq, gte, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db/types";
import { feedItems } from "@/db/schema";
import { EMBEDDING_MODEL, EMBED_BATCH_SIZE } from "@/lib/llm-config";
import { CircuitOpenError, DeadlineError, type LlmClient } from "@/lib/llm";
import { EMBEDDING_INPUT_VERSION, buildEmbeddingInput, canonicalLink } from "@/lib/text";

export const MAX_EMBED_ATTEMPTS = 5;

export type EmbedOptions = {
  // Epoch ms after which no new batch starts.
  deadline: number;
  batchSize?: number;
  // Max rows to take in one call (an optional cap on top of the deadline).
  limit?: number;
  source?: string;
  from?: Date;
  to?: Date;
  now?: () => number;
  // Called after each batch; return false to stop (the lease was lost).
  afterBatch?: () => Promise<boolean>;
};

export type EmbedResult = { processed: number; remaining: number; failed: number };

function eligible(opts: Pick<EmbedOptions, "source" | "from" | "to">): SQL {
  const conditions: (SQL | undefined)[] = [
    isNull(feedItems.embedding),
    lt(feedItems.embedAttempts, MAX_EMBED_ATTEMPTS),
    or(isNull(feedItems.embedNextAttemptAt), lte(feedItems.embedNextAttemptAt, sql`now()`)),
    opts.source ? eq(feedItems.sourceId, opts.source) : undefined,
    opts.from ? gte(feedItems.publishedAt, opts.from) : undefined,
    opts.to ? lte(feedItems.publishedAt, opts.to) : undefined,
  ];
  return and(...conditions) as SQL;
}

export async function countRemaining(db: Db, opts: Pick<EmbedOptions, "source" | "from" | "to"> = {}) {
  const [row] = await db.select({ n: count() }).from(feedItems).where(eligible(opts));
  return row.n;
}

async function writeEmbeddings(db: Db, rows: { id: string; link: string }[], vectors: number[][]) {
  const values = rows.map(
    (row, i) =>
      sql`(${row.id}::uuid, ${JSON.stringify(vectors[i])}::text, ${canonicalLink(row.link)}::text)`,
  );
  await db.execute(sql`
    UPDATE feed_items AS f
    SET embedding = v.emb::vector,
        embedding_model = ${EMBEDDING_MODEL},
        embedding_input_version = ${EMBEDDING_INPUT_VERSION},
        canonical_link = v.canonical,
        embed_error = NULL,
        embed_next_attempt_at = NULL
    FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, emb, canonical)
    WHERE f.id = v.id
  `);
}

// A batch that exhausted its retries: count the attempt and back off (1h * 2^attempts, max 12h).
async function recordFailure(db: Db, ids: string[], error: string) {
  await db
    .update(feedItems)
    .set({
      embedAttempts: sql`${feedItems.embedAttempts} + 1`,
      embedError: error.slice(0, 500),
      embedNextAttemptAt: sql`now() + least(interval '1 hour' * power(2, ${feedItems.embedAttempts}), interval '12 hours')`,
    })
    .where(inArray(feedItems.id, ids));
}

export async function runEmbedStage(
  db: Db,
  llm: Pick<LlmClient, "embed">,
  opts: EmbedOptions,
): Promise<EmbedResult> {
  const now = opts.now ?? Date.now;
  const batchSize = opts.batchSize ?? EMBED_BATCH_SIZE;
  let processed = 0;
  let failed = 0;

  while (now() < opts.deadline && (opts.limit === undefined || processed + failed < opts.limit)) {
    const take = Math.min(batchSize, opts.limit === undefined ? batchSize : opts.limit - processed - failed);
    const rows = await db
      .select({ id: feedItems.id, title: feedItems.title, summary: feedItems.summary, link: feedItems.link })
      .from(feedItems)
      .where(eligible(opts))
      .orderBy(asc(feedItems.publishedAt), asc(feedItems.id))
      .limit(take);
    if (rows.length === 0) break;

    try {
      const { vectors } = await llm.embed({
        inputs: rows.map((r) => buildEmbeddingInput(r.title, r.summary)),
        purpose: "embed",
      });
      await writeEmbeddings(db, rows, vectors);
      processed += rows.length;
    } catch (e) {
      // Breaker open or out of time: leave the rows untouched for the next run.
      if (e instanceof CircuitOpenError || e instanceof DeadlineError) break;
      await recordFailure(db, rows.map((r) => r.id), (e as Error).message);
      failed += rows.length;
    }

    if (opts.afterBatch && !(await opts.afterBatch())) break;
  }

  return { processed, remaining: await countRemaining(db, opts), failed };
}
