import type { InboundCast } from "../farcaster/inboundCast.js";
import type { DatabasePool } from "../persistence/database.js";

export type InboundStatus = "claimed" | "replied" | "skipped" | "failed";

export class InboundCastRepository {
  constructor(private readonly pool: DatabasePool) {}

  async claim(cast: InboundCast): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO inbound_casts (cast_hash, thread_hash, parent_hash, author_fid, author_username, text, kind, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (cast_hash) DO NOTHING`,
      [cast.hash, cast.threadHash, cast.parentHash, cast.authorFid, cast.authorUsername, cast.text, cast.kind, cast.receivedAt],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async countFromAuthorSince(authorFid: number, since: Date): Promise<number> {
    const result = await this.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM inbound_casts WHERE author_fid = $1 AND received_at >= $2`,
      [authorFid, since],
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  async markStatus(castHash: string, status: InboundStatus): Promise<void> {
    await this.pool.query(`UPDATE inbound_casts SET status = $2, processed_at = now() WHERE cast_hash = $1`, [castHash, status]);
  }
}
