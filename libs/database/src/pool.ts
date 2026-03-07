import { Pool } from "pg";

let pool: Pool | null = null;

export function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not defined");

  pool = new Pool({
    connectionString,
    max: parseInt(process.env.DB_POOL_MAX || "20"),
    min: parseInt(process.env.DB_POOL_MIN || "2"),
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || "30000"),
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT || "2000"),
    allowExitOnIdle: process.env.NODE_ENV === "test",
  });

  pool.on("error", (err) => {
    console.error("[Database] Unexpected pool error:", err.message);
  });

  return pool;
}

export function getPool(): Pool {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
