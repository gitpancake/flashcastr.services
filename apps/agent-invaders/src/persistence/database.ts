import pg from "pg";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS action_log (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  thread_id TEXT,
  subject TEXT,
  outcome TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS action_log_occurred_at_idx ON action_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS action_log_action_subject_idx ON action_log (action, subject);

CREATE TABLE IF NOT EXISTS inbound_casts (
  cast_hash TEXT PRIMARY KEY,
  thread_hash TEXT NOT NULL,
  parent_hash TEXT,
  author_fid INTEGER NOT NULL,
  author_username TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed',
  received_at TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS inbound_casts_author_received_idx ON inbound_casts (author_fid, received_at DESC);
`;

export type DatabasePool = pg.Pool;

export function createDatabasePool(connectionString: string): DatabasePool {
  return new pg.Pool({ connectionString, max: 5 });
}

export async function ensureSchema(pool: DatabasePool): Promise<void> {
  await pool.query(SCHEMA_SQL);
}
