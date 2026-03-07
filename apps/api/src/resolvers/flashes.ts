import type { Pool } from "pg";
import { PostgresFlashesDb } from "@flashcastr/database";

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

export function createFlashResolvers(pool: Pool) {
  const flashesDb = new PostgresFlashesDb(pool);

  return {
    Query: {
      flashes: async (_: unknown, args: { fid?: number; username?: string; page?: number; limit?: number; city?: string }) => {
        const { page = DEFAULT_PAGE, limit = DEFAULT_LIMIT } = args;
        const validatedPage = Math.max(DEFAULT_PAGE, page);
        const offset = (validatedPage - 1) * limit;

        const params: unknown[] = [];
        const conditions: string[] = ["ff.deleted = false", "fu.deleted = false"];
        let paramIndex = 1;

        if (typeof args.fid === "number") {
          conditions.push(`ff.user_fid = $${paramIndex++}`);
          params.push(args.fid);
        }
        if (args.username) {
          conditions.push(`ff.user_username = $${paramIndex++}`);
          params.push(args.username);
        }
        if (args.city) {
          conditions.push(`LOWER(f.city) = LOWER($${paramIndex++})`);
          params.push(args.city);
        }

        params.push(limit, offset);

        const sql = `
          SELECT
            ff.id, ff.flash_id, ff.user_fid, ff.user_username, ff.user_pfp_url, ff.cast_hash,
            f.flash_id as f_flash_id, f.city, f.player, f.img, f.ipfs_cid, f.text,
            f.timestamp::text as f_timestamp, f.flash_count
          FROM flashcastr_flashes ff
          INNER JOIN flashcastr_users fu ON ff.user_fid = fu.fid
          INNER JOIN flashes f ON ff.flash_id = f.flash_id
          WHERE ${conditions.join(" AND ")}
          ORDER BY f.timestamp DESC
          LIMIT $${paramIndex++} OFFSET $${paramIndex}
        `;

        const result = await pool.query(sql, params);

        return result.rows.map((row: Record<string, unknown>) => ({
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
            text: row.text,
            timestamp: row.f_timestamp,
            flash_count: row.flash_count,
          },
        }));
      },

      globalFlashes: async (_: unknown, args: { page?: number; limit?: number; city?: string; player?: string }) => {
        const { page = DEFAULT_PAGE, limit = DEFAULT_LIMIT } = args;
        const validatedPage = Math.max(DEFAULT_PAGE, page);
        const offset = (validatedPage - 1) * limit;

        const params: unknown[] = [];
        const conditions: string[] = [];
        let paramIndex = 1;

        if (args.city) {
          conditions.push(`LOWER(city) = LOWER($${paramIndex++})`);
          params.push(args.city);
        }
        if (args.player) {
          conditions.push(`LOWER(player) = LOWER($${paramIndex++})`);
          params.push(args.player);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        params.push(limit, offset);

        const sql = `
          SELECT flash_id::text as flash_id, city, player, img, ipfs_cid, text,
                 timestamp::text as timestamp, flash_count
          FROM flashes
          ${whereClause}
          ORDER BY timestamp DESC
          LIMIT $${paramIndex++} OFFSET $${paramIndex}
        `;

        const result = await pool.query(sql, params);
        return result.rows;
      },

      globalFlash: async (_: unknown, args: { flash_id: string }) => {
        const result = await pool.query(
          `SELECT flash_id::text as flash_id, city, player, img, ipfs_cid, text,
                  timestamp::text as timestamp, flash_count
           FROM flashes WHERE flash_id = $1`,
          [args.flash_id]
        );
        return result.rows[0] ?? null;
      },

      flash: async (_: unknown, args: { id: number }) => {
        const result = await pool.query(
          `SELECT
            ff.id, ff.flash_id, ff.user_fid, ff.user_username, ff.user_pfp_url, ff.cast_hash,
            f.flash_id as f_flash_id, f.city, f.player, f.img, f.ipfs_cid, f.text,
            f.timestamp::text as f_timestamp, f.flash_count
          FROM flashcastr_flashes ff
          INNER JOIN flashcastr_users fu ON ff.user_fid = fu.fid
          INNER JOIN flashes f ON ff.flash_id = f.flash_id
          WHERE ff.id = $1 AND ff.deleted = false AND fu.deleted = false`,
          [args.id]
        );

        if (result.rows.length === 0) return null;
        const row = result.rows[0];

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
            text: row.text,
            timestamp: row.f_timestamp,
            flash_count: row.flash_count,
          },
        };
      },

      flashesSummary: async (_: unknown, args: { fid: number }) => {
        const countResult = await pool.query(
          `SELECT COUNT(*)::int as count FROM flashcastr_flashes ff
           INNER JOIN flashcastr_users fu ON ff.user_fid = fu.fid
           WHERE ff.user_fid = $1 AND ff.deleted = false AND fu.deleted = false`,
          [args.fid]
        );

        const citiesResult = await pool.query(
          `SELECT DISTINCT f.city FROM flashcastr_flashes ff
           INNER JOIN flashcastr_users fu ON ff.user_fid = fu.fid
           INNER JOIN flashes f ON ff.flash_id = f.flash_id
           WHERE ff.user_fid = $1 AND ff.deleted = false AND fu.deleted = false AND f.city IS NOT NULL`,
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
