import type { Pool } from "pg";
import type { Request, Response } from "express";
import type { B2TokenProvider } from "./b2/tokenProvider.js";
import { createCache } from "./cache.js";

const FLASH_ID_PATTERN = /^\d+$/;
const ROW_CACHE_TTL_MS = 30000;

export interface ImageRedirectRow {
  image_tier: string | null;
  ipfs_cid: string | null;
}

export interface ImageRedirectConfig {
  readonly b2DownloadBase: string;
  readonly b2Bucket: string;
}

export function createImageRedirectHandler(
  pool: Pool,
  tokenProvider: B2TokenProvider,
  config: ImageRedirectConfig,
): (req: Request, res: Response) => Promise<void> {
  const rowCache = createCache<ImageRedirectRow | null>("image_redirect_row", ROW_CACHE_TTL_MS);

  async function loadRow(flashId: string): Promise<ImageRedirectRow | null> {
    const result = await pool.query<ImageRedirectRow>(
      "SELECT image_tier, ipfs_cid FROM flashes WHERE flash_id = $1::bigint",
      [flashId],
    );
    return result.rows[0] ?? null;
  }

  return async (req: Request, res: Response): Promise<void> => {
    const flashId = req.params.flash_id;
    if (typeof flashId !== "string" || !FLASH_ID_PATTERN.test(flashId)) {
      res.status(404).end();
      return;
    }

    const row = await rowCache(flashId, () => loadRow(flashId));
    const isMissingImage = !row || !row.image_tier || !row.ipfs_cid;
    if (isMissingImage) {
      res.status(404).end();
      return;
    }

    const token = await tokenProvider.getToken(row.image_tier as string);
    if (!token) {
      res.status(503).end();
      return;
    }

    const targetUrl = `${config.b2DownloadBase}/file/${config.b2Bucket}/${row.image_tier}/${row.ipfs_cid}?Authorization=${token}`;
    res.set("Cache-Control", "public, max-age=3600");
    res.redirect(targetUrl);
  };
}
