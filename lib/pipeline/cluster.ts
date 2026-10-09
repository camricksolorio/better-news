// The /api/cluster stage (D27): assigns embedded, unclustered articles to stories using
// stored vectors only. It never calls the embedding API.
import { and, asc, count, eq, isNotNull, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db/types";
import { feedItems, stories } from "@/db/schema";
import { CircuitOpenError, DeadlineError, QuotaExhaustedError } from "@/lib/llm";
import { isThin } from "@/lib/text";
import {
  DEFAULT_CLUSTER_CONFIG,
  assignArticle,
  pipelineVersion,
  type Adjudicator,
  type ClusterConfig,
} from "./assign";
import { createDbStore, parseVector } from "./store-db";

export const MAX_CLUSTER_ATTEMPTS = 5;

export type ClusterOptions = {
  deadline: number;
  config?: ClusterConfig;
  adjudicate?: Adjudicator;
  limit?: number;
  source?: string;
  from?: Date;
  to?: Date;
  now?: () => number;
  // Called after each article; return false to stop (the lease was lost).
  afterArticle?: () => Promise<boolean>;
  // Backfill mode: run the close sweep only once nothing remains.
  deferCloseSweep?: boolean;
};

export type ClusterResult = { processed: number; remaining: number; failed: number; closed: number };

function pending(model: string, opts: Pick<ClusterOptions, "source" | "from" | "to">): SQL {
  const effective = sql`coalesce(${feedItems.publishedAt}, ${feedItems.createdAt})`;
  return and(
    isNotNull(feedItems.embedding),
    isNull(feedItems.clusteredAt),
    eq(feedItems.embeddingModel, model),
    lt(feedItems.clusterAttempts, MAX_CLUSTER_ATTEMPTS),
    or(isNull(feedItems.clusterNextAttemptAt), lte(feedItems.clusterNextAttemptAt, sql`now()`)),
    opts.source ? eq(feedItems.sourceId, opts.source) : undefined,
    opts.from ? sql`${effective} >= ${opts.from.toISOString()}::timestamptz` : undefined,
    opts.to ? sql`${effective} <= ${opts.to.toISOString()}::timestamptz` : undefined,
  ) as SQL;
}

export async function countPending(db: Db, model: string, opts: Pick<ClusterOptions, "source" | "from" | "to"> = {}) {
  const [row] = await db.select({ n: count() }).from(feedItems).where(pending(model, opts));
  return row.n;
}

// An article whose assignment failed after retries: count the attempt and back off (1h * 2^attempts, max 12h),
// as the embed stage does, so a poison article is not retried on every call.
async function recordFailure(db: Db, id: string, error: string) {
  await db
    .update(feedItems)
    .set({
      clusterAttempts: sql`${feedItems.clusterAttempts} + 1`,
      clusterError: error.slice(0, 500),
      clusterNextAttemptAt: sql`now() + least(interval '1 hour' * power(2, ${feedItems.clusterAttempts}), interval '12 hours')`,
    })
    .where(eq(feedItems.id, id));
}

// Open stories whose window has passed become closed (D18). Closed stories stay candidates.
export async function closeExpiredStories(db: Db): Promise<number> {
  const rows = await db
    .update(stories)
    .set({ status: "closed" })
    .where(and(eq(stories.status, "open"), sql`${stories.windowEndsAt} < now()`))
    .returning({ id: stories.id });
  return rows.length;
}

export async function runClusterStage(db: Db, opts: ClusterOptions): Promise<ClusterResult> {
  const cfg = opts.config ?? DEFAULT_CLUSTER_CONFIG;
  const now = opts.now ?? Date.now;
  const version = pipelineVersion(cfg);
  const effective = sql<Date>`coalesce(${feedItems.publishedAt}, ${feedItems.createdAt})`;
  let processed = 0;
  let failed = 0;
  const skipped = new Set<string>();

  while (now() < opts.deadline && (opts.limit === undefined || processed + failed < opts.limit)) {
    const rows = await db
      .select({
        id: feedItems.id,
        sourceId: feedItems.sourceId,
        summary: feedItems.summary,
        embedding: feedItems.embedding,
        time: effective,
      })
      .from(feedItems)
      .where(pending(cfg.model, opts))
      .orderBy(asc(effective), asc(feedItems.id))
      .limit(1 + skipped.size);
    const row = rows.find((r) => !skipped.has(r.id));
    if (!row) break;

    try {
      // One transaction per article: story write, article mark, and decision log commit together.
      await db.transaction(async (tx) => {
        const store = createDbStore(tx as unknown as Db, version);
        await assignArticle(
          store,
          {
            id: row.id,
            sourceId: row.sourceId,
            time: new Date(row.time),
            embedding: parseVector(row.embedding),
            thin: isThin(row.summary),
          },
          cfg,
          opts.adjudicate,
        );
      });
      processed++;
    } catch (e) {
      // Breaker open, daily quota spent, or out of time: not this article's fault. Leave it untouched and stop.
      if (e instanceof CircuitOpenError || e instanceof DeadlineError || e instanceof QuotaExhaustedError) break;
      // A bad row must not block the rest. It backs off (and is excluded from the next selection); if even that
      // write fails, skip it for this run so the loop cannot spin on it.
      skipped.add(row.id);
      failed++;
      await recordFailure(db, row.id, e instanceof Error ? e.message : String(e)).catch(() => {});
    }

    if (opts.afterArticle && !(await opts.afterArticle())) break;
  }

  const remaining = await countPending(db, cfg.model, opts);
  const sweep = opts.deferCloseSweep ? remaining === 0 : true;
  const closed = sweep ? await closeExpiredStories(db) : 0;
  return { processed, remaining, failed, closed };
}
