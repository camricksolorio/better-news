CREATE TABLE "eval_pair_labels" (
	"article_a" uuid NOT NULL,
	"article_b" uuid NOT NULL,
	"label" text NOT NULL,
	"labeler" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_pair_labels_article_a_article_b_labeler_pk" PRIMARY KEY("article_a","article_b","labeler"),
	CONSTRAINT "eval_pair_labels_label_check" CHECK ("eval_pair_labels"."label" IN ('same', 'related', 'different', 'unsure')),
	CONSTRAINT "eval_pair_labels_order_check" CHECK ("eval_pair_labels"."article_a" < "eval_pair_labels"."article_b")
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" double precision,
	"latency_ms" integer,
	"ok" boolean NOT NULL,
	"error" text,
	"story_id" uuid,
	"article_id" uuid
);
--> statement-breakpoint
CREATE TABLE "pipeline_locks" (
	"name" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"locked_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stage" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"processed" integer,
	"remaining" integer,
	"failed" integer,
	"error" text,
	CONSTRAINT "pipeline_runs_stage_check" CHECK ("pipeline_runs"."stage" IN ('embed', 'cluster'))
);
--> statement-breakpoint
CREATE TABLE "stories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_article_at" timestamp with time zone NOT NULL,
	"last_article_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"window_ends_at" timestamp with time zone NOT NULL,
	"centroid" vector(768) NOT NULL,
	"article_count" integer DEFAULT 1 NOT NULL,
	"source_count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "stories_status_check" CHECK ("stories"."status" IN ('open', 'closed')),
	CONSTRAINT "stories_span_check" CHECK ("stories"."first_article_at" <= "stories"."last_article_at"),
	CONSTRAINT "stories_window_check" CHECK ("stories"."window_ends_at" >= "stories"."last_article_at")
);
--> statement-breakpoint
CREATE TABLE "story_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"story_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"method" text NOT NULL,
	"top_score" double precision,
	"centroid_score" double precision,
	"llm_call_id" uuid,
	"llm_verdict" jsonb,
	"pipeline_version" text,
	CONSTRAINT "story_assignments_method_check" CHECK ("story_assignments"."method" IN ('embedding', 'llm', 'new_story', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "embedding" vector(768);--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "embedding_input_version" text;--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "embed_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "embed_error" text;--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "embed_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "canonical_link" text;--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "story_id" uuid;--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "clustered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "eval_pair_labels" ADD CONSTRAINT "eval_pair_labels_article_a_feed_items_id_fk" FOREIGN KEY ("article_a") REFERENCES "public"."feed_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_pair_labels" ADD CONSTRAINT "eval_pair_labels_article_b_feed_items_id_fk" FOREIGN KEY ("article_b") REFERENCES "public"."feed_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_article_id_feed_items_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."feed_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_assignments" ADD CONSTRAINT "story_assignments_article_id_feed_items_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."feed_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_assignments" ADD CONSTRAINT "story_assignments_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_assignments" ADD CONSTRAINT "story_assignments_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_runs_stage_started_idx" ON "pipeline_runs" USING btree ("stage","started_at");--> statement-breakpoint
CREATE INDEX "stories_status_window_ends_idx" ON "stories" USING btree ("status","window_ends_at");--> statement-breakpoint
CREATE INDEX "stories_first_last_idx" ON "stories" USING btree ("first_article_at","last_article_at");--> statement-breakpoint
CREATE INDEX "story_assignments_article_idx" ON "story_assignments" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "story_assignments_story_idx" ON "story_assignments" USING btree ("story_id");--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feed_items_embedding_hnsw_idx" ON "feed_items" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "feed_items_story_id_idx" ON "feed_items" USING btree ("story_id");--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_clustered_check" CHECK ("feed_items"."clustered_at" IS NULL OR ("feed_items"."embedding" IS NOT NULL AND "feed_items"."story_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_embedding_meta_check" CHECK ("feed_items"."embedding" IS NULL OR ("feed_items"."embedding_model" IS NOT NULL AND "feed_items"."embedding_input_version" IS NOT NULL));