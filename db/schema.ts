import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
  boolean,
} from "drizzle-orm/pg-core";

export const EMBEDDING_DIMENSIONS = 768;

export const stories = pgTable(
  "stories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    firstArticleAt: timestamp("first_article_at", { withTimezone: true }).notNull(),
    lastArticleAt: timestamp("last_article_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("open"),
    windowEndsAt: timestamp("window_ends_at", { withTimezone: true }).notNull(),
    centroid: vector("centroid", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    articleCount: integer("article_count").notNull().default(1),
    sourceCount: integer("source_count").notNull().default(1),
    // v2: a story emptied by consolidation is retired into the story that took its members.
    mergedInto: uuid("merged_into").references((): AnyPgColumn => stories.id),
  },
  (table) => [
    // Close sweep, and window-fit candidate lookup. No index on centroid (D14).
    index("stories_status_window_ends_idx").on(table.status, table.windowEndsAt),
    index("stories_first_last_idx").on(table.firstArticleAt, table.lastArticleAt),
    check("stories_status_check", sql`${table.status} IN ('open', 'closed', 'merged')`),
    check("stories_merged_check", sql`(${table.status} = 'merged') = (${table.mergedInto} IS NOT NULL)`),
    check("stories_span_check", sql`${table.firstArticleAt} <= ${table.lastArticleAt}`),
    check("stories_window_check", sql`${table.windowEndsAt} >= ${table.lastArticleAt}`),
  ],
).enableRLS();

export const feedItems = pgTable(
  "feed_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceId: text("source_id").notNull(),
    guid: text("guid").notNull(),
    title: text("title").notNull(),
    link: text("link").notNull(),
    summary: text("summary"),
    imageUrl: text("image_url"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),

    // Embed stage (D27)
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    embeddingModel: text("embedding_model"),
    embeddingInputVersion: text("embedding_input_version"),
    embedAttempts: integer("embed_attempts").notNull().default(0),
    embedError: text("embed_error"),
    embedNextAttemptAt: timestamp("embed_next_attempt_at", { withTimezone: true }),
    canonicalLink: text("canonical_link"),

    // Cluster stage
    storyId: uuid("story_id").references(() => stories.id),
    clusteredAt: timestamp("clustered_at", { withTimezone: true }),
    // Same retry tracking as the embed stage: a failed article backs off, and after 5 attempts leaves the queue.
    clusterAttempts: integer("cluster_attempts").notNull().default(0),
    clusterError: text("cluster_error"),
    clusterNextAttemptAt: timestamp("cluster_next_attempt_at", { withTimezone: true }),

    // v2 (story-clustering-v2 TDD part 9)
    // 'live_blog' for items dropped from clustering; never embedded, retrieved or clustered.
    excludedReason: text("excluded_reason"),
    // sha256 of title + "\n" + summary as stored (see lib/content-hash.ts); a new hash makes a new version.
    contentHash: text("content_hash"),
    currentVersionId: uuid("current_version_id").references((): AnyPgColumn => articleVersions.id),
    embeddingVersionId: uuid("embedding_version_id").references((): AnyPgColumn => articleVersions.id),
    pairsVersionId: uuid("pairs_version_id").references((): AnyPgColumn => articleVersions.id),
    // Clustering time: set once at insert (a trigger fills it from published_at, else created_at), never updated.
    // "default NULL" only makes the column optional in inserts; the trigger turns the NULL into a time.
    firstPublishedAt: timestamp("first_published_at", { withTimezone: true })
      .notNull()
      .default(sql`NULL`),
    // First time the article was placed in any story (reader-safety rule 1).
    placedAt: timestamp("placed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("feed_items_guid_idx").on(table.guid),
    index("feed_items_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    index("feed_items_story_id_idx").on(table.storyId),
    index("feed_items_first_published_idx")
      .on(table.firstPublishedAt)
      .where(sql`${table.excludedReason} IS NULL`),
    check(
      "feed_items_clustered_check",
      sql`${table.clusteredAt} IS NULL OR (${table.embedding} IS NOT NULL AND ${table.storyId} IS NOT NULL)`,
    ),
    check(
      "feed_items_embedding_meta_check",
      sql`${table.embedding} IS NULL OR (${table.embeddingModel} IS NOT NULL AND ${table.embeddingInputVersion} IS NOT NULL)`,
    ),
  ],
).enableRLS();

export const llmCalls = pgTable(
  "llm_calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    purpose: text("purpose").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: doublePrecision("cost_usd"),
    latencyMs: integer("latency_ms"),
    ok: boolean("ok").notNull(),
    error: text("error"),
    storyId: uuid("story_id").references(() => stories.id),
    articleId: uuid("article_id").references(() => feedItems.id),
    // Verdict cache (D13): chat calls with a cache key store their parsed response here.
    cacheKey: text("cache_key"),
    response: jsonb("response"),
    // Usage ledger: how many inputs a call carried (the Gemini free tier counts each input
    // against its request quotas), and which quota a 429 named.
    inputCount: integer("input_count"),
    quotaId: text("quota_id"),
  },
  (table) => [index("llm_calls_cache_key_idx").on(table.cacheKey)],
).enableRLS();

// Append-only decision log (D10, D24); a trigger rejects UPDATE and DELETE.
export const storyAssignments = pgTable(
  "story_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => feedItems.id),
    storyId: uuid("story_id")
      .notNull()
      .references(() => stories.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    method: text("method").notNull(),
    topScore: doublePrecision("top_score"),
    centroidScore: doublePrecision("centroid_score"),
    llmCallId: uuid("llm_call_id").references(() => llmCalls.id),
    llmVerdict: jsonb("llm_verdict"),
    pipelineVersion: text("pipeline_version"),
    // v2: where the article came from, the run that moved it, the text the decision used, and why.
    fromStoryId: uuid("from_story_id").references(() => stories.id),
    runId: uuid("run_id").references((): AnyPgColumn => consolidationRuns.id),
    articleVersionId: uuid("article_version_id").references((): AnyPgColumn => articleVersions.id),
    evidence: jsonb("evidence"),
  },
  (table) => [
    index("story_assignments_article_idx").on(table.articleId),
    index("story_assignments_story_idx").on(table.storyId),
    check(
      "story_assignments_method_check",
      sql`${table.method} IN ('embedding', 'llm', 'new_story', 'manual', 'consolidate', 'repair', 'revert', 'exclude')`,
    ),
  ],
).enableRLS();

// Human and silver labels; durable, exported to the repo (D26).
export const evalPairLabels = pgTable(
  "eval_pair_labels",
  {
    articleA: uuid("article_a")
      .notNull()
      .references(() => feedItems.id),
    articleB: uuid("article_b")
      .notNull()
      .references(() => feedItems.id),
    label: text("label").notNull(),
    labeler: text("labeler").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.articleA, table.articleB, table.labeler] }),
    check(
      "eval_pair_labels_label_check",
      sql`${table.label} IN ('same', 'related', 'different', 'unsure')`,
    ),
    check("eval_pair_labels_order_check", sql`${table.articleA} < ${table.articleB}`),
  ],
).enableRLS();

