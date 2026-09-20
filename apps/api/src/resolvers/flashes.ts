import type { Pool } from "pg";
import { PostgresFlashesDb, buildImageUrl, type ImageUrlConfig } from "@flashcastr/database";
import { WhereBuilder, clampLimit, pageOffset } from "../sql/where-builder.js";

const DEFAULT_LIMIT = 20;

const FLASHCASTR_FLASH_SELECT = `
  SELECT
    ff.id, ff.flash_id, ff.user_fid, ff.user_username, ff.user_pfp_url, ff.cast_hash,
    f.flash_id as f_flash_id, f.city, f.player, f.img, f.ipfs_cid, f.image_tier, f.text,
    EXTRACT(EPOCH FROM f.timestamp)::bigint::text as f_timestamp, f.flash_count
  FROM flashcastr_flashes ff
  INNER JOIN flashcastr_users fu ON ff.user_fid = fu.fid
  INNER JOIN flashes f ON ff.flash_id = f.flash_id
`;

const GLOBAL_FLASH_SELECT = `
  SELECT flash_id::text as flash_id, city, player, img, ipfs_cid, image_tier, text,
         EXTRACT(EPOCH FROM timestamp)::bigint::text as timestamp, flash_count
  FROM flashes
`;

function toFlashcastrFlash(row: Record<string, unknown>, imageUrlConfig: ImageUrlConfig) {
  return {
    id: row.id,
    flash_id: String(row.flash_id),
    user_fid: row.user_fid,
    user_username: row.user_username,
    user_pfp_url: row.user_pfp_url,
    cast_hash: row.cast_hash,
    flash: {
      flash_id: String(row.f_flash_id),
      city: row.city,
      player: row.player,
      img: row.img,
      ipfs_cid: row.ipfs_cid,
      image_url: buildImageUrl(
        { flash_id: row.f_flash_id as string | number, image_tier: row.image_tier as string | null, img: row.img as string | null },
        imageUrlConfig
      ),
      text: row.text,
      timestamp: row.f_timestamp,
      flash_count: row.flash_count,
    },
  };
}

export function createFlashResolvers(pool: Pool, imageUrlConfig: ImageUrlConfig) {
  const flashesDb = new PostgresFlashesDb(pool);

  return {
    Query: {
      flashes: async (_: unknown, args: { fid?: number; username?: string; page?: number; limit?: number; city?: string }) => {
        const limit = clampLimit(args.limit, DEFAULT_LIMIT);
        const where = new WhereBuilder()
          .eq("ff.user_fid", args.fid)
          .eq("ff.user_username", args.username)
          .eqIgnoreCase("f.city", args.city);
        const pagination = where.paginate(limit, pageOffset(args.page, limit));

        const result = await pool.query(
          `${FLASHCASTR_FLASH_SELECT} ${where.clause()} ORDER BY f.timestamp DESC ${pagination}`,
          where.params
        );
        return result.rows.map((row) => toFlashcastrFlash(row, imageUrlConfig));
      },

      globalFlashes: async (_: unknown, args: { page?: number; limit?: number; city?: string; player?: string }) => {
        const limit = clampLimit(args.limit, DEFAULT_LIMIT);
        const where = new WhereBuilder().eqIgnoreCase("city", args.city).eqIgnoreCase("player", args.player);
        const pagination = where.paginate(limit, pageOffset(args.page, limit));

        const result = await pool.query(
          `${GLOBAL_FLASH_SELECT} ${where.clause()} ORDER BY timestamp DESC ${pagination}`,
          where.params
        );
        return result.rows.map((row) => ({
          ...row,
          image_url: buildImageUrl({ flash_id: row.flash_id, image_tier: row.image_tier, img: row.img }, imageUrlConfig),
        }));
      },

      globalFlash: async (_: unknown, args: { flash_id: string }) => {
        const result = await pool.query(`${GLOBAL_FLASH_SELECT} WHERE flash_id = $1`, [args.flash_id]);
        const row = result.rows[0];
        if (!row) return null;
        return {
          ...row,
          image_url: buildImageUrl({ flash_id: row.flash_id, image_tier: row.image_tier, img: row.img }, imageUrlConfig),
        };
      },

      flash: async (_: unknown, args: { id: number }) => {
        const result = await pool.query(
          `${FLASHCASTR_FLASH_SELECT} WHERE ff.id = $1`,
          [args.id]
        );
        return result.rows.length === 0 ? null : toFlashcastrFlash(result.rows[0], imageUrlConfig);
      },

      flashesSummary: async (_: unknown, args: { fid: number }) => {
        const countResult = await pool.query(
          `SELECT COUNT(*)::int as count FROM flashcastr_flashes ff
           INNER JOIN flashcastr_users fu ON ff.user_fid = fu.fid
           WHERE ff.user_fid = $1`,
          [args.fid]
        );

        const citiesResult = await pool.query(
          `SELECT DISTINCT f.city FROM flashcastr_flashes ff
           INNER JOIN flashcastr_users fu ON ff.user_fid = fu.fid
           INNER JOIN flashes f ON ff.flash_id = f.flash_id
           WHERE ff.user_fid = $1 AND f.city IS NOT NULL`,
          [args.fid]
        );

        return {
          flashCount: countResult.rows[0]?.count ?? 0,
          cities: citiesResult.rows.map((r: { city: string }) => r.city),
        };
      },

      allFlashesPlayers: async (_: unknown, args: { username?: string }) => {
        if (!args.username) return [];
        return flashesDb.getAllPlayers(args.username);
      },
    },
  };
}
