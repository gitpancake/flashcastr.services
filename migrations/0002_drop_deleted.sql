-- Drops the vestigial `deleted` columns. Deletes are hard (see
-- FlashcastrUsersDb.deleteWithFlashes) so nothing has set these true; this
-- assumes that's still the case at apply time.
--
-- Deploy order for production (see README "Local database" / migrate.ts --help):
--   1. Run 0001 with --baseline (records it as applied, no DDL — the columns
--      already exist in production).
--   2. Deploy the code that no longer references `deleted`.
--   3. Run 0002 for real.
-- Steps 2 and 3 cannot be reordered: code deployed before 0002 still expects
-- the column tolerable either way (it just never reads/writes `deleted` after
-- this PR merges), but running 0002 before the deploy would break the
-- currently-running code's `deleted = false` filters.

DO $$
DECLARE
  users_with_deleted integer;
  flashes_with_deleted integer;
BEGIN
  SELECT count(*) INTO users_with_deleted FROM flashcastr_users WHERE deleted;
  IF users_with_deleted > 0 THEN
    RAISE EXCEPTION 'flashcastr_users has % row(s) with deleted = true; refusing to drop the column', users_with_deleted;
  END IF;

  SELECT count(*) INTO flashes_with_deleted FROM flashcastr_flashes WHERE deleted;
  IF flashes_with_deleted > 0 THEN
    RAISE EXCEPTION 'flashcastr_flashes has % row(s) with deleted = true; refusing to drop the column', flashes_with_deleted;
  END IF;
END $$;

ALTER TABLE flashcastr_users DROP COLUMN deleted;
ALTER TABLE flashcastr_flashes DROP COLUMN deleted;
