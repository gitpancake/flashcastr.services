-- Fixes the bug flagged in 0001_baseline.sql: `idx_flash_identifications_source` is a
-- plain (non-unique) btree index, but FlashIdentificationsDb.upsert does
-- `ON CONFLICT (source_ipfs_cid) DO UPDATE`, which has no unique constraint/index to
-- bind to and fails at runtime every time it executes.
--
-- The table is small, so this rebuilds the index in place rather than using
-- CREATE UNIQUE INDEX CONCURRENTLY (which cannot run inside the migrator's
-- transaction anyway).
--
-- Step 1: dedupe existing rows so the new unique index can be created. Keeps the
-- newest row per source_ipfs_cid (tie-break: highest id), deletes the rest.
DELETE FROM public.flash_identifications
WHERE id NOT IN (
  SELECT DISTINCT ON (source_ipfs_cid) id
  FROM public.flash_identifications
  ORDER BY source_ipfs_cid, created_at DESC, id DESC
);

-- Step 2: drop the plain index and replace it with a unique one of the same name,
-- matching this repo's `idx_<table>_<column>` naming convention.
DROP INDEX public.idx_flash_identifications_source;

CREATE UNIQUE INDEX idx_flash_identifications_source ON public.flash_identifications USING btree (source_ipfs_cid);
