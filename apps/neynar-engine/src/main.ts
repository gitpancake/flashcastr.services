import { config } from "dotenv";
config();

import {
  getPool,
  FlashcastrFlashesDb,
  FlashcastrUsersDb,
  FlashJobsDb,
  PostgresFlashesDb,
  withTransaction,
  closePool,
  notifyFlashCasted,
} from "@flashcastr/database";
import { JobWorker, observeJobBacklog } from "@flashcastr/jobs";
import { decrypt } from "@flashcastr/crypto";
import { createMetricsRegistry, Counter } from "@flashcastr/metrics";
import { runService } from "@flashcastr/runtime";
import { createLogger } from "@flashcastr/logger";
import { requireEnv, intEnv, optionalEnv } from "@flashcastr/config";
import { NeynarCastGateway } from "./neynarCastGateway.js";
import { FlashCaster, type CastableFlash, type ImageTierStore } from "./flashCaster.js";
import { B2PromoteGateway } from "./b2PromoteGateway.js";
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
const flashesDb = new PostgresFlashesDb(pool);
const castGateway = new NeynarCastGateway({ apiKey: NEYNAR_API_KEY });

// Dark until IMAGE_STORE=b2 is live: optionalEnv (not requireEnv) lets the
// service boot with these unset — promoteFeedToKeep is only ever reached
// when a row's image_tier is already 'feed'.
const promoteGateway = new B2PromoteGateway({
  endpoint: optionalEnv("B2_S3_ENDPOINT", ""),
  region: optionalEnv("B2_REGION", ""),
  bucket: optionalEnv("B2_BUCKET", ""),
  keyId: optionalEnv("B2_PROMOTE_KEY_ID", ""),
  applicationKey: optionalEnv("B2_PROMOTE_KEY", ""),
});
const imageTier: ImageTierStore = {
  markKept: (flashId) => flashesDb.setImageTier(pool, flashId, "keep"),
};

const flashCaster = new FlashCaster({
  users: flashcastrUsersDb,
  flashes: flashcastrFlashesDb,
  gateway: castGateway,
  decrypt,
  signerEncryptionKey: SIGNER_ENCRYPTION_KEY,
  castsPublished,
  promoteGateway,
  imageTier,
});

// Non-retryable failures for castJobWorker's shouldRetry.
function isRetryableCastError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  if (msg.includes("no user found") || msg.includes("not a flashcastr user")) return false;
  if (msg.includes("revoked") || msg.includes("403") || msg.includes("forbidden")) return false;
  return true;
}

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
      image_tier: job.image_tier,
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
    castJobs: () => ({ status: castJobWorker.isRunning() ? "ok" : "error" }),
    postgres: async () => {
      await pool.query("SELECT 1");
      return { status: "ok" };
    },
  },
  start: async (ctx) => {
    ctx.onShutdown("postgres", () => closePool());
    ctx.onShutdown("cast-job-worker", () => castJobWorker.close());

    await flashCaster.checkSignerStatuses();
    castJobWorker.start();
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
