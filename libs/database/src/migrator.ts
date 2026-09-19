import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Migration {
  name: string;
  sql: string;
}

export function loadMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

export type MigrationStatus = "applied" | "skipped" | "baselined";

export interface MigrationResult {
  name: string;
  status: MigrationStatus;
}

interface MigratorQueryResult {
  rows: Array<Record<string, unknown>>;
}

interface MigratorClient {
  query(sql: string, params?: unknown[]): Promise<MigratorQueryResult>;
  release(): void;
}

export interface MigratorPool {
  query(sql: string, params?: unknown[]): Promise<MigratorQueryResult>;
  connect(): Promise<MigratorClient>;
}

export interface RunMigrationsOptions {
  baseline?: boolean;
}

async function ensureMigrationsTable(pool: MigratorPool): Promise<void> {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
  );
}

async function loadAppliedNames(pool: MigratorPool): Promise<Set<string>> {
  const { rows } = await pool.query("SELECT name FROM schema_migrations");
  return new Set(rows.map((row) => row.name as string));
}

export async function runMigrations(
  pool: MigratorPool,
  migrations: Migration[],
  options: RunMigrationsOptions = {}
): Promise<MigrationResult[]> {
  await ensureMigrationsTable(pool);
  const applied = await loadAppliedNames(pool);
  const results: MigrationResult[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.name)) {
      results.push({ name: migration.name, status: "skipped" });
      continue;
    }

    if (options.baseline) {
      await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [migration.name]);
      results.push({ name: migration.name, status: "baselined" });
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [migration.name]);
      await client.query("COMMIT");
      results.push({ name: migration.name, status: "applied" });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  return results;
}
