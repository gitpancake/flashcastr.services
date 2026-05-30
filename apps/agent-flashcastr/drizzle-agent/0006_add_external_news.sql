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
