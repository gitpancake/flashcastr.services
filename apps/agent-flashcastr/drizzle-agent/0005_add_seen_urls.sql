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
