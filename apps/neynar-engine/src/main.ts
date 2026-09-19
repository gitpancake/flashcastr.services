import { config } from "dotenv";
config();

import type { ConsumeMessage } from "amqplib";
import {
  FlashcastrConsumer,
  FlashcastrPublisher,
  QUEUES,
  ROUTING_KEYS,
  observeQueueDepths,
  type ConsumerOptions,
} from "@flashcastr/rabbitmq";
import { getPool, FlashcastrFlashesDb, FlashcastrUsersDb, closePool } from "@flashcastr/database";
import { decrypt } from "@flashcastr/crypto";
import { createMetricsRegistry, Counter } from "@flashcastr/metrics";
import { runService } from "@flashcastr/runtime";
import { createLogger } from "@flashcastr/logger";
import { requireEnv, intEnv } from "@flashcastr/config";
import type { MessageEnvelope, FlashStoredPayload } from "@flashcastr/shared-types";
import { NeynarCastGateway } from "./neynarCastGateway.js";
import { FlashCaster } from "./flashCaster.js";

const log = createLogger("neynar-engine");
const registry = createMetricsRegistry("neynar-engine");

const castsPublished = new Counter({
  name: "neynar_engine_casts_published_total",
  help: "Total casts published to Farcaster",
  registers: [registry],
});

const NEYNAR_API_KEY = requireEnv("NEYNAR_API_KEY");
const SIGNER_ENCRYPTION_KEY = requireEnv("SIGNER_ENCRYPTION_KEY");

const pool = getPool();
const flashcastrFlashesDb = new FlashcastrFlashesDb(pool);
const flashcastrUsersDb = new FlashcastrUsersDb(pool);
const publisher = new FlashcastrPublisher("neynar-engine");
const castGateway = new NeynarCastGateway({ apiKey: NEYNAR_API_KEY });

const flashCaster = new FlashCaster({
  users: flashcastrUsersDb,
  flashes: flashcastrFlashesDb,
  gateway: castGateway,
  decrypt,
  signerEncryptionKey: SIGNER_ENCRYPTION_KEY,
  castsPublished,
});

class NeynarEngineConsumer extends FlashcastrConsumer<FlashStoredPayload> {
  constructor(
    private readonly flashCaster: FlashCaster,
    private readonly publisher: FlashcastrPublisher,
    options: ConsumerOptions = {}
  ) {
    super("neynar-engine", QUEUES.FLASH_STORED, options);
  }

  protected override shouldRequeueOnFailure(error: Error): boolean {
    const msg = error.message.toLowerCase();
    if (msg.includes("no user found") || msg.includes("not a flashcastr user")) return false;
    if (msg.includes("revoked") || msg.includes("403") || msg.includes("forbidden")) return false;
    return true;
  }

  protected async handleMessage(
    envelope: MessageEnvelope<FlashStoredPayload>,
    _raw: ConsumeMessage
  ): Promise<void> {
    const castedPayload = await this.flashCaster.handle(envelope.payload);
    if (!castedPayload) return;
    await this.publisher.publish(ROUTING_KEYS.FLASH_CASTED, castedPayload, envelope.correlationId);
  }
}

const consumer = new NeynarEngineConsumer(flashCaster, publisher, { registry });
const retryInterval = intEnv("RETRY_INTERVAL_MS", 300000);

runService("neynar-engine", {
  registry,
  metricsPort: intEnv("METRICS_PORT", 9090),
  healthChecks: {
    rabbitmq: () => ({ status: consumer.isConsuming() ? "ok" : "error" }),
    postgres: async () => {
      await pool.query("SELECT 1");
      return { status: "ok" };
    },
  },
  start: async (ctx) => {
    ctx.onShutdown("postgres", () => closePool());
    ctx.onShutdown("publisher", () => publisher.close());
    ctx.onShutdown("consumer", () => consumer.close());

    await flashCaster.checkSignerStatuses();
    await consumer.startConsuming();
    ctx.onShutdown("queue-depths", observeQueueDepths(registry, [consumer]));

    const retryTimer = setInterval(() => {
      flashCaster.retryFailedCasts().catch((err) => log.error("Retry interval error:", err));
    }, retryInterval);
    ctx.onShutdown("retry-worker", () => clearInterval(retryTimer));
  },
});
