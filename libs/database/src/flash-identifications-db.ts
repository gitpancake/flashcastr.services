import { Pool } from "pg";
import type { FlashIdentification } from "@flashcastr/shared-types";
import { Postgres } from "./postgres-base.js";

export interface MatchedFlash {
  flash_id: string;
  city: string | null;
  player: string | null;
  img: string | null;
  ipfs_cid: string | null;
  text: string | null;
  timestamp: string | null;
  flash_count: string | null;
}

export interface FlashIdentificationWithFlash {
  id: number;
  source_ipfs_cid: string;
  matched_flash_id: string;
  matched_flash_name: string | null;
  similarity: number;
  confidence: number;
  created_at: string;
  matched_flash: MatchedFlash | null;
}

export interface FlashIdentificationSummary {
  id: number;
  matched_flash_id: string;
  matched_flash_name: string | null;
  similarity: number;
  confidence: number;
}

interface JoinedRow {
  id: number;
  source_ipfs_cid: string;
  matched_flash_id: string;
  matched_flash_name: string | null;
  similarity: number;
  confidence: number;
  created_at: string;
  flash_id: string | null;
  city: string | null;
  player: string | null;
  img: string | null;
  flash_ipfs_cid: string | null;
  text: string | null;
  flash_timestamp: string | null;
  flash_count: string | null;
}

const JOINED_SELECT = `
  SELECT
    fi.id,
    fi.source_ipfs_cid,
    fi.matched_flash_id::text as matched_flash_id,
    fi.matched_flash_name,
    fi.similarity,
    fi.confidence,
    fi.created_at::text as created_at,
    f.flash_id::text as flash_id,
    f.city, f.player, f.img, f.ipfs_cid as flash_ipfs_cid,
    f.text, EXTRACT(EPOCH FROM f.timestamp)::bigint::text as flash_timestamp, f.flash_count
  FROM flash_identifications fi
  LEFT JOIN flashes f ON fi.matched_flash_id = f.flash_id
`;

function toIdentificationWithFlash(row: JoinedRow): FlashIdentificationWithFlash {
  return {
    id: row.id,
    source_ipfs_cid: row.source_ipfs_cid,
    matched_flash_id: row.matched_flash_id,
    matched_flash_name: row.matched_flash_name,
    similarity: row.similarity,
    confidence: row.confidence,
    created_at: row.created_at,
    matched_flash: row.flash_id
      ? {
          flash_id: row.flash_id,
          city: row.city,
          player: row.player,
          img: row.img,
          ipfs_cid: row.flash_ipfs_cid,
          text: row.text,
          timestamp: row.flash_timestamp,
          flash_count: row.flash_count,
        }
      : null,
  };
}

export class FlashIdentificationsDb extends Postgres<FlashIdentification> {
  constructor(pool: Pool) {
    super(pool);
  }

  async listWithFlash(filter: { ipfs_cid?: string; matched_flash_id?: string; limit: number }): Promise<FlashIdentificationWithFlash[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.ipfs_cid) {
      params.push(filter.ipfs_cid);
      conditions.push(`fi.source_ipfs_cid = $${params.length}`);
    }
    if (filter.matched_flash_id) {
      params.push(filter.matched_flash_id);
      conditions.push(`fi.matched_flash_id = $${params.length}`);
    }
    params.push(filter.limit);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await this.query<JoinedRow>(
      `${JOINED_SELECT} ${whereClause} ORDER BY fi.created_at DESC LIMIT $${params.length}`,
      params
    );
    return rows.map(toIdentificationWithFlash);
  }

  async getByIdWithFlash(id: number): Promise<FlashIdentificationWithFlash | null> {
    const row = await this.queryOne<JoinedRow>(`${JOINED_SELECT} WHERE fi.id = $1`, [id]);
    return row ? toIdentificationWithFlash(row) : null;
  }

  async upsert(data: {
    source_ipfs_cid: string;
    matched_flash_id: string;
    matched_flash_name?: string | null;
    similarity: number;
    confidence: number;
  }): Promise<FlashIdentificationSummary | null> {
    const sql = `
      INSERT INTO flash_identifications (source_ipfs_cid, matched_flash_id, matched_flash_name, similarity, confidence)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (source_ipfs_cid) DO UPDATE SET
        matched_flash_id = EXCLUDED.matched_flash_id,
        matched_flash_name = EXCLUDED.matched_flash_name,
        similarity = EXCLUDED.similarity,
        confidence = EXCLUDED.confidence,
        created_at = CURRENT_TIMESTAMP
      RETURNING id, matched_flash_id::text as matched_flash_id, matched_flash_name, similarity, confidence
    `;
    return this.queryOne<FlashIdentificationSummary>(sql, [
      data.source_ipfs_cid,
      data.matched_flash_id,
      data.matched_flash_name ?? null,
      data.similarity,
      data.confidence,
    ]);
  }
}
