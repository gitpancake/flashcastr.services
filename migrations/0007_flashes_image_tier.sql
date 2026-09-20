-- Adds the tier marker B2Pinner will write at pin-completion time. See
-- ticket platform/backblaze-image-storage/01-b2-pinner-and-tier.md.
--
-- Nullable, no default, no index: metadata-only on an 8.1M-row table.
-- NULL means "legacy Pinata row, no tier" and is never backfilled -- the API
-- falls back to the origin img URL for those. A non-empty value is 'feed' or
-- 'keep', written by image-engine / the promote sweep respectively.
ALTER TABLE flashes ADD COLUMN image_tier text;
