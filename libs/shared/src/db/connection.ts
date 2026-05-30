import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getRequiredEnv } from '../config/index.js';
import * as schema from './schema.js';

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let client: ReturnType<typeof postgres> | null = null;

/**
 * Get a PostgreSQL database connection.
 *
 * Reads DATABASE_URL. Used by services that need a direct PG connection
 * (e.g., api-gateway).
 */
export function getDb() {
  if (db) return db;

  const connectionString = getRequiredEnv('DATABASE_URL');
  client = postgres(connectionString);
  db = drizzle(client, { schema });
  return db;
}

export async function disconnectDb(): Promise<void> {
  if (client) await client.end();
  client = null;
  db = null;
}
