import { config } from "dotenv";
config();

import { Cron } from "croner";
import { getPool, closePool, withTransaction, FlashcastrUsersDb, PostgresFlashesDb, FlashJobsDb } from "@flashcastr/database";
import { createMetricsRegistry, Counter, Gauge } from "@flashcastr/metrics";
import { runService } from "@flashcastr/runtime";
import { createLogger } from "@flashcastr/logger";
import { intEnv, optionalEnv } from "@flashcastr/config";
import SpaceInvadersAPI, { type FlashInvaderFlash } from "./space-invaders-api.js";
import { loadRegisteredPlayers } from "./users-loader.js";
import { loadRecentFlashIds } from "./seed-loader.js";
import { RecentFlashCache } from "./recent-flash-cache.js";
import { writeFlashBatch } from "./flash-writer.js";

const log = createLogger("flash-engine");
const registry = createMetricsRegistry("flash-engine");

const flashesPublished = new Counter({
  name: "flash_engine_flashes_published_total",
  help: "Total new flashes written to Postgres",
  registers: [registry],
});

const apiCallsTotal = new Counter({
  name: "flash_engine_api_calls_total",
  help: "Total API calls to Space Invaders",
  labelNames: ["result"] as const,
  registers: [registry],
});

const lastFlashCount = new Gauge({
  name: "flash_engine_last_flash_count",
  help: "Last flash count from API",
  registers: [registry],
});

const parisFlashesFiltered = new Counter({
  name: "flash_engine_paris_flashes_filtered_total",
  help: "Paris flashes filtered (non-registered players)",
  registers: [registry],
});

const registeredPlayersGauge = new Gauge({
  name: "flash_engine_registered_players",
  help: "Current count of cached registered players",
  registers: [registry],
});

const usersRefreshedTotal = new Counter({
  name: "flash_engine_users_refreshed_total",
  help: "Times the registered players cache was refreshed from Postgres",
  registers: [registry],
});

const MAX_CACHE_SIZE = 10000;
const PEAK_START_HOUR = 6;
const PEAK_END_HOUR = 23;
const OFF_PEAK_SKIP_CHANCE = 0.5;
const USERS_REFRESH_SCHEDULE = "*/5 * * * *";
const USERS_REFRESH_INTERVAL_MS = 5 * 60_000;

const recentFlashCache = new RecentFlashCache(MAX_CACHE_SIZE);
let lastFlashCountValue: string | null = null;
let consecutiveNoChanges = 0;
let registeredPlayers = new Set<string>();
let registeredPlayersLoadedAt: number | null = null;

const api = new SpaceInvadersAPI();
const pool = getPool();
const usersDb = new FlashcastrUsersDb(pool);
const flashesDb = new PostgresFlashesDb(pool);
const flashJobsDb = new FlashJobsDb(pool);

let registeredPlayersRefresh: Promise<void> | null = null;

async function refreshRegisteredPlayers(): Promise<void> {
  if (registeredPlayersRefresh) return registeredPlayersRefresh;
  registeredPlayersRefresh = (async () => {
    registeredPlayers = await loadRegisteredPlayers(usersDb);
    registeredPlayersLoadedAt = Date.now();
    registeredPlayersGauge.set(registeredPlayers.size);
    usersRefreshedTotal.inc();
    log.info(`Refreshed registered players: ${registeredPlayers.size} from Postgres`);
  })().finally(() => {
    registeredPlayersRefresh = null;
  });
  return registeredPlayersRefresh;
}

const PARIS_HOUR_FORMAT = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "numeric", hourCycle: "h23" });

export function parisHour(now = new Date()): number {
  return parseInt(PARIS_HOUR_FORMAT.format(now), 10);
}

function isPeakFlashTime(): boolean {
  const hour = parisHour();
  return hour >= PEAK_START_HOUR && hour < PEAK_END_HOUR;
}

function shouldSkipUnchanged(currentFlashCount: string): boolean {
  if (lastFlashCountValue !== currentFlashCount) return false;
  consecutiveNoChanges++;
  const skipChance = Math.min(consecutiveNoChanges, 10) * 0.1;
  return Math.random() < skipChance;
}

