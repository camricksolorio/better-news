CREATE TABLE "article_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"published_at" timestamp with time zone,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "article_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "candidate_pairs" (
	"a_id" uuid NOT NULL,
	"b_id" uuid NOT NULL,
	"cosine" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_pairs_a_id_b_id_pk" PRIMARY KEY("a_id","b_id"),
	CONSTRAINT "candidate_pairs_order_check" CHECK ("candidate_pairs"."a_id" < "candidate_pairs"."b_id")
);
--> statement-breakpoint
ALTER TABLE "candidate_pairs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "consolidation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mode" text NOT NULL,
	"scope_from" timestamp with time zone,
	"scope_to" timestamp with time zone,
	"pipeline_version" text NOT NULL,
	"phase" text DEFAULT 'retrieve' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone,
	"stats" jsonb,
	"reverted_by" uuid,
	CONSTRAINT "consolidation_runs_mode_check" CHECK ("consolidation_runs"."mode" IN ('scheduled', 'repair', 'revert')),
	CONSTRAINT "consolidation_runs_phase_check" CHECK ("consolidation_runs"."phase" IN ('retrieve', 'judge', 'consolidate', 'committed', 'abandoned'))
);
--> statement-breakpoint
ALTER TABLE "consolidation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "eval_event_articles" (
	"event_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"label" text NOT NULL,
	"labeler" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_event_articles_event_id_article_id_pk" PRIMARY KEY("event_id","article_id"),
	CONSTRAINT "eval_event_articles_label_check" CHECK ("eval_event_articles"."label" IN ('in', 'related', 'out'))
);
--> statement-breakpoint
ALTER TABLE "eval_event_articles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "eval_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"note" text,
	"split" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_events_split_check" CHECK ("eval_events"."split" IN ('dev', 'holdout'))
);
--> statement-breakpoint
ALTER TABLE "eval_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pair_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_a" uuid NOT NULL,
	"version_b" uuid NOT NULL,
	"article_a" uuid NOT NULL,
	"article_b" uuid NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"relation" text NOT NULL,
	"p_same" double precision NOT NULL,
	"cosine" double precision,
	"llm_call_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pair_verdicts_order_check" CHECK ("pair_verdicts"."version_a" < "pair_verdicts"."version_b"),
	CONSTRAINT "pair_verdicts_relation_check" CHECK ("pair_verdicts"."relation" IN ('same', 'related', 'different', 'invalid'))
);
--> statement-breakpoint
ALTER TABLE "pair_verdicts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stories" DROP CONSTRAINT "stories_status_check";--> statement-breakpoint
ALTER TABLE "story_assignments" DROP CONSTRAINT "story_assignments_method_check";--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "excluded_reason" text;--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "current_version_id" uuid;--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "embedding_version_id" uuid;--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "pairs_version_id" uuid;--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "first_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "placed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "merged_into" uuid;--> statement-breakpoint
ALTER TABLE "story_assignments" ADD COLUMN "from_story_id" uuid;--> statement-breakpoint
ALTER TABLE "story_assignments" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "story_assignments" ADD COLUMN "article_version_id" uuid;--> statement-breakpoint
ALTER TABLE "story_assignments" ADD COLUMN "evidence" jsonb;--> statement-breakpoint
ALTER TABLE "article_versions" ADD CONSTRAINT "article_versions_article_id_feed_items_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."feed_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_pairs" ADD CONSTRAINT "candidate_pairs_a_id_feed_items_id_fk" FOREIGN KEY ("a_id") REFERENCES "public"."feed_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_pairs" ADD CONSTRAINT "candidate_pairs_b_id_feed_items_id_fk" FOREIGN KEY ("b_id") REFERENCES "public"."feed_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_runs" ADD CONSTRAINT "consolidation_runs_reverted_by_consolidation_runs_id_fk" FOREIGN KEY ("reverted_by") REFERENCES "public"."consolidation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_event_articles" ADD CONSTRAINT "eval_event_articles_event_id_eval_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."eval_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_event_articles" ADD CONSTRAINT "eval_event_articles_article_id_feed_items_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."feed_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_verdicts" ADD CONSTRAINT "pair_verdicts_version_a_article_versions_id_fk" FOREIGN KEY ("version_a") REFERENCES "public"."article_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_verdicts" ADD CONSTRAINT "pair_verdicts_version_b_article_versions_id_fk" FOREIGN KEY ("version_b") REFERENCES "public"."article_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_verdicts" ADD CONSTRAINT "pair_verdicts_article_a_feed_items_id_fk" FOREIGN KEY ("article_a") REFERENCES "public"."feed_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_verdicts" ADD CONSTRAINT "pair_verdicts_article_b_feed_items_id_fk" FOREIGN KEY ("article_b") REFERENCES "public"."feed_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_verdicts" ADD CONSTRAINT "pair_verdicts_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "article_versions_article_hash_idx" ON "article_versions" USING btree ("article_id","content_hash");--> statement-breakpoint
CREATE INDEX "candidate_pairs_b_idx" ON "candidate_pairs" USING btree ("b_id");--> statement-breakpoint
CREATE INDEX "consolidation_runs_started_idx" ON "consolidation_runs" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_verdicts_key_idx" ON "pair_verdicts" USING btree ("version_a","version_b","model","prompt_version");--> statement-breakpoint
CREATE INDEX "pair_verdicts_article_a_idx" ON "pair_verdicts" USING btree ("article_a");--> statement-breakpoint
CREATE INDEX "pair_verdicts_article_b_idx" ON "pair_verdicts" USING btree ("article_b");--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_current_version_id_article_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."article_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_embedding_version_id_article_versions_id_fk" FOREIGN KEY ("embedding_version_id") REFERENCES "public"."article_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_pairs_version_id_article_versions_id_fk" FOREIGN KEY ("pairs_version_id") REFERENCES "public"."article_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_merged_into_stories_id_fk" FOREIGN KEY ("merged_into") REFERENCES "public"."stories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_assignments" ADD CONSTRAINT "story_assignments_from_story_id_stories_id_fk" FOREIGN KEY ("from_story_id") REFERENCES "public"."stories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_assignments" ADD CONSTRAINT "story_assignments_run_id_consolidation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."consolidation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_assignments" ADD CONSTRAINT "story_assignments_article_version_id_article_versions_id_fk" FOREIGN KEY ("article_version_id") REFERENCES "public"."article_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feed_items_first_published_idx" ON "feed_items" USING btree ("first_published_at") WHERE "feed_items"."excluded_reason" IS NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_merged_check" CHECK (("stories"."status" = 'merged') = ("stories"."merged_into" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_status_check" CHECK ("stories"."status" IN ('open', 'closed', 'merged'));--> statement-breakpoint
ALTER TABLE "story_assignments" ADD CONSTRAINT "story_assignments_method_check" CHECK ("story_assignments"."method" IN ('embedding', 'llm', 'new_story', 'manual', 'consolidate', 'repair', 'revert', 'exclude'));--> statement-breakpoint
-- Hand-written from here (the generated part above is drizzle-kit output).
-- Backfill: one version per existing article from its current text, hashed exactly as lib/content-hash.ts does
-- (sha256 of title + newline + summary as stored), so the first ingest after this migration finds no changed text.
INSERT INTO "article_versions" ("article_id", "title", "summary", "published_at", "content_hash")
SELECT "id", "title", "summary", "published_at",
       encode(sha256(convert_to("title" || E'\n' || coalesce("summary", ''), 'UTF8')), 'hex')
FROM "feed_items";
--> statement-breakpoint
-- Existing vectors were built from the only text we have, so they belong to the one version.
UPDATE "feed_items" f
SET "first_published_at" = coalesce(f."published_at", f."created_at"),
    "placed_at" = f."clustered_at",
    "content_hash" = v."content_hash",
    "current_version_id" = v."id",
    "embedding_version_id" = CASE WHEN f."embedding" IS NOT NULL THEN v."id" END
FROM "article_versions" v
WHERE v."article_id" = f."id";
--> statement-breakpoint
ALTER TABLE "feed_items" ALTER COLUMN "first_published_at" SET NOT NULL;
--> statement-breakpoint
-- The clustering time is set once at insert from the feed's own date, else the first-seen time.
CREATE FUNCTION feed_items_set_first_published() RETURNS trigger AS $$
BEGIN
  NEW.first_published_at := coalesce(NEW.first_published_at, NEW.published_at, NEW.created_at);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER feed_items_set_first_published_trg
  BEFORE INSERT ON feed_items
  FOR EACH ROW EXECUTE FUNCTION feed_items_set_first_published();
--> statement-breakpoint
-- Story status transitions (replaces the D24 trigger): a closed story is never reopened; open and closed stories can
-- be retired into another story ('merged'); only a revert run undoes a merge (it sets better_news.revert = 'on').
CREATE OR REPLACE FUNCTION stories_reject_reopen() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'closed' AND NEW.status = 'open' THEN
    RAISE EXCEPTION 'stories: a closed story cannot be reopened (id %)', OLD.id;
  END IF;
  IF OLD.status = 'merged' AND NEW.status <> 'merged'
     AND coalesce(current_setting('better_news.revert', true), '') <> 'on' THEN
    RAISE EXCEPTION 'stories: a merged story can only be restored by a revert run (id %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
