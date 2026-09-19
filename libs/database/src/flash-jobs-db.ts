import type { Pool, PoolClient } from "pg";
import { Postgres } from "./postgres-base.js";

export type FlashJobStage = "pin" | "cast";

export interface FlashJob {
  flash_id: number;
  stage: FlashJobStage;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  created_at: Date;
}

// claim()'s rows also carry the flashes row data the handler needs (img for
// pin, ipfs_cid for cast) so callers don't need a second query.
export interface ClaimedFlashJob extends FlashJob {
  city: string;
  player: string;
  img: string;
  ipfs_cid: string;
  text: string;
  timestamp: Date;
  flash_count: string;
}

export class FlashJobsDb extends Postgres<FlashJob> {
  constructor(pool: Pool) {
    super(pool);
  }

  async enqueue(client: Pool | PoolClient, flashId: number, stage: FlashJobStage): Promise<void> {
    await client.query(`INSERT INTO flash_jobs (flash_id, stage) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      flashId,
      stage,
    ]);
  }

  async claim(
    stage: FlashJobStage,
    limit: number,
    leaseMs: number,
    maxAttempts: number
  ): Promise<ClaimedFlashJob[]> {
    const sql = `
      WITH claimed AS (
        UPDATE flash_jobs
        SET attempts = attempts + 1,
            next_attempt_at = now() + make_interval(secs => $2::numeric / 1000)
        WHERE (flash_id, stage) IN (
          SELECT flash_id, stage FROM flash_jobs
          WHERE stage = $1 AND next_attempt_at <= now() AND attempts < $4
          ORDER BY next_attempt_at
          LIMIT $3
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      )
      SELECT
        claimed.flash_id::int AS flash_id, claimed.stage, claimed.attempts,
        claimed.next_attempt_at, claimed.last_error, claimed.created_at,
        flashes.city, flashes.player, flashes.img, flashes.ipfs_cid,
        flashes.text, flashes.timestamp, flashes.flash_count
      FROM claimed
      JOIN flashes ON flashes.flash_id = claimed.flash_id
    `;
    return await this.query<ClaimedFlashJob>(sql, [stage, leaseMs, limit, maxAttempts]);
  }

  // expectedAttempts fences this settle against claim()'s lease: if another
  // worker has since reclaimed the job (attempts moved on), the WHERE clause
  // matches no row and the call is a silent no-op instead of clobbering the
  // live claim.
  async complete(
    client: Pool | PoolClient,
    flashId: number,
    stage: FlashJobStage,
    expectedAttempts: number
  ): Promise<void> {
    await client.query(`DELETE FROM flash_jobs WHERE flash_id = $1 AND stage = $2 AND attempts = $3`, [
      flashId,
      stage,
      expectedAttempts,
    ]);
  }

  async fail(
    flashId: number,
    stage: FlashJobStage,
    error: string,
    retryAtMs: number,
    expectedAttempts: number
  ): Promise<void> {
    await this.query(
      `UPDATE flash_jobs SET last_error = $3, next_attempt_at = $4
       WHERE flash_id = $1 AND stage = $2 AND attempts = $5`,
      [flashId, stage, error, new Date(retryAtMs), expectedAttempts]
    );
  }

  // TransientError contract: a transient failure must not consume an attempt,
  // so undo the increment claim() already applied for this attempt.
  async defer(flashId: number, stage: FlashJobStage, retryAtMs: number, expectedAttempts: number): Promise<void> {
    await this.query(
      `UPDATE flash_jobs
       SET attempts = GREATEST(attempts - 1, 0), next_attempt_at = $3
       WHERE flash_id = $1 AND stage = $2 AND attempts = $4`,
      [flashId, stage, new Date(retryAtMs), expectedAttempts]
    );
  }
}
