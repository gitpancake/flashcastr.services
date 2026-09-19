-- Drops indexes on flashes/flashcastr_flashes that carry no query plan today
-- (verified via production EXPLAIN, pasted in the PR) and adds the one
-- composite index the api's LOWER(city) filter actually needs. See ticket
-- platform/flashes-index-diet.md.
--
-- WhereBuilder.eqIgnoreCase (apps/api/src/sql/where-builder.ts) emits
-- `LOWER(col) = LOWER($n)`; a plain (non-lower) index on city/player can never
-- serve that, and none of the dropped indexes below appeared in any of the
-- nine production EXPLAINs re-run for this change (six from the ticket's
-- Context section plus leaderboard, progress, getFailedCastsForRetry).
--
-- Ordering matters here: the whole file runs in one transaction, and locks
-- are held until COMMIT regardless of statement order. A plain DROP INDEX
-- takes ACCESS EXCLUSIVE (blocks reads AND writes on the table), while a
-- plain CREATE INDEX only takes SHARE (blocks writes, not reads). Building
-- the new index and ANALYZE-ing FIRST, before any DROP INDEX, means the slow
-- part of this migration only blocks flashes writes (database-engine
-- requeues, nothing lost) -- readers keep working the whole time. All the
-- ACCESS EXCLUSIVE drops (including on flashcastr_flashes, whose
-- idx_flashcastr_flashes_flash_id alone serves ~1.5B scans/quarter) are
-- pushed to the end, right before COMMIT, so that lock is held for
-- milliseconds instead of however long the index build takes. Doing it the
-- other way around -- drop first, build second -- would hold flashcastr_flashes
-- under ACCESS EXCLUSIVE for the *entire* build, blocking every read on it
-- (leaderboard, unifiedFlashes, getFailedCastsForRetry) for that whole time.
--
-- The new index is built under a throwaway name and renamed at the end
-- (ALTER INDEX RENAME is a fast catalog-only op, not ACCESS EXCLUSIVE)
-- because its final name, idx_flashes_city_timestamp, belongs to the old
-- plain (non-lower) index being dropped in this same migration -- can't
-- create it under that name until the old one is gone.

-- The index the api actually needs: WhereBuilder.eqIgnoreCase("city", ...) can
-- now be served directly, pre-sorted by timestamp, instead of falling back to
-- a full scan.
CREATE INDEX idx_flashes_city_timestamp_new ON public.flashes USING btree (lower(city), "timestamp" DESC);

-- LOWER(city) had no expression statistics before this index existed, so the
-- planner's selectivity estimate for LOWER(city) = <rare city> was wildly off
-- in production (EXPLAIN estimated ~16k-40k matching rows for a city with 4
-- actual rows) -- ANALYZE immediately so the planner can see and use the new
-- index right away instead of waiting on autovacuum's next pass.
ANALYZE public.flashes;

-- flashes: byte-for-byte duplicate of flashes_pkey (same single column). The
-- planner falls back to the pkey transparently -- it shows scans today only
-- because nothing else serves flash_id lookups yet.
DROP INDEX public.idx_flashes_flash_id;

-- flashes: plain (non-lower) city/player indexes and their compound variants.
-- Only idx_flashes_player_timestamp (lower(player), timestamp) and
-- idx_flashes_city (city, for getAllCities' `SELECT DISTINCT city`) are
-- load-bearing.
DROP INDEX public.idx_flashes_city_player_timestamp_desc;
DROP INDEX public.idx_flashes_player_timestamp_desc;
DROP INDEX public.idx_flashes_city_timestamp_desc;
DROP INDEX public.idx_flashes_city_timestamp;
DROP INDEX public.idx_flashes_player;

-- flashes: idx_flashes_player_city_timestamp (lower(player), city, timestamp)
-- has 6 scans total in production, all via its lower(player) prefix -- city
-- here isn't lower()'d, so it can never serve WhereBuilder's LOWER(city)
-- predicate, and for a lower(player)-only filter it's strictly worse than
-- idx_flashes_player_timestamp (city sits between player and timestamp, so
-- rows for one player aren't globally timestamp-sorted the way the 2-column
-- index's are).
DROP INDEX public.idx_flashes_player_city_timestamp;

-- flashes: nothing filters flashes by ipfs_cid. The only predicate involving
-- it is the join `f.ipfs_cid = fi.source_ipfs_cid` in unified-flash.ts, driven
-- from flashes and served by flash_identifications' unique index instead.
DROP INDEX public.idx_flashes_ipfs_cid;

-- flashcastr_flashes: plain duplicates of a unique-constraint-backed index.
-- (idx_flashcastr_user_fid is on flashcastr_flashes.user_fid, same as
-- idx_flashcastr_flashes_user_fid -- not to be confused with
-- idx_flashcastr_users_fid, a distinct index on flashcastr_users.fid that
-- this migration does not touch.)
DROP INDEX public.idx_flashcastr_flash_id;         -- dup of unique_flash_id
DROP INDEX public.idx_flashcastr_user_fid;         -- dup of idx_flashcastr_flashes_user_fid
DROP INDEX public.idx_flashcastr_flashes_flash_id; -- dup of unique_flash_id; keeping
                                                    -- unique_flash_id since it also
                                                    -- enforces the constraint

-- flashcastr_flashes: cast_hash is only ever read via `cast_hash IS NULL`
-- (flashCaster.retryFailedCasts) or as a plain JS property, never
-- `cast_hash = <value>`; 0 scans in production.
DROP INDEX public.idx_flashcastr_cast_hash;

ALTER INDEX public.idx_flashes_city_timestamp_new RENAME TO idx_flashes_city_timestamp;
