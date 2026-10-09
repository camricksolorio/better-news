ALTER TABLE "feed_items" ADD COLUMN "cluster_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "cluster_error" text;--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "cluster_next_attempt_at" timestamp with time zone;