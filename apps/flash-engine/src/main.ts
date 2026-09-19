import { config } from "dotenv";
config();

import { Cron } from "croner";
import { FlashcastrPublisher, ROUTING_KEYS } from "@flashcastr/rabbitmq";
import { getPool, closePool, FlashcastrUsersDb, PostgresFlashesDb } from "@flashcastr/database";
import { createMetricsRegistry, Counter, Gauge } from "@flashcastr/metrics";
import { runService } from "@flashcastr/runtime";
import { createLogger } from "@flashcastr/logger";
import { intEnv, optionalEnv } from "@flashcastr/config";
import type { FlashReceivedPayload } from "@flashcastr/shared-types";
import SpaceInvadersAPI, { type FlashInvaderFlash } from "./space-invaders-api.js";
import { loadRegisteredPlayers } from "./users-loader.js";
import { loadRecentFlashIds } from "./seed-loader.js";

const log = createLogger("flash-engine");
const registry = createMetricsRegistry("flash-engine");

const flashesPublished = new Counter({
  name: "flash_engine_flashes_published_total",
  help: "Total flashes published to RabbitMQ",
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

const recentFlashIds = new Set<number>();
let lastFlashCountValue: string | null = null;
let consecutiveNoChanges = 0;
let registeredPlayers = new Set<string>();
let registeredPlayersLoadedAt: number | null = null;

const publisher = new FlashcastrPublisher("flash-engine");
const api = new SpaceInvadersAPI();
const pool = getPool();
const usersDb = new FlashcastrUsersDb(pool);
const flashesDb = new PostgresFlashesDb(pool);

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

function rememberFlash(flashId: number): void {
  recentFlashIds.add(flashId);
  if (recentFlashIds.size <= MAX_CACHE_SIZE) return;
  const iterator = recentFlashIds.values();
  for (let i = 0; i < MAX_CACHE_SIZE / 2; i++) {
    recentFlashIds.delete(iterator.next().value!);
  }
}

async function publishFlash(flash: FlashInvaderFlash): Promise<boolean> {
  if (recentFlashIds.has(flash.flash_id)) return false;

  const payload: FlashReceivedPayload = {
    flash_id: flash.flash_id,
    img: flash.img,
    city: flash.city,
    text: flash.text,
    player: flash.player,
    timestamp: flash.timestamp,
    flash_count: flash.flash_count,
  };

  try {
    await publisher.publish(ROUTING_KEYS.FLASH_RECEIVED, payload);
    rememberFlash(flash.flash_id);
    return true;
  } catch (err) {
    log.error(`Failed to publish flash ${flash.flash_id}:`, err);
    return false;
  }
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

  let publishCount = 0;
  let parisFilteredCount = 0;

  for (const flash of flashes.without_paris) {
    if (await publishFlash(flash)) publishCount++;
  }

  const registeredPlayersStale =
    registeredPlayersLoadedAt === null || Date.now() - registeredPlayersLoadedAt >= USERS_REFRESH_INTERVAL_MS;
  if (registeredPlayersStale) {
    await refreshRegisteredPlayers().catch((err) => log.error("Failed to refresh registered players before filtering:", err));
  }

  for (const flash of flashes.with_paris) {
    if (recentFlashIds.has(flash.flash_id)) continue;

    if (!registeredPlayers.has(flash.player.toLowerCase())) {
      parisFilteredCount++;
      rememberFlash(flash.flash_id);
      continue;
    }

    if (await publishFlash(flash)) publishCount++;
  }

  if (parisFilteredCount > 0) {
    parisFlashesFiltered.inc(parisFilteredCount);
    log.info(`Filtered ${parisFilteredCount} Paris flashes (non-registered players)`);
  }

  if (publishCount > 0) {
    flashesPublished.inc(publishCount);
    log.info(`Published ${publishCount} flashes`);
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
    rabbitmq: () => ({ status: publisher.isConnected() ? "ok" : "degraded" }),
    registeredPlayers: registeredPlayersHealth,
  },
  start: async (ctx) => {
    ctx.onShutdown("postgres", () => closePool());
    ctx.onShutdown("publisher", () => publisher.close());

    await refreshRegisteredPlayers();

    const seededFlashIds = await loadRecentFlashIds(flashesDb, MAX_CACHE_SIZE);
    for (const flashId of seededFlashIds) recentFlashIds.add(flashId);
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
