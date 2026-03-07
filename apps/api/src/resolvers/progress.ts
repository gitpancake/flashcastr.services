import type { Pool } from "pg";
import { GraphQLError } from "graphql";

export function createProgressResolvers(pool: Pool) {
  return {
    Query: {
      progress: async (_: unknown, args: { fid: number; days: number; order?: string }) => {
        const { fid, days, order = "ASC" } = args;

        if (days < 1 || days > 30) {
          throw new GraphQLError("Days parameter must be between 1 and 30.", {
            extensions: { code: "BAD_USER_INPUT" },
          });
        }

        const validOrder = order.toUpperCase();
        if (validOrder !== "ASC" && validOrder !== "DESC") {
          throw new GraphQLError("Order parameter must be 'ASC' or 'DESC'.", {
            extensions: { code: "BAD_USER_INPUT" },
          });
        }

        const query = `
          WITH date_range AS (
            SELECT generate_series(
              date_trunc('day', NOW() - INTERVAL '${days - 1} days'),
              date_trunc('day', NOW()),
              '1 day'::interval
            )::date AS date
          ),
          daily_counts AS (
            SELECT
              DATE(f.timestamp) as date,
              COUNT(*) as count
            FROM flashcastr_flashes ff
            INNER JOIN flashes f ON ff.flash_id = f.flash_id
            WHERE
              ff.user_fid = $1
              AND f.timestamp >= date_trunc('day', NOW() - INTERVAL '${days - 1} days')
              AND f.timestamp < date_trunc('day', NOW()) + INTERVAL '1 day'
              AND ff.deleted = false
            GROUP BY DATE(f.timestamp)
          )
          SELECT
            dr.date::text as date,
            COALESCE(dc.count, 0)::int as count
          FROM date_range dr
          LEFT JOIN daily_counts dc ON dr.date = dc.date
          ORDER BY dr.date ${validOrder}
        `;

        const result = await pool.query<{ date: string; count: number }>(query, [fid]);
        return result.rows;
      },
    },
  };
}
