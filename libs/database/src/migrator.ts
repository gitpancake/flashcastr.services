import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Migration {
  name: string;
  sql: string;
}

export function resolveMigrationsDir(
  moduleDir: string,
  env: Record<string, string | undefined> = process.env
): string {
  return env.MIGRATIONS_DIR ?? join(moduleDir, "..", "migrations");
}

export function loadMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

export type MigrationStatus = "applied" | "skipped" | "baselined" | "pending";

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
  baselineUpperBound?: string;
}

// Arbitrary constant identifying the migration lock; must stay fixed across deploys.
const MIGRATION_LOCK_ID = 78_246_513;

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
  if (options.baseline) {
    if (!options.baselineUpperBound) {
      throw new Error(
        "--baseline requires a migration filename argument, e.g. --baseline 0001_baseline.sql"
      );
    }
    const boundExists = migrations.some((migration) => migration.name === options.baselineUpperBound);
    if (!boundExists) {
      throw new Error(`--baseline ${options.baselineUpperBound} matches no loaded migration`);
    }
  }

  const lockClient = await pool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);

    await ensureMigrationsTable(pool);
    const applied = await loadAppliedNames(pool);
    const results: MigrationResult[] = [];

    for (const migration of migrations) {
      if (applied.has(migration.name)) {
        results.push({ name: migration.name, status: "skipped" });
        continue;
      }

      if (options.baseline) {
        if (migration.name > options.baselineUpperBound!) {
          results.push({ name: migration.name, status: "pending" });
          continue;
        }
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
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => undefined);
    lockClient.release();
  }
}
