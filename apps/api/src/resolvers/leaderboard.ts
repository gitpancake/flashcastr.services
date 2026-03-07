import type { Pool } from "pg";
import { cacheHitsTotal, cacheMissesTotal, neynarRequestsTotal } from "../metrics.js";
import neynarClient from "../neynar/client.js";

let leaderboardCache: {
  data: Array<{ username: string; pfp_url: string | null; flash_count: number; city_count: number }>;
  timestamp: number;
} | null = null;
const LEADERBOARD_CACHE_TTL = 60 * 60 * 1000;

export function createLeaderboardResolvers(pool: Pool) {
  return {
    Query: {
      getLeaderboard: async (_: unknown, args: { limit?: number }) => {
        const { limit = 100 } = args;
        const validatedLimit = Math.min(Math.max(1, limit), 500);

        const now = Date.now();
        if (leaderboardCache && (now - leaderboardCache.timestamp) < LEADERBOARD_CACHE_TTL) {
          cacheHitsTotal.inc({ cache_name: "leaderboard" });
          return leaderboardCache.data.slice(0, validatedLimit);
        }

        cacheMissesTotal.inc({ cache_name: "leaderboard" });

        const query = `
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
        `;

        const result = await pool.query<{
          fid: number;
          username: string | null;
          pfp_url: string | null;
          flash_count: number;
          city_count: number;
        }>(query, [validatedLimit]);

        // Fetch Farcaster data for users with null usernames
        const fidsNeedingUsernames = result.rows
          .filter(row => !row.username && row.flash_count > 0)
          .map(row => row.fid);

        const farcasterDataMap = new Map<number, { username: string; pfp_url: string }>();

        if (fidsNeedingUsernames.length > 0) {
          try {
            neynarRequestsTotal.inc({ endpoint: "fetchBulkUsers", status: "attempt" });
            const { users } = await neynarClient.fetchBulkUsers({ fids: fidsNeedingUsernames });
            neynarRequestsTotal.inc({ endpoint: "fetchBulkUsers", status: "success" });

            users.forEach(user => {
              if (user.username) {
                farcasterDataMap.set(user.fid, {
                  username: user.username,
                  pfp_url: user.pfp_url ?? "",
                });
              }
            });
          } catch (error) {
            neynarRequestsTotal.inc({ endpoint: "fetchBulkUsers", status: "error" });
            console.error("[getLeaderboard] Error fetching Farcaster data:", error);
          }
        }

        const leaderboardData = result.rows
          .map(row => ({
            username: row.username || farcasterDataMap.get(row.fid)?.username || null,
            pfp_url: row.pfp_url || farcasterDataMap.get(row.fid)?.pfp_url || null,
            flash_count: row.flash_count,
            city_count: row.city_count,
          }))
          .filter((entry): entry is { username: string; pfp_url: string | null; flash_count: number; city_count: number } =>
            entry.username !== null
          );

        leaderboardCache = { data: leaderboardData, timestamp: now };
        return leaderboardData;
      },
    },
  };
}
