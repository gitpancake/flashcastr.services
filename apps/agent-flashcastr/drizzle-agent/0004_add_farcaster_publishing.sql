CREATE TABLE IF NOT EXISTS "farcaster_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handle" text NOT NULL,
	"fid" integer NOT NULL,
	"signer_private_key" text NOT NULL,
	"display_name" text NOT NULL,
	"pfp_url" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"requires_approval" boolean DEFAULT true NOT NULL,
	"content_source" text,
	"daily_cast_target" integer DEFAULT 3 NOT NULL,
	"daily_engagement_limit" integer DEFAULT 2 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "farcaster_accounts_handle_unique" ON "farcaster_accounts" USING btree ("handle");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "farcaster_accounts_fid_unique" ON "farcaster_accounts" USING btree ("fid");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "farcaster_cast_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_handle" text NOT NULL,
	"plan_type" text NOT NULL,
	"channel_id" text,
	"text" text NOT NULL,
	"parent_hash" text,
	"parent_author_fid" integer,
	"parent_text" text,
	"reasoning" text NOT NULL,
	"context_source" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"edited_text" text,
	"scheduled_for" timestamp with time zone,
	"for_date" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fc_cast_plan_date_status_idx" ON "farcaster_cast_plans" USING btree ("for_date","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fc_cast_plan_account_idx" ON "farcaster_cast_plans" USING btree ("account_handle");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cast_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_handle" text NOT NULL,
	"text" text NOT NULL,
	"parent_hash" text,
	"channel_id" text,
	"embeds" jsonb DEFAULT '[]'::jsonb,
	"source_engine" text NOT NULL,
	"source_plan_id" text,
	"cast_hash" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 5 NOT NULL,
	"last_error" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cast_queue_status_idx" ON "cast_queue" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cast_queue_account_idx" ON "cast_queue" USING btree ("account_handle");
