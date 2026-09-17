import type { DatabasePool } from "../persistence/database.js";
import type { ActionLog, ActionRecord } from "./actionLog.js";

export class PostgresActionLog implements ActionLog {
  constructor(private readonly pool: DatabasePool) {}

  async record(entry: ActionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO action_log (actor, action, thread_id, subject, outcome, detail) VALUES ($1, $2, $3, $4, $5, $6)`,
      [entry.actor, entry.action, entry.threadId ?? null, entry.subject ?? null, entry.outcome, JSON.stringify(entry.detail ?? {})],
    );
  }

  async countRecent(action: string, subject: string, sinceMs: number): Promise<number> {
    const since = new Date(Date.now() - sinceMs);
    const result = await this.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM action_log WHERE action = $1 AND subject = $2 AND outcome = 'ok' AND occurred_at >= $3`,
      [action, subject, since],
    );
    return Number(result.rows[0]?.total ?? 0);
  }
}
