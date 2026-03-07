import { Pool } from "pg";
import type { FlashIdentification } from "@flashcastr/shared-types";
import { Postgres } from "./postgres-base.js";

export class FlashIdentificationsDb extends Postgres<FlashIdentification> {
  constructor(pool: Pool) {
    super(pool);
  }

  async query_filtered(filter: {
    ipfs_cid?: string;
    matched_flash_id?: string;
    limit?: number;
  }): Promise<FlashIdentification[]> {
    const { limit = 50 } = filter;
    const params: unknown[] = [];
    const conditions: string[] = [];
    let paramIndex = 1;

    if (filter.ipfs_cid) {
      conditions.push(`source_ipfs_cid = $${paramIndex++}`);
      params.push(filter.ipfs_cid);
    }
    if (filter.matched_flash_id) {
      conditions.push(`matched_flash_id = $${paramIndex++}`);
      params.push(filter.matched_flash_id);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const sql = `
      SELECT id, source_ipfs_cid, matched_flash_id, matched_flash_name,
             similarity, confidence, created_at::text as created_at
      FROM flash_identifications
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex}
    `;

    return await this.query(sql, params);
  }

  async getById(id: number): Promise<FlashIdentification | null> {
    return this.queryOne(
      `SELECT id, source_ipfs_cid, matched_flash_id, matched_flash_name,
              similarity, confidence, created_at::text as created_at
       FROM flash_identifications WHERE id = $1`,
      [id]
    );
  }

  async upsert(data: {
    source_ipfs_cid: string;
    matched_flash_id: string;
    matched_flash_name?: string | null;
    similarity: number;
    confidence: number;
  }): Promise<FlashIdentification | null> {
    const sql = `
      INSERT INTO flash_identifications (source_ipfs_cid, matched_flash_id, matched_flash_name, similarity, confidence)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (source_ipfs_cid) DO UPDATE SET
        matched_flash_id = EXCLUDED.matched_flash_id,
        matched_flash_name = EXCLUDED.matched_flash_name,
        similarity = EXCLUDED.similarity,
        confidence = EXCLUDED.confidence,
        created_at = CURRENT_TIMESTAMP
      RETURNING id, source_ipfs_cid, matched_flash_id::text as matched_flash_id,
                matched_flash_name, similarity, confidence, created_at::text as created_at
    `;
    return this.queryOne(sql, [
      data.source_ipfs_cid,
      data.matched_flash_id,
      data.matched_flash_name ?? null,
      data.similarity,
      data.confidence,
    ]);
  }
}
