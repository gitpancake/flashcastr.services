import type { Pool } from "pg";
import { buildImageUrl, type ImageUrlConfig } from "@flashcastr/database";
import { WhereBuilder, clampLimit, pageOffset } from "../sql/where-builder.js";
import { decodeFlashCursor, encodeFlashCursor } from "../sql/cursor.js";

interface UnifiedFlashRow {
  flash_id: string;
  city: string | null;
  player: string | null;
  img: string | null;
  ipfs_cid: string | null;
  image_tier: string | null;
  text: string | null;
  timestamp: string | null;
  flash_count: string | null;
  farcaster_fid: number | null;
  farcaster_username: string | null;
  farcaster_pfp_url: string | null;
  farcaster_cast_hash: string | null;
  identification_id: number | null;
  identification_matched_flash_id: string | null;
  identification_matched_flash_name: string | null;
  identification_similarity: number | null;
  identification_confidence: number | null;
}

const DEFAULT_LIMIT = 20;

const UNIFIED_FLASH_SELECT = `
  SELECT
    f.flash_id::text as flash_id, f.city, f.player, f.img, f.ipfs_cid, f.image_tier,
    f.text, EXTRACT(EPOCH FROM f.timestamp)::bigint::text as timestamp, f.flash_count,
    ff.user_fid as farcaster_fid, ff.user_username as farcaster_username,
    ff.user_pfp_url as farcaster_pfp_url, ff.cast_hash as farcaster_cast_hash,
    fi.id as identification_id,
    fi.matched_flash_id::text as identification_matched_flash_id,
    fi.matched_flash_name as identification_matched_flash_name,
    fi.similarity as identification_similarity,
    fi.confidence as identification_confidence
  FROM flashes f
  LEFT JOIN flashcastr_flashes ff ON f.flash_id = ff.flash_id
  LEFT JOIN flash_identifications fi ON f.ipfs_cid = fi.source_ipfs_cid
`;

function mapRow(row: UnifiedFlashRow, imageUrlConfig: ImageUrlConfig) {
  return {
    flash_id: row.flash_id,
    city: row.city,
    player: row.player,
    img: row.img,
    ipfs_cid: row.ipfs_cid,
    image_url: buildImageUrl({ flash_id: row.flash_id, image_tier: row.image_tier, img: row.img }, imageUrlConfig),
    text: row.text,
    timestamp: row.timestamp,
    flash_count: row.flash_count,
    cursor: encodeFlashCursor(row.timestamp, row.flash_id),
    farcaster_user: row.farcaster_fid
      ? {
          fid: row.farcaster_fid,
          username: row.farcaster_username,
          pfp_url: row.farcaster_pfp_url,
          cast_hash: row.farcaster_cast_hash,
        }
      : null,
    identification: row.identification_id
      ? {
          id: row.identification_id,
          matched_flash_id: row.identification_matched_flash_id,
          matched_flash_name: row.identification_matched_flash_name,
          similarity: row.identification_similarity,
          confidence: row.identification_confidence,
        }
      : null,
  };
}

/** Keyset page: O(limit) regardless of depth. Ignores `page` — the cursor is the only position signal. */
function buildCursorQuery(where: WhereBuilder, limit: number, cursor: string): string {
  const { timestampEpochSeconds, flashId } = decodeFlashCursor(cursor);
  where.keysetBefore("f.timestamp", "f.flash_id", timestampEpochSeconds, flashId);
  return `${UNIFIED_FLASH_SELECT} ${where.clause()} ORDER BY COALESCE(f.timestamp, 'infinity'::timestamp) DESC, f.flash_id DESC ${where.limit(limit)}`;
}

/** Legacy LIMIT/OFFSET page: unchanged behavior for existing callers. */
function buildPageQuery(where: WhereBuilder, limit: number, page: number | undefined): string {
  const pagination = where.paginate(limit, pageOffset(page, limit));
  return `${UNIFIED_FLASH_SELECT} ${where.clause()} ORDER BY f.timestamp DESC ${pagination}`;
}

export function createUnifiedFlashResolvers(pool: Pool, imageUrlConfig: ImageUrlConfig) {
  return {
    Query: {
      unifiedFlash: async (_: unknown, args: { flash_id: string }) => {
        const result = await pool.query<UnifiedFlashRow>(`${UNIFIED_FLASH_SELECT} WHERE f.flash_id = $1`, [args.flash_id]);
        if (result.rows.length === 0) return null;
        return mapRow(result.rows[0], imageUrlConfig);
      },

      unifiedFlashes: async (
        _: unknown,
        args: { page?: number; limit?: number; city?: string; player?: string; cursor?: string }
      ) => {
        const limit = clampLimit(args.limit, DEFAULT_LIMIT);
        const where = new WhereBuilder().eqIgnoreCase("f.city", args.city).eqIgnoreCase("f.player", args.player);

        const query = args.cursor
          ? buildCursorQuery(where, limit, args.cursor)
          : buildPageQuery(where, limit, args.page);

        const result = await pool.query<UnifiedFlashRow>(query, where.params);
        return result.rows.map((row) => mapRow(row, imageUrlConfig));
      },
    },
  };
}
