ALTER TABLE "llm_calls" ADD COLUMN "input_count" integer;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "quota_id" text;