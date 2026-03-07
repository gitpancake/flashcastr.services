import { config } from "dotenv";
config();

import cron from "node-cron";
import { FlashcastrPublisher, ROUTING_KEYS } from "@flashcastr/rabbitmq";
import { createMetricsRegistry, startMetricsServer, Counter, Gauge } from "@flashcastr/metrics";
import { createLogger } from "@flashcastr/logger";
import { intEnv } from "@flashcastr/config";
import { getPool, FlashcastrUsersDb, closePool } from "@flashcastr/database";
import type { FlashReceivedPayload } from "@flashcastr/shared-types";
import SpaceInvadersAPI from "./space-invaders-api.js";

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

// In-memory LRU cache for deduplication
const recentFlashIds = new Set<number>();
const MAX_CACHE_SIZE = 10000;
let lastFlashCountValue: string | null = null;
let consecutiveNoChanges = 0;

// Cached set of registered flashcastr usernames (lowercase for case-insensitive matching)
let registeredPlayers = new Set<string>();
let lastUserRefresh = 0;
const USER_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

async function refreshRegisteredPlayers(): Promise<void> {
  try {
    const pool = getPool();
    const usersDb = new FlashcastrUsersDb(pool);
    const users = await usersDb.getMany({});
    registeredPlayers = new Set(users.map((u) => u.username.toLowerCase()));
    lastUserRefresh = Date.now();
    log.info(`Registered players cache: ${registeredPlayers.size} users`);
  } catch (err) {
    log.error("Failed to refresh registered players cache:", err);
    // Keep stale cache — fail open for registered users
  }
}

const publisher = new FlashcastrPublisher("flash-engine");
const api = new SpaceInvadersAPI();

function isPeakFlashTime(): boolean {
  const now = new Date();
  const cetHour = (now.getUTCHours() + 1) % 24;
  return cetHour >= 6 && cetHour < 23;
}

async function fetchAndPublish(): Promise<void> {
  // Off-peak optimization: skip 50% of runs
  if (!isPeakFlashTime() && Math.random() < 0.5) {
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

  if (!flashes || (!flashes.with_paris.length && !flashes.without_paris.length)) {
    log.warn("No flashes returned from API");
    return;
  }

  // Check if flash count changed
  const currentFlashCount = flashes.flash_count;
  if (currentFlashCount) lastFlashCount.set(parseInt(currentFlashCount, 10) || 0);

  if (lastFlashCountValue === currentFlashCount) {
    consecutiveNoChanges++;
    const shouldSkip = Math.random() < Math.min(consecutiveNoChanges, 10) * 0.1;
    if (shouldSkip) {
      log.debug(`Backoff skip (${consecutiveNoChanges} consecutive unchanged)`);
      return;
    }
    return;
  }

  log.info(`Flash count changed: ${lastFlashCountValue} → ${currentFlashCount}`);
  consecutiveNoChanges = 0;
  lastFlashCountValue = currentFlashCount;

  // Refresh user cache if stale
  if (Date.now() - lastUserRefresh > USER_REFRESH_INTERVAL_MS) {
    await refreshRegisteredPlayers();
  }

  let publishCount = 0;
  let parisFilteredCount = 0;

  async function processFlash(flash: { flash_id: number; img: string; city: string; text: string; player: string; timestamp: number; flash_count: string }) {
    if (recentFlashIds.has(flash.flash_id)) return;

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
      publishCount++;

      recentFlashIds.add(flash.flash_id);
      if (recentFlashIds.size > MAX_CACHE_SIZE) {
        const iterator = recentFlashIds.values();
        for (let i = 0; i < MAX_CACHE_SIZE / 2; i++) {
          recentFlashIds.delete(iterator.next().value!);
        }
      }
    } catch (err) {
      log.error(`Failed to publish flash ${flash.flash_id}:`, err);
    }
  }

  // All non-Paris flashes pass through
  for (const flash of flashes.without_paris) {
    await processFlash(flash);
  }

  // Paris flashes only for registered users
  for (const flash of flashes.with_paris) {
    if (recentFlashIds.has(flash.flash_id)) continue;

    if (!registeredPlayers.has(flash.player.toLowerCase())) {
      parisFilteredCount++;
      recentFlashIds.add(flash.flash_id);
      continue;
    }

    await processFlash(flash);
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

// Start
const metricsPort = intEnv("METRICS_PORT", 9090);
startMetricsServer(registry, metricsPort);

// Load registered players before first fetch
refreshRegisteredPlayers().catch((err) => log.error("Initial user cache load failed:", err));

// Run immediately once
fetchAndPublish().catch((err) => log.error("Initial fetch failed:", err));

// Schedule cron every 5 minutes
const schedule = process.env.CRON_SCHEDULE || "*/5 * * * *";
cron.schedule(schedule, () => {
  fetchAndPublish().catch((err) => log.error("Scheduled fetch failed:", err));
});

log.info(`flash-engine started (schedule: ${schedule})`);

// Graceful shutdown
const shutdown = async (signal: string) => {
  log.info(`Received ${signal}, shutting down...`);
  await publisher.close();
  await closePool();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
