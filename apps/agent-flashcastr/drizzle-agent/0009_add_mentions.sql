-- flashcastr-conversational-persona story 02: read-only ingest of inbound
-- mentions of @flashcastr and replies on its own casts. cast_hash PK gives
-- idempotent re-poll. IF NOT EXISTS so re-apply is safe on any DB state
-- (HEN-587 class of silently-skipped-migration bug).
CREATE TABLE IF NOT EXISTS "flashcastr_mentions" (
	"cast_hash" text PRIMARY KEY NOT NULL,
	"author_fid" integer NOT NULL,
	"author_username" text NOT NULL,
	"parent_hash" text,
	"thread_root_hash" text,
	"text" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flashcastr_mentions_status_idx" ON "flashcastr_mentions" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flashcastr_mentions_thread_idx" ON "flashcastr_mentions" USING btree ("thread_root_hash");
