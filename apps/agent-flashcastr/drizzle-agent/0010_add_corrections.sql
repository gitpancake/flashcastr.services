-- flashcastr-conversational-persona story 04: persisted public corrections.
-- A community reply that says @flashcastr got a fact wrong is classified
-- `correction`, acked in character, and stored here so the wrong claim is
-- injected (oldest-first) into every generation/reply prompt and never
-- recurs. retired_at NULL = active; set = retracted/excluded. IF NOT EXISTS
-- so re-apply is safe on any DB state (HEN-587 silently-skipped-migration).
CREATE TABLE IF NOT EXISTS "flashcastr_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wrong_claim" text NOT NULL,
	"correct_fact" text NOT NULL,
	"source_cast_hash" text,
	"author_fid" integer NOT NULL,
	"scope" text DEFAULT 'all' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flashcastr_corrections_retired_idx" ON "flashcastr_corrections" USING btree ("retired_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flashcastr_corrections_scope_idx" ON "flashcastr_corrections" USING btree ("scope");
