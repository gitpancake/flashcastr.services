CREATE TABLE IF NOT EXISTS "engine_sync_state" (
	"engine_name" text PRIMARY KEY NOT NULL,
	"sync_token" text NOT NULL,
	"last_sync_at" timestamp with time zone DEFAULT now() NOT NULL
);
