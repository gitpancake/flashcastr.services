import type { Pool } from "pg";
import { PostgresFlashesDb } from "@flashcastr/database";
import { intEnv } from "@flashcastr/config";
import { createCache } from "../cache.js";

interface TrendingCity {
  city: string;
  count: number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const TRENDING_LIMIT = 10;

export function createCityResolvers(pool: Pool) {
  const flashesDb = new PostgresFlashesDb(pool);
  const trendingCache = createCache<TrendingCity[]>("trending_cities", intEnv("TRENDING_CACHE_TTL_MS", ONE_DAY_MS));

  async function loadTrendingCities(excludeParis: boolean, hours: number): Promise<TrendingCity[]> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const parisExclusion = excludeParis ? "AND LOWER(city) <> 'paris'" : "";

    const result = await pool.query<{ city: string; count: string }>(
      `
        SELECT city, COUNT(*) as count
        FROM flashes
        WHERE timestamp >= $1
          AND city IS NOT NULL
          ${parisExclusion}
        GROUP BY city
        ORDER BY count DESC
        LIMIT $2
      `,
      [since, TRENDING_LIMIT]
    );

    return result.rows.map((row) => ({ city: row.city, count: parseInt(row.count, 10) }));
  }

  return {
    Query: {
      getAllCities: async () => flashesDb.getAllCities(),

      getTrendingCities: async (_: unknown, args: { excludeParis?: boolean; hours?: number }) => {
        const { excludeParis = true, hours = 6 } = args;
        const safeHours = Math.min(Math.max(1, Math.trunc(hours)), 24 * 30);
        return trendingCache(`${excludeParis}:${safeHours}`, () => loadTrendingCities(excludeParis, safeHours));
      },
    },
  };
}
