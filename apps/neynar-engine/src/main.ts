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
import {
  getPool,
  FlashcastrFlashesDb,
  FlashcastrUsersDb,
  FlashJobsDb,
  withTransaction,
  closePool,
  notifyFlashCasted,
} from "@flashcastr/database";
import { JobWorker, observeJobBacklog } from "@flashcastr/jobs";
import { decrypt } from "@flashcastr/crypto";
import { createMetricsRegistry, Counter } from "@flashcastr/metrics";
import { runService } from "@flashcastr/runtime";
import { createLogger } from "@flashcastr/logger";
import { requireEnv, intEnv } from "@flashcastr/config";
import type { MessageEnvelope, FlashStoredPayload } from "@flashcastr/shared-types";
import { NeynarCastGateway } from "./neynarCastGateway.js";
import { FlashCaster, type CastableFlash } from "./flashCaster.js";
import { completeCastJob } from "./cast-completion.js";

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
const flashJobsDb = new FlashJobsDb(pool);
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

// Shared retry policy between NeynarEngineConsumer (RabbitMQ path) and
// castJobWorker (Postgres cast-job path) — same failures are non-retryable
// on both paths.
function isRetryableCastError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  if (msg.includes("no user found") || msg.includes("not a flashcastr user")) return false;
  if (msg.includes("revoked") || msg.includes("403") || msg.includes("forbidden")) return false;
  return true;
}

class NeynarEngineConsumer extends FlashcastrConsumer<FlashStoredPayload> {
  constructor(
    private readonly flashCaster: FlashCaster,
    private readonly publisher: FlashcastrPublisher,
    options: ConsumerOptions = {}
  ) {
    super("neynar-engine", QUEUES.FLASH_STORED, options);
  }

  protected override shouldRequeueOnFailure(error: Error): boolean {
    return isRetryableCastError(error);
  }

  protected async handleMessage(
    envelope: MessageEnvelope<FlashStoredPayload>,
    _raw: ConsumeMessage
  ): Promise<void> {
    const castedPayload = await this.flashCaster.handle(envelope.payload);
    if (!castedPayload) return;
    await this.publisher.publish(ROUTING_KEYS.FLASH_CASTED, castedPayload, envelope.correlationId);
    notifyFlashCasted(pool, castedPayload).catch((notifyErr) =>
      log.warn(`Failed to send flash_casted NOTIFY for ${castedPayload.flash_id}:`, notifyErr)
    );
  }
}

const consumer = new NeynarEngineConsumer(flashCaster, publisher, { registry });
const retryInterval = intEnv("RETRY_INTERVAL_MS", 300000);

const CAST_JOB_CONCURRENCY = intEnv("CAST_JOB_CONCURRENCY", 5);
const CAST_JOB_LEASE_MS = intEnv("CAST_JOB_LEASE_MS", 60000);
const CAST_JOB_MAX_ATTEMPTS = intEnv("CAST_JOB_MAX_ATTEMPTS", 5);
const CAST_JOB_POLL_INTERVAL_MS = intEnv("CAST_JOB_POLL_INTERVAL_MS", 1000);

const castJobWorker = new JobWorker(flashJobsDb, {
  stage: "cast",
  concurrency: CAST_JOB_CONCURRENCY,
  leaseMs: CAST_JOB_LEASE_MS,
  maxAttempts: CAST_JOB_MAX_ATTEMPTS,
  pollIntervalMs: CAST_JOB_POLL_INTERVAL_MS,
  shouldRetry: isRetryableCastError,
  handle: async (job) => {
    const castableFlash: CastableFlash = {
      flash_id: job.flash_id,
      city: job.city,
      player: job.player,
      img: job.img,
      ipfs_cid: job.ipfs_cid,
      text: job.text,
      timestamp: Math.floor(job.timestamp.getTime() / 1000),
      flash_count: job.flash_count,
    };
    const castedPayload = await flashCaster.handle(castableFlash);

    await withTransaction(pool, async (client) => {
      await completeCastJob(client, flashJobsDb, job.flash_id, job.attempts, castedPayload, notifyFlashCasted);
    });
  },
});

runService("neynar-engine", {
  registry,
  metricsPort: intEnv("METRICS_PORT", 9090),
  healthChecks: {
    rabbitmq: () => ({ status: consumer.isConsuming() ? "ok" : "error" }),
    castJobs: () => ({ status: castJobWorker.isRunning() ? "ok" : "error" }),
    postgres: async () => {
      await pool.query("SELECT 1");
      return { status: "ok" };
    },
  },
  start: async (ctx) => {
    ctx.onShutdown("postgres", () => closePool());
    ctx.onShutdown("publisher", () => publisher.close());
    ctx.onShutdown("consumer", () => consumer.close());
    ctx.onShutdown("cast-job-worker", () => castJobWorker.close());

    await flashCaster.checkSignerStatuses();
    await consumer.startConsuming();
    castJobWorker.start();
    ctx.onShutdown("queue-depths", observeQueueDepths(registry, [consumer]));
    ctx.onShutdown(
      "job-backlog",
      observeJobBacklog(registry, pool, [{ stage: "cast", maxAttempts: CAST_JOB_MAX_ATTEMPTS }])
    );

    const retryTimer = setInterval(() => {
      flashCaster.retryFailedCasts().catch((err) => log.error("Retry interval error:", err));
    }, retryInterval);
    ctx.onShutdown("retry-worker", () => clearInterval(retryTimer));
  },
});
