import { Pool } from "pg";
import type { Flash } from "@flashcastr/shared-types";
import { Postgres } from "./postgres-base.js";

export class PostgresFlashesDb extends Postgres<Flash> {
  constructor(pool: Pool) {
    super(pool);
  }

  async getSinceByPlayers(sinceUnix: number, usernames: string[]): Promise<Flash[]> {
    const sql = `
      SELECT * FROM flashes
      WHERE timestamp >= to_timestamp($1) AND LOWER(player) = ANY($2)
      ORDER BY timestamp DESC
    `;
    return await this.query(sql, [sinceUnix, usernames.map((u) => u.toLowerCase())]);
  }

  async getSince(sinceUnix: number): Promise<Flash[]> {
    const sql = `
      SELECT * FROM flashes
      WHERE timestamp >= to_timestamp($1)
      ORDER BY timestamp DESC
    `;
    return await this.query(sql, [sinceUnix]);
  }

  async getByIds(flashIds: number[]): Promise<Flash[]> {
    if (flashIds.length === 0) return [];
    const placeholders = flashIds.map((_, i) => `$${i + 1}`).join(",");
    const sql = `SELECT * FROM flashes WHERE flash_id IN (${placeholders})`;
    return await this.query(sql, flashIds);
  }

  async writeMany(flashes: Flash[]): Promise<Flash[]> {
    if (!flashes.length) return [];

    const validFlashes: Flash[] = [];
    for (const flash of flashes) {
      const errors = this.validateFlash(flash);
      if (errors.length === 0) {
        validFlashes.push(this.sanitizeFlash(flash));
      } else {
        console.warn(
          `[PostgresFlashesDb] Invalid flash ${flash.flash_id}: ${errors.join(", ")}`
        );
      }
    }

    if (validFlashes.length === 0) return [];

    const flashIds = validFlashes.map((f) => f.flash_id);
    const cities = validFlashes.map((f) => f.city);
    const players = validFlashes.map((f) => f.player);
    const imgs = validFlashes.map((f) => f.img);
    const ipfsCids = validFlashes.map((f) => f.ipfs_cid || "");
    const texts = validFlashes.map((f) => f.text);
    const timestamps = validFlashes.map((f) => new Date(f.timestamp * 1000));
    const flashCounts = validFlashes.map((f) => f.flash_count);

    const sql = `
      INSERT INTO flashes (
        flash_id, city, player, img, ipfs_cid, text, timestamp, flash_count
      )
      SELECT * FROM UNNEST(
        $1::bigint[], $2::text[], $3::text[], $4::text[],
        $5::text[], $6::text[], $7::timestamp[], $8::text[]
      ) AS t(flash_id, city, player, img, ipfs_cid, text, timestamp, flash_count)
      ON CONFLICT (flash_id) DO UPDATE SET
        ipfs_cid = COALESCE(NULLIF(EXCLUDED.ipfs_cid, ''), flashes.ipfs_cid)
      RETURNING *;
    `;

    try {
      return await this.query(sql, [
        flashIds, cities, players, imgs, ipfsCids, texts, timestamps, flashCounts,
      ]);
    } catch (error) {
      console.error(`[PostgresFlashesDb] Batch insert failed:`, error);
      return await this.insertIndividually(validFlashes);
    }
  }

  private validateFlash(flash: Flash): string[] {
    const errors: string[] = [];
    if (!flash.flash_id || typeof flash.flash_id !== "number" || flash.flash_id <= 0)
      errors.push("invalid_flash_id");
    if (!flash.timestamp || typeof flash.timestamp !== "number" || flash.timestamp <= 0)
      errors.push("invalid_timestamp");
    if (!flash.city || typeof flash.city !== "string" || flash.city.trim().length === 0)
      errors.push("missing_city");
    if (!flash.player || typeof flash.player !== "string" || flash.player.trim().length === 0)
      errors.push("missing_player");
    if (!flash.img || typeof flash.img !== "string" || flash.img.trim().length === 0)
      errors.push("missing_img");
    return errors;
  }

  private sanitizeFlash(flash: Flash): Flash {
    return {
      ...flash,
      city: flash.city?.trim() || "",
      player: flash.player?.trim() || "",
      img: flash.img?.trim() || "",
      text: flash.text?.trim() || "",
      flash_count: flash.flash_count?.trim() || "",
      ipfs_cid: flash.ipfs_cid?.trim() || "",
      flash_id: Number(flash.flash_id),
      timestamp: Number(flash.timestamp),
    };
  }

  async getAllPlayers(username?: string): Promise<string[]> {
    let sql = "SELECT DISTINCT player FROM flashes WHERE player IS NOT NULL";
    const params: string[] = [];
    if (username) {
      sql += " AND LOWER(player) = LOWER($1)";
      params.push(username);
    }
    sql += " ORDER BY player";
    const result = await this.query<{ player: string }>(sql, params);
    return result.map((row) => row.player).filter(Boolean);
  }

  async getAllCities(): Promise<string[]> {
    const result = await this.query<{ city: string }>(
      "SELECT DISTINCT city FROM flashes WHERE city IS NOT NULL ORDER BY city ASC"
    );
    return result.map((row) => row.city);
  }

  private async insertIndividually(flashes: Flash[]): Promise<Flash[]> {
    const successful: Flash[] = [];
    for (const flash of flashes) {
      try {
        const sql = `
          INSERT INTO flashes (
            flash_id, city, player, img, ipfs_cid, text, timestamp, flash_count
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (flash_id) DO UPDATE SET
            ipfs_cid = COALESCE(NULLIF(EXCLUDED.ipfs_cid, ''), flashes.ipfs_cid)
          RETURNING *;
        `;
        const result = await this.query(sql, [
          flash.flash_id, flash.city, flash.player, flash.img,
          flash.ipfs_cid, flash.text, new Date(flash.timestamp * 1000), flash.flash_count,
        ]);
        if (result.length > 0) successful.push(result[0]);
      } catch (error) {
        console.error(
          `[PostgresFlashesDb] Individual insert failed for flash ${flash.flash_id}:`,
          error instanceof Error ? error.message : error
        );
      }
    }
    return successful;
  }
}
