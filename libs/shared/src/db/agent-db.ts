import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export type AgentDb = ReturnType<typeof drizzle>;

let agentDb: AgentDb | null = null;
let agentClient: ReturnType<typeof postgres> | null = null;

const RETRYABLE_CODES = new Set(['EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND']);
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MULTIPLIER = 3;

function extractHost(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return url.hostname;
  } catch {
    return '<unparseable>';
  }
}

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  // Some drivers nest the cause
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause?.code && RETRYABLE_CODES.has(cause.code)) return true;
  return false;
}

// Same backoff as migration retry (1s/3s/9s). Use at call sites where a transient DB error
// would silently drop data rather than surfacing as a startup failure.
export async function withDbRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const host = process.env.DATABASE_URL ? extractHost(process.env.DATABASE_URL) : '<unknown>';
  return withRetry(fn, label, host);
}

async function withRetry<T>(fn: () => Promise<T>, label: string, host: string): Promise<T> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableError(err) || attempt === MAX_RETRIES) {
        if (attempt === MAX_RETRIES && isRetryableError(err)) {
          throw new Error(
            `Failed to connect to database after ${MAX_RETRIES} attempts ` +
            `(host: ${host}). Check that the PostgreSQL service exists and DATABASE_URL is correct.`,
            { cause: err },
          );
        }
        throw err;
      }
      const delayMs = BACKOFF_BASE_MS * Math.pow(BACKOFF_MULTIPLIER, attempt - 1);
      console.warn(
        `[${label}] attempt ${attempt}/${MAX_RETRIES} failed (${(err as NodeJS.ErrnoException).code ?? 'unknown'}), retrying in ${delayMs}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  // Unreachable, but satisfies TypeScript
  throw new Error(`withRetry: exhausted ${MAX_RETRIES} attempts`);
}

/**
 * Connect to the agent's own PostgreSQL database (DATABASE_URL).
 * This is the agent's private data store — no other agent reads from it.
 *
 * Note: no schema import here — each agent passes its own schema tables
 * directly to queries. The Drizzle instance is schemaless (like the
 * migration runner) which avoids coupling the shared lib to agent schemas.
 */
export function getAgentDb(): AgentDb {
  if (agentDb) return agentDb;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for agent database');
  }

  agentClient = postgres(connectionString);
  agentDb = drizzle(agentClient);
  return agentDb;
}

/**
 * Run Drizzle migrations on the agent's own database.
 * Each agent provides its own migrations folder.
 * Retries up to 3 times with exponential backoff on transient DNS/connection errors.
 */
export async function runAgentMigrations(migrationsFolder: string): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for agent migrations');
  }

  const host = extractHost(connectionString);

  await withRetry(
    async () => {
      const migrationClient = postgres(connectionString, { max: 1, onnotice: () => {} });
      const migrationDb = drizzle(migrationClient);

      try {
        await migrate(migrationDb, { migrationsFolder });
        console.log('Agent DB migrations up to date');

        // HEN-587: log applied migration history so silent skips are visible.
        // If the latest created_at is greater than expected, future migrations
        // will be silently skipped — diagnose at boot, not after a tick crashes.
        try {
          const rows = await migrationClient<{ id: number; created_at: bigint; hash: string }[]>`
            SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5
          `;
          for (const row of rows) {
            const ts = new Date(Number(row.created_at)).toISOString();
            console.log(`  migration applied: id=${row.id} created_at=${row.created_at} (${ts})`);
          }
        } catch (err) {
          console.warn('  failed to read drizzle.__drizzle_migrations:', (err as Error).message);
        }

        // Ensure process_sync_state exists — used by getSyncToken/updateSyncToken
        // in all agents regardless of their own migration history.
        await migrationClient`
          CREATE TABLE IF NOT EXISTS process_sync_state (
            process_name text PRIMARY KEY NOT NULL,
            sync_token   text NOT NULL,
            last_sync_at timestamptz DEFAULT now() NOT NULL
          )
        `;
      } finally {
        await migrationClient.end();
      }
    },
    'agent-migrations',
    host,
  );
}

export async function disconnectAgentDb(): Promise<void> {
  if (agentClient) await agentClient.end();
  agentClient = null;
  agentDb = null;
}
