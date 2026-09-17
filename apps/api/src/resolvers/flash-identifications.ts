import type { Pool } from "pg";
import { FlashIdentificationsDb } from "@flashcastr/database";
import { intEnv } from "@flashcastr/config";
import { SlidingWindowLimiter, withRateLimit } from "../rate-limit.js";
import { clampLimit } from "../sql/where-builder.js";

const ONE_MINUTE_MS = 60 * 1000;
const DEFAULT_LIMIT = 50;

export function createFlashIdentificationResolvers(pool: Pool) {
  const identificationsDb = new FlashIdentificationsDb(pool);
  const saveLimiter = new SlidingWindowLimiter(intEnv("RATE_LIMIT_IDENTIFICATION_PER_MIN", 60), ONE_MINUTE_MS);

  return {
    Query: {
      flashIdentifications: async (_: unknown, args: { ipfs_cid?: string; matched_flash_id?: string; limit?: number }) =>
        identificationsDb.listWithFlash({
          ipfs_cid: args.ipfs_cid,
          matched_flash_id: args.matched_flash_id,
          limit: clampLimit(args.limit, DEFAULT_LIMIT),
        }),

      flashIdentification: async (_: unknown, args: { id: number }) => identificationsDb.getByIdWithFlash(args.id),
    },

    Mutation: {
      saveFlashIdentification: withRateLimit("saveFlashIdentification", saveLimiter, async (_: unknown, args: {
        source_ipfs_cid: string;
        matched_flash_id: string;
        matched_flash_name?: string;
        similarity: number;
        confidence: number;
      }) => identificationsDb.upsert({ ...args, matched_flash_name: args.matched_flash_name || null })),
    },
  };
}
