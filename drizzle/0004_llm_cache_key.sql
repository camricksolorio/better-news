ALTER TABLE "llm_calls" ADD COLUMN "cache_key" text;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "response" jsonb;--> statement-breakpoint
CREATE INDEX "llm_calls_cache_key_idx" ON "llm_calls" USING btree ("cache_key");