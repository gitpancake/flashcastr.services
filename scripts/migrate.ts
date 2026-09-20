/**
 * Applies unapplied SQL migrations from `migrations/` in filename order,
 * recording each in `schema_migrations(name, applied_at)`. Idempotent: an
 * already-applied migration is skipped.
 *
 * Usage:
 *   npm run migrate                                    # apply all pending migrations
 *   npm run migrate -- --baseline 0001_baseline.sql    # record every migration
 *     up to and including the named one as applied, WITHOUT running its SQL,
 *     for adopting a database that already has that schema. Migrations after
 *     the named one are left untouched (not baselined, not applied) so a
 *     later plain `npm run migrate` run applies them for real. The filename
 *     argument is required and must match a loaded migration.
 *
 * Production rollout order (dropping a column, see migrations/0002_drop_deleted.sql):
 *   1. npm run migrate -- --baseline 0001_baseline.sql   (records 0001 as
 *      applied; the tables already exist in production, so its DDL must not
 *      run; 0002 is left pending)
 *   2. Deploy the code that no longer references the dropped column.
 *   3. npm run migrate                 (applies 0002 for real)
 *
 * Requires DATABASE_URL. Migrations are read from `MIGRATIONS_DIR` next to
 * this file's parent directory (`scripts/../migrations` from source,
 * `dist/../migrations` from the bundled image); set MIGRATIONS_DIR to
 * override.
 */
import { config } from "dotenv";
config();

import { getPool, loadMigrations, resolveMigrationsDir, runMigrations, closePool } from "@flashcastr/database";
import { closeLoggers } from "@flashcastr/logger";

const MIGRATIONS_DIR = resolveMigrationsDir(__dirname);

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }

  const baselineFlagIndex = process.argv.indexOf("--baseline");
  const baseline = baselineFlagIndex !== -1;
  const baselineUpperBound = baseline ? process.argv[baselineFlagIndex + 1] : undefined;
  const migrations = loadMigrations(MIGRATIONS_DIR);
  const pool = getPool();

  try {
    const results = await runMigrations(pool, migrations, { baseline, baselineUpperBound });
    for (const result of results) {
      console.log(`${result.status.padEnd(9)} ${result.name}`);
    }
  } finally {
    await closePool();
    await closeLoggers();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
