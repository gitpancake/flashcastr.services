import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMigrations, resolveMigrationsDir, runMigrations, type MigratorPool } from "./migrator.js";

class FakePool implements MigratorPool {
  appliedNames = new Set<string>();
  executedMigrationSql: string[] = [];
  clientLog: string[] = [];
  // Ordered across every connect()'d client, so a test can assert the lock
  // actually brackets the critical section rather than merely being called.
  sequence: string[] = [];

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
    const sequence = this.sequence;
    const applied = this.appliedNames;
    const executed = this.executedMigrationSql;
    return {
      async query(sql: string, params: unknown[] = []) {
        if (sql.startsWith("SELECT pg_advisory_lock")) {
          sequence.push("lock:acquire");
          return { rows: [] };
        }
        if (sql.startsWith("SELECT pg_advisory_unlock")) {
          sequence.push("lock:release");
          return { rows: [] };
        }
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          log.push(sql);
          sequence.push(sql);
          return { rows: [] };
        }
        if (sql.startsWith("INSERT INTO schema_migrations")) {
          applied.add(params[0] as string);
          return { rows: [] };
        }
        executed.push(sql);
        sequence.push("exec");
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

describe("resolveMigrationsDir", () => {
  it("resolves migrations/ as a sibling of the module's parent directory by default", () => {
    expect(resolveMigrationsDir("/app/scripts", {})).toBe(join("/app/scripts", "..", "migrations"));
    expect(resolveMigrationsDir("/app/dist", {})).toBe(join("/app/dist", "..", "migrations"));
  });

  it("prefers the MIGRATIONS_DIR env override when set", () => {
    expect(resolveMigrationsDir("/app/dist", { MIGRATIONS_DIR: "/custom/migrations" })).toBe(
      "/custom/migrations"
    );
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

    const results = await runMigrations(pool, migrations, {
      baseline: true,
      baselineUpperBound: "0001_baseline.sql",
    });

    expect(results).toEqual([{ name: "0001_baseline.sql", status: "baselined" }]);
    expect(pool.executedMigrationSql).toEqual([]);
    expect(pool.appliedNames.has("0001_baseline.sql")).toBe(true);
    expect(pool.clientLog).toEqual([]);
  });

  it("throws when baseline is requested without a baselineUpperBound", async () => {
    const pool = new FakePool();
    const migrations = [{ name: "0001_baseline.sql", sql: "CREATE TABLE foo (id int);" }];

    await expect(runMigrations(pool, migrations, { baseline: true })).rejects.toThrow();
    expect(pool.appliedNames.size).toBe(0);
  });

  it("throws when baselineUpperBound doesn't match any loaded migration", async () => {
    const pool = new FakePool();
    const migrations = [{ name: "0001_baseline.sql", sql: "CREATE TABLE foo (id int);" }];

    await expect(
      runMigrations(pool, migrations, { baseline: true, baselineUpperBound: "0099_missing.sql" })
    ).rejects.toThrow();
    expect(pool.appliedNames.size).toBe(0);
  });

  it("only baselines migrations up to the given bound, leaving later ones untouched", async () => {
    const pool = new FakePool();
    const migrations = [
      { name: "0001_baseline.sql", sql: "CREATE TABLE foo (id int);" },
      { name: "0002_drop_deleted.sql", sql: "ALTER TABLE foo DROP COLUMN bar;" },
    ];

    const results = await runMigrations(pool, migrations, {
      baseline: true,
      baselineUpperBound: "0001_baseline.sql",
    });

    expect(results).toEqual([
      { name: "0001_baseline.sql", status: "baselined" },
      { name: "0002_drop_deleted.sql", status: "pending" },
    ]);
    expect(pool.executedMigrationSql).toEqual([]);
    expect(pool.appliedNames.has("0001_baseline.sql")).toBe(true);
    expect(pool.appliedNames.has("0002_drop_deleted.sql")).toBe(false);
  });

  it("holds the lock around the entire run, not just around acquiring it", async () => {
    const pool = new FakePool();
    const migrations = [{ name: "0001_baseline.sql", sql: "CREATE TABLE foo (id int);" }];

    await runMigrations(pool, migrations);

    expect(pool.sequence).toEqual(["lock:acquire", "BEGIN", "exec", "COMMIT", "lock:release"]);
  });

  it("releases the advisory lock even when a migration fails", async () => {
    const pool = new FakePool();
    pool.query = async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations")) return { rows: [] };
      if (sql.startsWith("SELECT name FROM schema_migrations")) return { rows: [] };
      throw new Error(`unexpected pool.query: ${sql}`);
    };
    const originalConnect = pool.connect.bind(pool);
    pool.connect = async () => {
      const client = await originalConnect();
      const originalClientQuery = client.query.bind(client);
      client.query = async (sql: string, params: unknown[] = []) => {
        if (sql === "CREATE TABLE foo (id int);") throw new Error("boom");
        return originalClientQuery(sql, params);
      };
      return client;
    };
    const migrations = [{ name: "0001_baseline.sql", sql: "CREATE TABLE foo (id int);" }];

    await expect(runMigrations(pool, migrations)).rejects.toThrow("boom");

    expect(pool.sequence).toEqual(["lock:acquire", "BEGIN", "ROLLBACK", "lock:release"]);
  });
});
