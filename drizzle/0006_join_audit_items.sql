CREATE TABLE "join_audit_items" (
	"audit_id" text NOT NULL,
	"article_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"verdict" jsonb,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "join_audit_items_audit_id_article_id_member_id_pk" PRIMARY KEY("audit_id","article_id","member_id"),
	CONSTRAINT "join_audit_items_distinct_check" CHECK ("join_audit_items"."article_id" <> "join_audit_items"."member_id")
);
--> statement-breakpoint
ALTER TABLE "join_audit_items" ADD CONSTRAINT "join_audit_items_article_id_feed_items_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."feed_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_audit_items" ADD CONSTRAINT "join_audit_items_member_id_feed_items_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."feed_items"("id") ON DELETE no action ON UPDATE no action;