import type { Pool } from "pg";
import type { Logger } from "@flashcastr/logger";

import { activeUsersTotal, totalFlashesCount } from "./metrics.js";

export const GAUGE_UPDATE_INTERVAL_MS = 10 * 60 * 1000;

export function scheduleGaugeUpdates(
  pool: Pool,
  log: Logger,
  intervalMs: number = GAUGE_UPDATE_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  const handle = setInterval(() => updateGauges(pool, log), intervalMs);
  updateGauges(pool, log);
  return handle;
}

export async function updateGauges(pool: Pool, log: Logger): Promise<void> {
  try {
    const userResult = await pool.query("SELECT COUNT(*)::int as count FROM flashcastr_users");
    activeUsersTotal.set(userResult.rows[0]?.count ?? 0);

    const flashResult = await pool.query("SELECT COUNT(*)::int as count FROM flashcastr_flashes");
    totalFlashesCount.set(flashResult.rows[0]?.count ?? 0);
  } catch (error) {
    log.error("Error updating gauges:", error);
  }
}