// The join audit (D37): a random sample of joins from a replay, each one an article and the story member it was
// judged against. Labels go to eval_pair_labels like any human label; this table only says which pairs to review.
export const joinAuditItems = pgTable(
  "join_audit_items",
  {
    auditId: text("audit_id").notNull(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => feedItems.id),
    memberId: uuid("member_id")
      .notNull()
      .references(() => feedItems.id),
    // Random display order, so a reviewer who stops early has still seen a random subset.
    position: integer("position").notNull(),
    // The classifier's verdicts for this join. Not shown to the reviewer.
    verdict: jsonb("verdict"),
    sampledAt: timestamp("sampled_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.auditId, table.articleId, table.memberId] }),
    check("join_audit_items_distinct_check", sql`${table.articleId} <> ${table.memberId}`),
  ],
).enableRLS();

// v2 tables. Every distinct title + summary an article has had; decisions record the version they used.
export const articleVersions = pgTable(
  "article_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    articleId: uuid("article_id")
      .notNull()
      .references((): AnyPgColumn => feedItems.id),
    title: text("title").notNull(),
    summary: text("summary"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("article_versions_article_hash_idx").on(table.articleId, table.contentHash)],
).enableRLS();

// Article pairs close in embedding space (a_id < b_id); the judge decides which of them are the same event.
export const candidatePairs = pgTable(
  "candidate_pairs",
  {
    aId: uuid("a_id")
      .notNull()
      .references(() => feedItems.id),
    bId: uuid("b_id")
      .notNull()
      .references(() => feedItems.id),
    cosine: doublePrecision("cosine").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.aId, table.bId] }),
    index("candidate_pairs_b_idx").on(table.bId),
    check("candidate_pairs_order_check", sql`${table.aId} < ${table.bId}`),
  ],
).enableRLS();

