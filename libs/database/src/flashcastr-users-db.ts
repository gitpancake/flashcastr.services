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
}
