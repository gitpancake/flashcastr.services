-- HEN-587 hotfix: 0005, 0006, 0007 were silently skipped on prod despite
-- "Agent DB migrations up to date" log. Re-apply their DDL idempotently.
-- All statements use IF NOT EXISTS so this is safe to run on any DB state.

-- From 0005_add_seen_urls.sql
CREATE TABLE IF NOT EXISTS "flashcastr_seen_urls" (
	"url" text PRIMARY KEY NOT NULL,
	"source_label" text NOT NULL,
	"classification" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_hash" text,
	"last_summary" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flashcastr_seen_urls_label_idx" ON "flashcastr_seen_urls" USING btree ("source_label");
--> statement-breakpoint

-- From 0006_add_external_news.sql
CREATE TABLE IF NOT EXISTS "flashcastr_external_news" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"published_at" text,
	"scraped_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cast_generated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "flashcastr_external_news_url_idx" ON "flashcastr_external_news" USING btree ("url");
--> statement-breakpoint

-- From 0007_add_plan_embeds.sql
ALTER TABLE "farcaster_cast_plans" ADD COLUMN IF NOT EXISTS "embeds" jsonb DEFAULT '[]'::jsonb;
