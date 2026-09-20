import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations, type Migration } from "./migrator.js";

describe.skipIf(!process.env.DATABASE_URL)("runMigrations advisory lock (real Postgres)", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DROP TABLE IF EXISTS migrator_lock_test");
    await pool.query("DELETE FROM schema_migrations WHERE name = $1", ["0001_migrator_lock_test.sql"]);
  });

  it("applies a migration exactly once when two runners race", async () => {
    const migrations: Migration[] = [
      { name: "0001_migrator_lock_test.sql", sql: "CREATE TABLE migrator_lock_test (id int);" },
    ];

    const [first, second] = await Promise.all([
      runMigrations(pool, migrations),
      runMigrations(pool, migrations),
    ]);

    const statuses = [...first, ...second].map((result) => result.status).sort();
    expect(statuses).toEqual(["applied", "skipped"]);
  });
});
