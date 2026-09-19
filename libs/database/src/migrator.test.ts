import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMigrations, runMigrations, type MigratorPool } from "./migrator.js";

class FakePool implements MigratorPool {
  appliedNames = new Set<string>();
  executedMigrationSql: string[] = [];
  clientLog: string[] = [];

  async query(sql: string, params: unknown[] = []) {
    if (sql.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations")) return { rows: [] };
    if (sql.startsWith("SELECT name FROM schema_migrations")) {
      return { rows: [...this.appliedNames].map((name) => ({ name })) };
    }
    if (sql.startsWith("INSERT INTO schema_migrations")) {
      this.appliedNames.add(params[0] as string);
      return { rows: [] };
    }
    throw new Error(`FakePool.query: unexpected sql: ${sql}`);
  }

  async connect() {
    const log = this.clientLog;
    const applied = this.appliedNames;
    const executed = this.executedMigrationSql;
    return {
      async query(sql: string, params: unknown[] = []) {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          log.push(sql);
          return { rows: [] };
        }
        if (sql.startsWith("INSERT INTO schema_migrations")) {
          applied.add(params[0] as string);
          return { rows: [] };
        }
        executed.push(sql);
        return { rows: [] };
      },
      release() {},
    };
  }
}

describe("loadMigrations", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flashcastr-migrations-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads .sql files sorted by filename regardless of write order", () => {
    writeFileSync(join(dir, "0002_second.sql"), "SELECT 2;");
    writeFileSync(join(dir, "0001_first.sql"), "SELECT 1;");

    const migrations = loadMigrations(dir);

    expect(migrations.map((m) => m.name)).toEqual(["0001_first.sql", "0002_second.sql"]);
    expect(migrations[0].sql).toBe("SELECT 1;");
  });
});

describe("runMigrations", () => {
  it("applies a pending migration inside a transaction and records it", async () => {
    const pool = new FakePool();
    const migrations = [{ name: "0001_baseline.sql", sql: "CREATE TABLE foo (id int);" }];

    const results = await runMigrations(pool, migrations);

    expect(results).toEqual([{ name: "0001_baseline.sql", status: "applied" }]);
    expect(pool.executedMigrationSql).toEqual(["CREATE TABLE foo (id int);"]);
    expect(pool.appliedNames.has("0001_baseline.sql")).toBe(true);
    expect(pool.clientLog).toEqual(["BEGIN", "COMMIT"]);
  });

  it("skips a migration already recorded in schema_migrations without re-running it", async () => {
    const pool = new FakePool();
    pool.appliedNames.add("0001_baseline.sql");
    const migrations = [{ name: "0001_baseline.sql", sql: "CREATE TABLE foo (id int);" }];

    const results = await runMigrations(pool, migrations);

    expect(results).toEqual([{ name: "0001_baseline.sql", status: "skipped" }]);
    expect(pool.executedMigrationSql).toEqual([]);
    expect(pool.clientLog).toEqual([]);
  });

  it("baseline mode records pending migrations as applied without running their SQL", async () => {
    const pool = new FakePool();
    const migrations = [{ name: "0001_baseline.sql", sql: "CREATE TABLE foo (id int);" }];

    const results = await runMigrations(pool, migrations, { baseline: true });

    expect(results).toEqual([{ name: "0001_baseline.sql", status: "baselined" }]);
    expect(pool.executedMigrationSql).toEqual([]);
    expect(pool.appliedNames.has("0001_baseline.sql")).toBe(true);
    expect(pool.clientLog).toEqual([]);
  });

  it("only baselines migrations still pending, applying the rest normally", async () => {
    const pool = new FakePool();
    pool.appliedNames.add("0001_baseline.sql");
    const migrations = [
      { name: "0001_baseline.sql", sql: "CREATE TABLE foo (id int);" },
      { name: "0002_drop_deleted.sql", sql: "ALTER TABLE foo DROP COLUMN bar;" },
    ];

    const results = await runMigrations(pool, migrations, { baseline: true });

    expect(results).toEqual([
      { name: "0001_baseline.sql", status: "skipped" },
      { name: "0002_drop_deleted.sql", status: "baselined" },
    ]);
    expect(pool.executedMigrationSql).toEqual([]);
  });
});
