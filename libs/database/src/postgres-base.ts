import { Pool } from "pg";

export abstract class Postgres<T = unknown> {
  constructor(protected pool: Pool) {}

  protected async query<R = T>(sql: string, values: unknown[] = []): Promise<R[]> {
    const res = await this.pool.query(sql, values);
    return res.rows;
  }

  protected async queryOne<R = T>(sql: string, values: unknown[] = []): Promise<R | null> {
    const res = await this.pool.query(sql, values);
    return res.rows[0] ?? null;
  }
}
