import { config } from "dotenv";
config();

import { FlashcastrPublisher, observeQueueDepths } from "@flashcastr/rabbitmq";
import { getPool, PostgresFlashesDb, FlashJobsDb, closePool } from "@flashcastr/database";
import { JobWorker, observeJobBacklog } from "@flashcastr/jobs";
import { createMetricsRegistry, Counter, Gauge } from "@flashcastr/metrics";
import { runService } from "@flashcastr/runtime";
import { CircuitBreaker, type CircuitState } from "@flashcastr/resilience";
import { createLogger } from "@flashcastr/logger";
import { requireEnv, intEnv } from "@flashcastr/config";
import { ProxyRotator } from "@flashcastr/proxy";
import type { FlashReceivedPayload } from "@flashcastr/shared-types";
import { AxiosImageSource } from "./axiosImageSource.js";
import { PinataPinner } from "./pinataPinner.js";
import {
  ImagePinner,
  RabbitMqPinCompletionPort,
  PostgresPinCompletionPort,
  type PinCompletionPort,
} from "./imagePinner.js";
import { ImageEngineConsumer } from "./imageEngineConsumer.js";

const log = createLogger("image-engine");
const registry = createMetricsRegistry("image-engine");
const PINATA_JWT = requireEnv("PINATA_JWT");
const BASE_URL = "https://api.space-invaders.com";
const PINATA_GATEWAY = "https://gateway.pinata.cloud/ipfs";

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
// pinJobWorker, when the "jobs" branch below runs) has finished initializing.
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
const pinner = new PinataPinner({ jwt: PINATA_JWT });

function buildImagePinner(completionPort: PinCompletionPort): ImagePinner {
  return new ImagePinner({
    source: imageSource,
    pinner,
    completionPort,
    breaker: ipfsBreaker,
    rateLimiter,
    baseUrl: BASE_URL,
    gatewayUrl: PINATA_GATEWAY,
    maxCircuitRetryWaitMs: MAX_CIRCUIT_RETRY_WAIT_MS,
    logEveryNFlashes: LOG_EVERY_N_FLASHES,
    ipfsUploads,
  });
}

const usingJobsSource = process.env.IMAGE_ENGINE_SOURCE === "jobs";

if (usingJobsSource) {
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
      const completionPort = new PostgresPinCompletionPort(pool, flashesDb, flashJobsDb, job.attempts);
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
} else {
  const publisher = new FlashcastrPublisher("image-engine");
  const completionPort = new RabbitMqPinCompletionPort(publisher);
  const imagePinner = buildImagePinner(completionPort);
  const consumer = new ImageEngineConsumer(imagePinner, { registry });

  runService("image-engine", {
    registry,
    metricsPort: intEnv("METRICS_PORT", 9093),
    healthChecks: {
      rabbitmq: () => ({ status: consumer.isConsuming() ? "ok" : "error" }),
      ipfs: () => ({ status: ipfsBreaker.state === "closed" ? "ok" : "degraded", message: `circuit ${ipfsBreaker.state}` }),
    },
    start: async (ctx) => {
      ctx.onShutdown("publisher", () => publisher.close());
      ctx.onShutdown("consumer", () => consumer.close());
      await consumer.startConsuming();
      ctx.onShutdown("queue-depths", observeQueueDepths(registry, [consumer]));
    },
  });
}