// One classifier verdict per pair of article versions, model and prompt version (the cache the consolidation reads).
export const pairVerdicts = pgTable(
  "pair_verdicts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    versionA: uuid("version_a")
      .notNull()
      .references(() => articleVersions.id),
    versionB: uuid("version_b")
      .notNull()
      .references(() => articleVersions.id),
    articleA: uuid("article_a")
      .notNull()
      .references(() => feedItems.id),
    articleB: uuid("article_b")
      .notNull()
      .references(() => feedItems.id),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    relation: text("relation").notNull(),
    pSame: doublePrecision("p_same").notNull(),
    cosine: doublePrecision("cosine"),
    llmCallId: uuid("llm_call_id").references(() => llmCalls.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("pair_verdicts_key_idx").on(table.versionA, table.versionB, table.model, table.promptVersion),
    index("pair_verdicts_article_a_idx").on(table.articleA),
    index("pair_verdicts_article_b_idx").on(table.articleB),
    check("pair_verdicts_order_check", sql`${table.versionA} < ${table.versionB}`),
    check("pair_verdicts_relation_check", sql`${table.relation} IN ('same', 'related', 'different', 'invalid')`),
  ],
).enableRLS();

export const consolidationRuns = pgTable(
  "consolidation_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    mode: text("mode").notNull(),
    scopeFrom: timestamp("scope_from", { withTimezone: true }),
    scopeTo: timestamp("scope_to", { withTimezone: true }),
    pipelineVersion: text("pipeline_version").notNull(),
    phase: text("phase").notNull().default("retrieve"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    stats: jsonb("stats"),
    revertedBy: uuid("reverted_by").references((): AnyPgColumn => consolidationRuns.id),
  },
  (table) => [
    check("consolidation_runs_mode_check", sql`${table.mode} IN ('scheduled', 'repair', 'revert')`),
    check(
      "consolidation_runs_phase_check",
      sql`${table.phase} IN ('retrieve', 'judge', 'consolidate', 'committed', 'abandoned')`,
    ),
    index("consolidation_runs_started_idx").on(table.startedAt),
  ],
).enableRLS();

// Human-labelled real events: the evaluation set (R1).
export const evalEvents = pgTable(
  "eval_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: text("title").notNull(),
    note: text("note"),
    split: text("split").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [check("eval_events_split_check", sql`${table.split} IN ('dev', 'holdout')`)],
).enableRLS();

export const evalEventArticles = pgTable(
  "eval_event_articles",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => evalEvents.id),
    articleId: uuid("article_id")
      .notNull()
      .references(() => feedItems.id),
    label: text("label").notNull(),
    labeler: text("labeler").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.articleId] }),
    check("eval_event_articles_label_check", sql`${table.label} IN ('in', 'related', 'out')`),
  ],
).enableRLS();

// Single-flight lease per endpoint (D22).
export const pipelineLocks = pgTable("pipeline_locks", {
  name: text("name").primaryKey(),
  owner: text("owner").notNull(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }).notNull(),
}).enableRLS();

export const pipelineRuns = pgTable(
  "pipeline_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    stage: text("stage").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    processed: integer("processed"),
    remaining: integer("remaining"),
    failed: integer("failed"),
    error: text("error"),
  },
  (table) => [
    index("pipeline_runs_stage_started_idx").on(table.stage, table.startedAt),
    check("pipeline_runs_stage_check", sql`${table.stage} IN ('embed', 'cluster')`),
  ],
).enableRLS();

export type FeedItem = typeof feedItems.$inferSelect;
export type NewFeedItem = typeof feedItems.$inferInsert;
export type Story = typeof stories.$inferSelect;
export type ArticleVersion = typeof articleVersions.$inferSelect;
