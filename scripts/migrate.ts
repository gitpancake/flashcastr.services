/**
 * Applies unapplied SQL migrations from `migrations/` in filename order,
 * recording each in `schema_migrations(name, applied_at)`. Idempotent: an
 * already-applied migration is skipped.
 *
 * Usage:
 *   npm run migrate                # apply all pending migrations
 *   npm run migrate -- --baseline  # record pending migrations as applied
 *                                   # WITHOUT running their SQL, for adopting
 *                                   # a database that already has this schema
 *
 * Production rollout order (dropping a column, see migrations/0002_drop_deleted.sql):
 *   1. npm run migrate -- --baseline   (records 0001 as applied; the tables
 *      already exist in production, so its DDL must not run)
 *   2. Deploy the code that no longer references the dropped column.
 *   3. npm run migrate                 (applies 0002 for real)
 *
 * Requires DATABASE_URL.
 */
import { config } from "dotenv";
config();

import { join } from "node:path";
import { getPool, loadMigrations, runMigrations, closePool } from "@flashcastr/database";

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }

  const baseline = process.argv.includes("--baseline");
  const migrations = loadMigrations(MIGRATIONS_DIR);
  const pool = getPool();

  try {
    const results = await runMigrations(pool, migrations, { baseline });
    for (const result of results) {
      console.log(`${result.status.padEnd(9)} ${result.name}`);
    }
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