async function fetchAndPublish(): Promise<void> {
  if (!isPeakFlashTime() && Math.random() < OFF_PEAK_SKIP_CHANCE) {
    log.debug("Skipping run during off-peak hours");
    return;
  }

  let flashes;
  try {
    flashes = await api.getFlashes();
    apiCallsTotal.inc({ result: "success" });
  } catch (error) {
    apiCallsTotal.inc({ result: "error" });
    log.error("Failed to fetch flashes:", error);
    return;
  }

  if (!flashes.with_paris.length && !flashes.without_paris.length) {
    log.warn("No flashes returned from API");
    return;
  }

  const currentFlashCount = flashes.flash_count;
  if (currentFlashCount) lastFlashCount.set(parseInt(currentFlashCount, 10) || 0);

  if (shouldSkipUnchanged(currentFlashCount)) {
    log.debug(`Backoff skip (${consecutiveNoChanges} consecutive unchanged)`);
    return;
  }

  log.info(`Flash count changed: ${lastFlashCountValue} → ${currentFlashCount}`);
  consecutiveNoChanges = 0;
  lastFlashCountValue = currentFlashCount;

  let parisFilteredCount = 0;
  const eligibleFlashes: FlashInvaderFlash[] = [];

  for (const flash of flashes.without_paris) {
    if (recentFlashCache.has(flash.flash_id)) continue;
    eligibleFlashes.push(flash);
  }

  const registeredPlayersStale =
    registeredPlayersLoadedAt === null || Date.now() - registeredPlayersLoadedAt >= USERS_REFRESH_INTERVAL_MS;
  if (registeredPlayersStale) {
    await refreshRegisteredPlayers().catch((err) => log.error("Failed to refresh registered players before filtering:", err));
  }

  for (const flash of flashes.with_paris) {
    if (recentFlashCache.has(flash.flash_id)) continue;

    if (!registeredPlayers.has(flash.player.toLowerCase())) {
      parisFilteredCount++;
      recentFlashCache.remember(flash.flash_id);
      continue;
    }

    eligibleFlashes.push(flash);
  }

  if (parisFilteredCount > 0) {
    parisFlashesFiltered.inc(parisFilteredCount);
    log.info(`Filtered ${parisFilteredCount} Paris flashes (non-registered players)`);
  }

  if (eligibleFlashes.length > 0) {
    await writeAndRememberBatch(eligibleFlashes);
  }
}

// Postgres is the sole correctness mechanism here: recentFlashCache is pure
// read-avoidance, so a batch is only remembered once its transaction commits.
// A rolled-back transaction writes nothing, so the whole batch is retried on
// the next poll instead of being silently dropped.
async function writeAndRememberBatch(eligibleFlashes: FlashInvaderFlash[]): Promise<void> {
  let insertedFlashIds: number[];
  try {
    insertedFlashIds = await withTransaction(pool, (client) =>
      writeFlashBatch(client, flashesDb, flashJobsDb, eligibleFlashes)
    );
  } catch (err) {
    log.error(`Failed to write flash batch of ${eligibleFlashes.length}:`, err);
    return;
  }

  for (const flash of eligibleFlashes) {
    recentFlashCache.remember(flash.flash_id);
  }

  if (insertedFlashIds.length > 0) {
    flashesPublished.inc(insertedFlashIds.length);
    log.info(`Wrote ${insertedFlashIds.length} new flashes`);
  }
}

const schedule = optionalEnv("CRON_SCHEDULE", "*/5 * * * *");

function registeredPlayersHealth(): { status: "ok" | "degraded"; message: string } {
  if (registeredPlayersLoadedAt === null) {
    return { status: "degraded", message: `${registeredPlayers.size} cached, never loaded` };
  }
  const ageMs = Date.now() - registeredPlayersLoadedAt;
  const status = registeredPlayers.size > 0 ? "ok" : "degraded";
  return { status, message: `${registeredPlayers.size} cached, ${Math.round(ageMs / 1000)}s old` };
}

runService("flash-engine", {
  registry,
  metricsPort: intEnv("METRICS_PORT", 9090),
  healthChecks: {
    registeredPlayers: registeredPlayersHealth,
  },
  start: async (ctx) => {
    ctx.onShutdown("postgres", () => closePool());

    await refreshRegisteredPlayers();

    const seededFlashIds = await loadRecentFlashIds(flashesDb, MAX_CACHE_SIZE);
    recentFlashCache.seed(seededFlashIds);
    log.info(`seeded ${seededFlashIds.size} known flashes`);

    fetchAndPublish().catch((err) => log.error("Initial fetch failed:", err));

    const fetchJob = new Cron(schedule, { protect: true }, () => {
      fetchAndPublish().catch((err) => log.error("Scheduled fetch failed:", err));
    });
    const usersJob = new Cron(USERS_REFRESH_SCHEDULE, () => {
      refreshRegisteredPlayers().catch((err) => log.error("Periodic registered players refresh failed:", err));
    });
    ctx.onShutdown("cron", () => {
      fetchJob.stop();
      usersJob.stop();
    });

    log.info(`flash-engine polling on schedule "${schedule}"`);
  },
});
