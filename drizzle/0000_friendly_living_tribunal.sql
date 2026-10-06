CREATE TABLE IF NOT EXISTS "feed_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"guid" text NOT NULL,
	"title" text NOT NULL,
	"link" text NOT NULL,
	"summary" text,
	"image_url" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "feed_items_guid_idx" ON "feed_items" USING btree ("guid");