import type { Pool } from "pg";
import { PostgresFlashesDb } from "@flashcastr/database";
import { cacheHitsTotal, cacheMissesTotal } from "../metrics.js";

let trendingCitiesCache: { data: Array<{ city: string; count: number }>; timestamp: number } | null = null;
const TRENDING_CACHE_TTL = 24 * 60 * 60 * 1000;

export function createCityResolvers(pool: Pool) {
  const flashesDb = new PostgresFlashesDb(pool);

  return {
    Query: {
      getAllCities: async () => {
        return flashesDb.getAllCities();
      },

      getTrendingCities: async (_: unknown, args: { excludeParis?: boolean; hours?: number }) => {
        const { excludeParis = true, hours = 6 } = args;

        const now = Date.now();
        if (trendingCitiesCache && (now - trendingCitiesCache.timestamp) < TRENDING_CACHE_TTL) {
          cacheHitsTotal.inc({ cache_name: "trending_cities" });
          return trendingCitiesCache.data;
        }

        cacheMissesTotal.inc({ cache_name: "trending_cities" });

        const hoursAgo = new Date();
        hoursAgo.setHours(hoursAgo.getHours() - hours);

        const parisExclusion = excludeParis
          ? "AND city NOT IN ('Paris', 'paris', 'PARIS')"
          : "";

        const query = `
          SELECT city, COUNT(*) as count
          FROM flashes
          WHERE timestamp >= $1
            AND city IS NOT NULL
            ${parisExclusion}
          GROUP BY city
          ORDER BY count DESC
          LIMIT 10
        `;

        const result = await pool.query<{ city: string; count: string }>(query, [hoursAgo]);

        const trendingCities = result.rows.map(row => ({
          city: row.city,
          count: parseInt(row.count, 10),
        }));

        trendingCitiesCache = { data: trendingCities, timestamp: now };
        return trendingCities;
      },
    },
  };
}
