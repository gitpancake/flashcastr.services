import type { Pool } from "pg";
import { createLogger } from "@flashcastr/logger";
import { neynarRequestsTotal } from "../metrics.js";
import { createCache } from "../cache.js";
import { clampLimit } from "../sql/where-builder.js";
import neynarClient from "../neynar/client.js";

const log = createLogger("api");

interface LeaderboardRow {
  fid: number;
  username: string | null;
  pfp_url: string | null;
  flash_count: number;
  city_count: number;
}

interface LeaderboardEntry {
  username: string;
  pfp_url: string | null;
  flash_count: number;
  city_count: number;
}

const LEADERBOARD_CACHE_TTL = 60 * 60 * 1000;
const DEFAULT_LIMIT = 100;

export function createLeaderboardResolvers(pool: Pool) {
  const leaderboardCache = createCache<LeaderboardEntry[]>("leaderboard", LEADERBOARD_CACHE_TTL);

  async function farcasterProfiles(fids: number[]): Promise<Map<number, { username: string; pfp_url: string }>> {
    const profiles = new Map<number, { username: string; pfp_url: string }>();
    if (fids.length === 0) return profiles;

    try {
      neynarRequestsTotal.inc({ endpoint: "fetchBulkUsers", status: "attempt" });
      const { users } = await neynarClient.fetchBulkUsers({ fids });
      neynarRequestsTotal.inc({ endpoint: "fetchBulkUsers", status: "success" });
      for (const user of users) {
        if (user.username) profiles.set(user.fid, { username: user.username, pfp_url: user.pfp_url ?? "" });
      }
    } catch (error) {
      neynarRequestsTotal.inc({ endpoint: "fetchBulkUsers", status: "error" });
      log.error("[getLeaderboard] Error fetching Farcaster data:", error);
    }
    return profiles;
  }

  async function loadLeaderboard(limit: number): Promise<LeaderboardEntry[]> {
    const result = await pool.query<LeaderboardRow>(
      `
        SELECT
          u.fid,
          MAX(ff.user_username) as username,
          MAX(ff.user_pfp_url) as pfp_url,
          COUNT(ff.flash_id)::int as flash_count,
          COUNT(DISTINCT f.city)::int as city_count
        FROM flashcastr_users u
        LEFT JOIN flashcastr_flashes ff ON ff.user_fid = u.fid AND ff.deleted = false
        LEFT JOIN flashes f ON f.flash_id = ff.flash_id
        WHERE u.deleted = false
        GROUP BY u.fid
        ORDER BY flash_count DESC, city_count DESC
        LIMIT $1
      `,
      [limit]
    );

    const missingUsernames = result.rows.filter((row) => !row.username && row.flash_count > 0).map((row) => row.fid);
    const profiles = await farcasterProfiles(missingUsernames);

    return result.rows
      .map((row) => ({
        username: row.username || profiles.get(row.fid)?.username || null,
        pfp_url: row.pfp_url || profiles.get(row.fid)?.pfp_url || null,
        flash_count: row.flash_count,
        city_count: row.city_count,
      }))
      .filter((entry): entry is LeaderboardEntry => entry.username !== null);
  }

  return {
    Query: {
      getLeaderboard: async (_: unknown, args: { limit?: number }) => {
        const limit = clampLimit(args.limit, DEFAULT_LIMIT);
        return leaderboardCache(`limit:${limit}`, () => loadLeaderboard(limit));
      },
    },
  };
}
