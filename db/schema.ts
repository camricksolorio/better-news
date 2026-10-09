import { sql } from "drizzle-orm";
import {
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
  },
  (table) => [
    // Close sweep, and window-fit candidate lookup. No index on centroid (D14).
    index("stories_status_window_ends_idx").on(table.status, table.windowEndsAt),
    index("stories_first_last_idx").on(table.firstArticleAt, table.lastArticleAt),
    check("stories_status_check", sql`${table.status} IN ('open', 'closed')`),
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
  },
  (table) => [
    uniqueIndex("feed_items_guid_idx").on(table.guid),
    index("feed_items_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    index("feed_items_story_id_idx").on(table.storyId),
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
  },
  (table) => [
    index("story_assignments_article_idx").on(table.articleId),
    index("story_assignments_story_idx").on(table.storyId),
    check(
      "story_assignments_method_check",
      sql`${table.method} IN ('embedding', 'llm', 'new_story', 'manual')`,
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
