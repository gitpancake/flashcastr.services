import { config } from "dotenv";
config();

import type { ConsumeMessage } from "amqplib";
import { FlashcastrConsumer, FlashcastrPublisher, QUEUES, ROUTING_KEYS } from "@flashcastr/rabbitmq";
import { getPool, PostgresFlashesDb, FlashcastrUsersDb, closePool } from "@flashcastr/database";
import { createMetricsRegistry, startMetricsServer, Counter, Gauge } from "@flashcastr/metrics";
import { createLogger, flushLogs } from "@flashcastr/logger";
import { intEnv } from "@flashcastr/config";
import type { MessageEnvelope, ImagePinnedPayload, FlashStoredPayload, Flash, UsersBroadcastPayload } from "@flashcastr/shared-types";

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

const flashesRequeued = new Counter({
  name: "database_engine_flashes_requeued_total",
  help: "Flashes returned to the queue because the write or the FLASH_STORED publish failed",
  registers: [registry],
});

const usersBroadcastTotal = new Counter({
  name: "database_engine_users_broadcast_total",
  help: "Times users were broadcast",
  registers: [registry],
});

const usersBroadcastCount = new Gauge({
  name: "database_engine_users_broadcast_count",
  help: "Number of users in last broadcast",
  registers: [registry],
});

const BATCH_SIZE = intEnv("BATCH_SIZE", 50);
const BATCH_FLUSH_INTERVAL = intEnv("BATCH_FLUSH_INTERVAL_MS", 5000);
const BATCH_RETRY_DELAY_MS = intEnv("BATCH_RETRY_DELAY_MS", 5000);
const PINATA_GATEWAY = "https://gateway.pinata.cloud/ipfs";

interface PendingFlash {
  flash: Flash;
  correlationId: string;
  raw: ConsumeMessage;
}

const pool = getPool();
const flashesDb = new PostgresFlashesDb(pool);
const usersDb = new FlashcastrUsersDb(pool);
const publisher = new FlashcastrPublisher("database-engine");

async function broadcastUsers(): Promise<void> {
  try {
    const users = await usersDb.getAllActive();
    const usernames = users.map((u) => u.username.toLowerCase());
    const payload: UsersBroadcastPayload = { usernames };
    await publisher.publish(ROUTING_KEYS.USERS_BROADCAST, payload);
    usersBroadcastTotal.inc();
    usersBroadcastCount.set(usernames.length);
    log.info(`Broadcast ${usernames.length} users`);
  } catch (err) {
    log.error("Failed to broadcast users:", err);
  }
}

function toStoredPayload(flash: Flash): FlashStoredPayload {
  return {
    flash_id: flash.flash_id,
    img: flash.img,
    city: flash.city,
    player: flash.player,
    text: flash.text,
    timestamp: flash.timestamp,
    flash_count: flash.flash_count,
    ipfs_cid: flash.ipfs_cid || "",
    ipfs_url: flash.ipfs_cid ? `${PINATA_GATEWAY}/${flash.ipfs_cid}` : "",
    db_flash_id: flash.flash_id,
    stored_at: Date.now(),
  };
}

/**
 * Messages are acked only after the batch is in Postgres AND FLASH_STORED has
 * been confirmed by the broker. Anything else is requeued, which is safe
 * because writeMany is an idempotent upsert. Prefetch must exceed BATCH_SIZE
 * or the batch can never fill while its messages sit unacked.
 */
class DatabaseEngineConsumer extends FlashcastrConsumer<ImagePinnedPayload> {
  private pendingBatch: PendingFlash[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;

  constructor() {
    super("database-engine", QUEUES.IMAGE_PINNED, {
      manualAck: true,
      prefetch: Math.max(intEnv("CONSUMER_CONCURRENCY", 1), BATCH_SIZE * 2),
    });
  }

  protected async handleMessage(envelope: MessageEnvelope<ImagePinnedPayload>, raw: ConsumeMessage): Promise<void> {
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

    this.pendingBatch.push({ flash, correlationId: envelope.correlationId, raw });

    if (this.pendingBatch.length >= BATCH_SIZE) {
      await this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.pendingBatch.length === 0) return Promise.resolve();

    this.flushing = this.writeBatch().finally(() => {
      this.flushing = null;
      if (this.pendingBatch.length >= BATCH_SIZE) void this.flush();
      else if (this.pendingBatch.length > 0) this.scheduleFlush();
    });
    return this.flushing;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((err) => log.error("Flush error:", err));
    }, BATCH_FLUSH_INTERVAL);
  }

  private async writeBatch(): Promise<void> {
    const batch = this.pendingBatch;
    this.pendingBatch = [];
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    let written: Flash[];
    try {
      written = await flashesDb.writeMany(batch.map((b) => b.flash));
    } catch (error) {
      flashesFailed.inc(batch.length);
      flashesRequeued.inc(batch.length);
      log.error(`Batch store failed, requeueing ${batch.length} flashes:`, error);
      await Promise.all(batch.map((item) => this.requeue(item.raw, BATCH_RETRY_DELAY_MS)));
      return;
    }

    let published = 0;
    for (const item of batch) {
      try {
        await publisher.publish(ROUTING_KEYS.FLASH_STORED, toStoredPayload(item.flash), item.correlationId);
        this.ack(item.raw);
        flashesStored.inc();
        published++;
      } catch (err) {
        flashesRequeued.inc();
        log.error(`Failed to publish FLASH_STORED for ${item.flash.flash_id}, requeueing:`, err);
        void this.requeue(item.raw, BATCH_RETRY_DELAY_MS);
      }
    }

    log.info(`Batch stored: ${batch.length} flashes (${written.length} new/updated, ${published} published)`);
  }
}

class UsersRequestConsumer extends FlashcastrConsumer<Record<string, never>> {
  constructor() {
    super("database-engine", QUEUES.USERS_REQUEST);
  }

  protected async handleMessage(envelope: MessageEnvelope<Record<string, never>>, _raw: ConsumeMessage): Promise<void> {
    log.info(`Received users.request from ${envelope.source}`);
    await broadcastUsers();
  }
}

const metricsPort = intEnv("METRICS_PORT", 9090);
startMetricsServer(registry, metricsPort);

const consumer = new DatabaseEngineConsumer();
consumer.startConsuming().catch((err) => {
  log.error("Failed to start consumer:", err);
  process.exit(1);
});

const usersRequestConsumer = new UsersRequestConsumer();
usersRequestConsumer.startConsuming().catch((err) => {
  log.error("Failed to start users request consumer:", err);
});

broadcastUsers().catch((err) => log.error("Initial users broadcast failed:", err));

log.info("database-engine started");

const shutdown = async (signal: string) => {
  log.info(`Received ${signal}, shutting down...`);
  await consumer.flush();
  await consumer.close();
  await usersRequestConsumer.close();
  await publisher.close();
  await closePool();
  await flushLogs();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
