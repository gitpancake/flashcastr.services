import { config } from "dotenv";
config();

import { getPool, PostgresFlashesDb, FlashJobsDb, closePool } from "@flashcastr/database";
import { JobWorker, observeJobBacklog } from "@flashcastr/jobs";
import { createMetricsRegistry, Counter, Gauge } from "@flashcastr/metrics";
import { runService } from "@flashcastr/runtime";
import { CircuitBreaker, type CircuitState } from "@flashcastr/resilience";
import { createLogger } from "@flashcastr/logger";
import { requireEnv, intEnv, optionalEnv } from "@flashcastr/config";
import { ProxyRotator } from "@flashcastr/proxy";
import type { FlashReceivedPayload } from "@flashcastr/shared-types";
import { AxiosImageSource } from "./axiosImageSource.js";
import { PinataPinner } from "./pinataPinner.js";
import { B2Pinner } from "./b2Pinner.js";
import {
  ImagePinner,
  PostgresPinCompletionPort,
  type PinCompletionPort,
} from "./imagePinner.js";
import type { Pinner } from "./pinner.js";

const log = createLogger("image-engine");
const registry = createMetricsRegistry("image-engine");
const BASE_URL = "https://api.space-invaders.com";
const PINATA_GATEWAY = "https://gateway.pinata.cloud/ipfs";

// Dark launch (platform/backblaze-image-storage/01-b2-pinner-and-tier): the
// pinata path is byte-for-byte today's behavior; b2 is wired but inert until
// an operator sets IMAGE_STORE=b2 on this service.
const IMAGE_STORE = optionalEnv("IMAGE_STORE", "pinata");

function buildPinnerForStore(store: string): { pinner: Pinner; gatewayUrl: string; imageTier: string | null } {
  if (store === "pinata") {
    return {
      pinner: new PinataPinner({ jwt: requireEnv("PINATA_JWT") }),
      gatewayUrl: PINATA_GATEWAY,
      imageTier: null,
    };
  }
  if (store === "b2") {
    return {
      pinner: new B2Pinner({
        endpoint: requireEnv("B2_S3_ENDPOINT"),
        region: requireEnv("B2_REGION"),
        bucket: requireEnv("B2_BUCKET"),
        keyId: requireEnv("B2_KEY_ID"),
        applicationKey: requireEnv("B2_APPLICATION_KEY"),
      }),
      gatewayUrl: `${requireEnv("B2_PUBLIC_BASE")}/feed`,
      imageTier: "feed",
    };
  }
  throw new Error(`Unknown IMAGE_STORE "${store}"`);
}

const { pinner, gatewayUrl, imageTier } = buildPinnerForStore(IMAGE_STORE);

// Only required once a tier is actually live (IMAGE_STORE=b2) -- pinata
// deployments never build a route URL, so they'd otherwise crash on a var
// they don't need. Left unset with a tier active, this would previously
// silently notify a bare relative path with no scheme/host; requireEnv here
// turns that into a boot-time crash instead.
const IMAGE_URL_CONFIG = {
  apiPublicBase: imageTier ? requireEnv("API_PUBLIC_BASE") : "",
  origin: BASE_URL,
};

const IPFS_FAILURE_THRESHOLD = 30;
const IPFS_OPEN_DURATION_MS = 300000;
const MAX_CIRCUIT_RETRY_WAIT_MS = 30000;
const LOG_EVERY_N_FLASHES = 100;

const ipfsUploads = new Counter({
  name: "image_engine_ipfs_uploads_total",
  help: "Total IPFS uploads",
  registers: [registry],
});

const circuitBreakerState = new Gauge({
  name: "image_engine_circuit_breaker_state",
  help: "IPFS circuit breaker state (0=closed, 1=open, 2=half-open)",
  registers: [registry],
});

const CIRCUIT_GAUGE_VALUE: Record<CircuitState, number> = { closed: 0, open: 1, "half-open": 2 };

