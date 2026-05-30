CREATE TABLE IF NOT EXISTS "flashcastr_invader_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invader_id" text NOT NULL,
	"city" text NOT NULL,
	"event_type" text NOT NULL,
	"event_date" text NOT NULL,
	"raw_text" text,
	"source_url" text,
	"scraped_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cast_generated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "flashcastr_event_dedup_idx" ON "flashcastr_invader_events" USING btree ("invader_id","event_type","event_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flashcastr_event_date_idx" ON "flashcastr_invader_events" USING btree ("event_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flashcastr_event_city_idx" ON "flashcastr_invader_events" USING btree ("city");
