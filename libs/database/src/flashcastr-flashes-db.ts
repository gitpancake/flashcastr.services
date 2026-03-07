import { Pool } from "pg";
import type { FlashcastrFlash } from "@flashcastr/shared-types";
import { Postgres } from "./postgres-base.js";

export class FlashcastrFlashesDb extends Postgres<FlashcastrFlash> {
  constructor(pool: Pool) {
    super(pool);
  }

  async getByFlashIds(flashIds: number[]): Promise<FlashcastrFlash[]> {
    if (!flashIds.length) return [];
    return await this.query(`SELECT * FROM flashcastr_flashes WHERE flash_id = ANY($1)`, [flashIds]);
  }

  async insertMany(rows: FlashcastrFlash[]): Promise<FlashcastrFlash[]> {
    if (!rows.length) return [];

    const values: unknown[] = [];
    const valuePlaceholders = rows.map((row, i) => {
      const offset = i * 5;
      values.push(row.flash_id, row.user_fid, row.user_username, row.user_pfp_url, row.cast_hash);
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`;
    });

    const sql = `
      INSERT INTO flashcastr_flashes (
        flash_id, user_fid, user_username, user_pfp_url, cast_hash
      ) VALUES ${valuePlaceholders.join(",")}
      ON CONFLICT DO NOTHING
    `;

    return await this.query(sql, values);
  }

  async getFailedCastsForRetry(limit: number, sinceDays: number): Promise<unknown[]> {
    const sql = `
      SELECT
        ff.flash_id,
        ff.user_fid,
        ff.user_username,
        ff.user_pfp_url,
        fu.signer_uuid,
        fu.auto_cast,
        f.player,
        f.city,
        f.ipfs_cid,
        EXTRACT(EPOCH FROM f.timestamp)::bigint as timestamp
      FROM flashcastr_flashes ff
      INNER JOIN flashcastr_users fu ON ff.user_fid = fu.fid
      INNER JOIN flashes f ON ff.flash_id = f.flash_id
      WHERE ff.cast_hash IS NULL
        AND fu.auto_cast = true
        AND f.ipfs_cid IS NOT NULL
        AND f.ipfs_cid != ''
        AND f.timestamp > NOW() - INTERVAL '${sinceDays} days'
      ORDER BY f.timestamp DESC
      LIMIT $1
    `;
    return await this.query(sql, [limit]);
  }

  async updateCastHash(flashId: number, castHash: string): Promise<void> {
    await this.query(`UPDATE flashcastr_flashes SET cast_hash = $1 WHERE flash_id = $2`, [
      castHash,
      flashId,
    ]);
  }

  async deleteManyByFid(fid: number): Promise<FlashcastrFlash[]> {
    return await this.query(`DELETE FROM flashcastr_flashes WHERE user_fid = $1 RETURNING *`, [fid]);
  }
}
