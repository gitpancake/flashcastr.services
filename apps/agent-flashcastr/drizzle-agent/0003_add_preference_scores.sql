CREATE TABLE IF NOT EXISTS "flashcastr_preference_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"city" text,
	"novelty_bucket" text,
	"score" real DEFAULT 0.5 NOT NULL,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "flashcastr_pref_content_city_novelty_idx" ON "flashcastr_preference_scores" USING btree ("content_type","city","novelty_bucket");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flashcastr_pref_content_type_idx" ON "flashcastr_preference_scores" USING btree ("content_type");
