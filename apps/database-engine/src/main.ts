import { config } from "dotenv";
config();

import type { ConsumeMessage } from "amqplib";
import { FlashcastrConsumer, FlashcastrPublisher, QUEUES, ROUTING_KEYS } from "@flashcastr/rabbitmq";
import { getPool, PostgresFlashesDb, closePool } from "@flashcastr/database";
import { createMetricsRegistry, startMetricsServer, Counter } from "@flashcastr/metrics";
import { createLogger } from "@flashcastr/logger";
import { intEnv } from "@flashcastr/config";
import type { MessageEnvelope, ImagePinnedPayload, FlashStoredPayload, Flash } from "@flashcastr/shared-types";

const log = createLogger("database-engine");
const registry = createMetricsRegistry("database-engine");

const flashesStored = new Counter({
  name: "database_engine_flashes_stored_total",
  help: "Total flashes stored in database",
  registers: [registry],
});

const flashesFailed = new Counter({
  name: "database_engine_flashes_failed_total",
  help: "Total flash storage failures",
  registers: [registry],
});

// Batch accumulator
const BATCH_SIZE = intEnv("BATCH_SIZE", 50);
const BATCH_FLUSH_INTERVAL = intEnv("BATCH_FLUSH_INTERVAL_MS", 5000);

interface PendingFlash {
  flash: Flash;
  correlationId: string;
}

let pendingBatch: PendingFlash[] = [];
let flushTimer: NodeJS.Timeout | null = null;

const pool = getPool();
const flashesDb = new PostgresFlashesDb(pool);
const publisher = new FlashcastrPublisher("database-engine");

async function flushBatch(): Promise<void> {
  if (pendingBatch.length === 0) return;

  const batch = pendingBatch;
  pendingBatch = [];

  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  try {
    const results = await flashesDb.writeMany(batch.map((b) => b.flash));

    for (const item of batch) {
      const payload: FlashStoredPayload = {
        flash_id: item.flash.flash_id,
        img: item.flash.img,
        city: item.flash.city,
        text: item.flash.text,
        player: item.flash.player,
        timestamp: item.flash.timestamp,
        flash_count: item.flash.flash_count,
        ipfs_cid: item.flash.ipfs_cid || "",
        ipfs_url: item.flash.ipfs_cid
          ? `https://gateway.pinata.cloud/ipfs/${item.flash.ipfs_cid}`
          : "",
        db_flash_id: item.flash.flash_id,
        stored_at: Date.now(),
      };

      try {
        await publisher.publish(ROUTING_KEYS.FLASH_STORED, payload, item.correlationId);
        flashesStored.inc();
      } catch (err) {
        log.error(`Failed to publish FLASH_STORED for ${item.flash.flash_id}:`, err);
      }
    }

    log.info(`Batch stored: ${batch.length} flashes (${results.length} new/updated)`);
  } catch (error) {
    flashesFailed.inc(batch.length);
    log.error(`Batch store failed:`, error);
    // Put back in batch for retry
    pendingBatch = [...batch, ...pendingBatch];
  }
}

function scheduleFlush(): void {
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushBatch().catch((err) => log.error("Flush error:", err));
    }, BATCH_FLUSH_INTERVAL);
  }
}

class DatabaseEngineConsumer extends FlashcastrConsumer<ImagePinnedPayload> {
  constructor() {
    super("database-engine", QUEUES.IMAGE_PINNED);
  }

  protected override shouldRequeueOnFailure(_error: Error): boolean {
    return true; // Always retry DB operations
  }

  protected async handleMessage(
    envelope: MessageEnvelope<ImagePinnedPayload>,
    _raw: ConsumeMessage
  ): Promise<void> {
    const payload = envelope.payload;

    const flash: Flash = {
      flash_id: payload.flash_id,
      img: payload.img,
      city: payload.city,
      text: payload.text,
      player: payload.player,
      timestamp: payload.timestamp,
      flash_count: payload.flash_count,
      ipfs_cid: payload.ipfs_cid,
    };

    pendingBatch.push({ flash, correlationId: envelope.correlationId });

    if (pendingBatch.length >= BATCH_SIZE) {
      await flushBatch();
    } else {
      scheduleFlush();
    }
  }
}

// Start
const metricsPort = intEnv("METRICS_PORT", 9090);
startMetricsServer(registry, metricsPort);

const consumer = new DatabaseEngineConsumer();
consumer.startConsuming().catch((err) => {
  log.error("Failed to start consumer:", err);
  process.exit(1);
});

log.info("database-engine started");

const shutdown = async (signal: string) => {
  log.info(`Received ${signal}, shutting down...`);
  await flushBatch();
  await consumer.close();
  await publisher.close();
  await closePool();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
