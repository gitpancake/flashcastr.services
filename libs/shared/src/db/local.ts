import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

export type LocalDb = ReturnType<typeof drizzle>;

export interface LocalDbHandle {
  db: LocalDb;
  close: () => void;
}

/**
 * Open (or create) a SQLite database at the given path and return a handle
 * with the Drizzle instance + close function. Ensures the parent directory
 * exists. WAL mode is enabled for concurrent-read performance.
 *
 * Returns a fresh instance each call — caller owns the lifecycle.
 */
export function openLocalDb(sqlitePath: string): LocalDbHandle {
  const dir = dirname(sqlitePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(sqlitePath);

  // WAL mode: allows concurrent reads while writing, ideal for single-writer services
  sqlite.pragma('journal_mode = WAL');
  // Sync normal: good balance of durability vs performance for non-critical local data
  sqlite.pragma('synchronous = NORMAL');
  // Busy timeout: wait up to 5s if the DB is locked (rare in single-process)
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite);

  return {
    db,
    close: () => sqlite.close(),
  };
}

/**
 * Run Drizzle migrations for the local SQLite database.
 * Each engine provides its own migrations folder.
 */
export function runLocalMigrations(db: LocalDb, migrationsFolder: string): void {
  migrate(db, { migrationsFolder });
  console.log('Local DB migrations up to date');
}
