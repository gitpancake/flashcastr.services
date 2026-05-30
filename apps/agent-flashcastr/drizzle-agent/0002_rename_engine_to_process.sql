ALTER TABLE "engine_sync_state" RENAME TO "process_sync_state";
--> statement-breakpoint
ALTER TABLE "process_sync_state" RENAME COLUMN "engine_name" TO "process_name";
