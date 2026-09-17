import type { Pool, PoolClient } from "pg";

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

  protected async transaction<R>(work: (client: PoolClient) => Promise<R>): Promise<R> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
