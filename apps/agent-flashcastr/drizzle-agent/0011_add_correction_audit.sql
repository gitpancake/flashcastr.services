-- Reply-driven correction audit log. Every inbound reply classified as a
-- `correction` lands here regardless of whether it passed the relevance +
-- web-fact-check gates and got persisted into flashcastr_corrections.
-- Powers the daily fact-check budget (last-24h count) and post-hoc review.
CREATE TABLE IF NOT EXISTS "flashcastr_correction_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_cast_hash" text NOT NULL,
	"author_fid" integer NOT NULL,
	"wrong_claim" text NOT NULL,
	"correct_fact" text NOT NULL,
	"relevant" boolean NOT NULL,
	"fact_check_verdict" text,
	"fact_check_reasoning" text,
	"persisted" boolean DEFAULT false NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flashcastr_correction_audit_checked_at_idx" ON "flashcastr_correction_audit" USING btree ("checked_at");