// Declared before the breaker so onStateChange can reference it — the
// breaker only fires onStateChange at runtime, after the module (and thus
// pinJobWorker below) has finished initializing.
let pinJobWorker: JobWorker | undefined;

const ipfsBreaker = new CircuitBreaker({
  failureThreshold: IPFS_FAILURE_THRESHOLD,
  openDurationMs: IPFS_OPEN_DURATION_MS,
  onStateChange: (state) => {
    circuitBreakerState.set(CIRCUIT_GAUGE_VALUE[state]);
    log.warn(`IPFS circuit breaker ${state}`);
    if (state === "open") pinJobWorker?.pause();
    else pinJobWorker?.resume();
  },
});

class RateLimiter {
  private timestamps: number[] = [];

  constructor(private readonly perMinute: number) {}

  async wait(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60000);
    if (this.timestamps.length >= this.perMinute) {
      const waitTime = 60000 - (now - this.timestamps[0]);
      if (waitTime > 0) await new Promise((r) => setTimeout(r, waitTime));
    }
    this.timestamps.push(Date.now());
  }
}

const rateLimiter = new RateLimiter(intEnv("CONSUMER_RATE_LIMIT", 250));

const proxyRotator = new ProxyRotator();
const imageSource = new AxiosImageSource({ proxyRotator });

function buildImagePinner(completionPort: PinCompletionPort): ImagePinner {
  return new ImagePinner({
    source: imageSource,
    pinner,
    completionPort,
    breaker: ipfsBreaker,
    rateLimiter,
    baseUrl: BASE_URL,
    gatewayUrl,
    maxCircuitRetryWaitMs: MAX_CIRCUIT_RETRY_WAIT_MS,
    logEveryNFlashes: LOG_EVERY_N_FLASHES,
    ipfsUploads,
  });
}

const pool = getPool();
const flashesDb = new PostgresFlashesDb(pool);
const flashJobsDb = new FlashJobsDb(pool);

const PIN_JOB_MAX_ATTEMPTS = intEnv("CONSUMER_MAX_ATTEMPTS", 10);

const jobWorker = new JobWorker(flashJobsDb, {
  stage: "pin",
  concurrency: intEnv("CONSUMER_CONCURRENCY", 1),
  leaseMs: intEnv("PIN_JOB_LEASE_MS", 60000),
  maxAttempts: PIN_JOB_MAX_ATTEMPTS,
  pollIntervalMs: intEnv("PIN_JOB_POLL_INTERVAL_MS", 1000),
  shouldRetry: () => true,
  handle: async (job) => {
    const flash: FlashReceivedPayload = {
      flash_id: job.flash_id,
      img: job.img,
      city: job.city,
      text: job.text,
      player: job.player,
      timestamp: Math.floor(job.timestamp.getTime() / 1000),
      flash_count: job.flash_count,
    };
    const completionPort = new PostgresPinCompletionPort(
      pool,
      flashesDb,
      flashJobsDb,
      job.attempts,
      imageTier,
      IMAGE_URL_CONFIG
    );
    await buildImagePinner(completionPort).handle(flash, "");
  },
});
pinJobWorker = jobWorker;

runService("image-engine", {
  registry,
  metricsPort: intEnv("METRICS_PORT", 9093),
  healthChecks: {
    pinJobs: () => ({ status: jobWorker.isRunning() ? "ok" : "error" }),
    ipfs: () => ({ status: ipfsBreaker.state === "closed" ? "ok" : "degraded", message: `circuit ${ipfsBreaker.state}` }),
    postgres: async () => {
      await pool.query("SELECT 1");
      return { status: "ok" };
    },
  },
  start: async (ctx) => {
    ctx.onShutdown("postgres", () => closePool());
    ctx.onShutdown("pin-job-worker", () => jobWorker.close());
    jobWorker.start();
    ctx.onShutdown(
      "job-backlog",
      observeJobBacklog(registry, pool, [{ stage: "pin", maxAttempts: PIN_JOB_MAX_ATTEMPTS }])
    );
  },
});
