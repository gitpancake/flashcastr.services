import { Pool } from "pg";
import type { FlashcastrUser } from "@flashcastr/shared-types";
import { Postgres } from "./postgres-base.js";

export class FlashcastrUsersDb extends Postgres<FlashcastrUser> {
  constructor(pool: Pool) {
    super(pool);
  }

  async getMany(filter: Partial<FlashcastrUser> = {}): Promise<FlashcastrUser[]> {
    const values: unknown[] = [];
    const conditions = Object.entries(filter).map(([key, val], i) => {
      values.push(val);
      return `${key} = $${i + 1}`;
    });

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.query(`SELECT * FROM flashcastr_users ${whereClause}`, values);
  }

  async getByFid(fid: number): Promise<FlashcastrUser | null> {
    return this.queryOne(
      "SELECT * FROM flashcastr_users WHERE fid = $1 AND deleted = false",
      [fid]
    );
  }

  async insert(user: FlashcastrUser): Promise<number> {
    const sql = `
      INSERT INTO flashcastr_users (fid, username, signer_uuid, auto_cast, deleted)
      VALUES ($1, $2, $3, $4, false)
      ON CONFLICT (fid) DO UPDATE SET
        deleted = false,
        username = EXCLUDED.username,
        signer_uuid = EXCLUDED.signer_uuid,
        auto_cast = EXCLUDED.auto_cast
      RETURNING fid
    `;
    const result = await this.query(sql, [user.fid, user.username, user.signer_uuid, user.auto_cast]);
    if (result.length === 0) throw new Error("Failed to insert or update user");
    return result[0].fid;
  }

  async updateAutoCast(fid: number, autoCast: boolean): Promise<void> {
    await this.query(
      "UPDATE flashcastr_users SET auto_cast = $1 WHERE fid = $2",
      [autoCast, fid]
    );
  }

  async deleteByFid(fid: number): Promise<void> {
    const result = await this.query(
      "DELETE FROM flashcastr_users WHERE fid = $1 RETURNING fid",
      [fid]
    );
    if (result.length === 0) throw new Error("No user found with the provided fid to delete");
  }
}
