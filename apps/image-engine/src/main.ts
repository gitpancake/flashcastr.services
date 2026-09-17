import { config } from "dotenv";
config();

import type { ConsumeMessage } from "amqplib";
import axios from "axios";
import { FlashcastrConsumer, FlashcastrPublisher, TransientError, QUEUES, ROUTING_KEYS, observeQueueDepths } from "@flashcastr/rabbitmq";
import { createMetricsRegistry, Counter, Gauge } from "@flashcastr/metrics";
import { runService } from "@flashcastr/runtime";
import { CircuitBreaker, CircuitBreakerOpenError, withRetry, type CircuitState } from "@flashcastr/resilience";
import { createLogger } from "@flashcastr/logger";
import { requireEnv, intEnv } from "@flashcastr/config";
import { ProxyRotator } from "@flashcastr/proxy";
import type { MessageEnvelope, FlashReceivedPayload, ImagePinnedPayload } from "@flashcastr/shared-types";

const log = createLogger("image-engine");
const registry = createMetricsRegistry("image-engine");
const PINATA_JWT = requireEnv("PINATA_JWT");
const BASE_URL = "https://api.space-invaders.com";
const PINATA_PIN_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const PINATA_GATEWAY = "https://gateway.pinata.cloud/ipfs";

const IPFS_FAILURE_THRESHOLD = 30;
const IPFS_OPEN_DURATION_MS = 300000;
const MAX_CIRCUIT_RETRY_WAIT_MS = 30000;
const LOG_EVERY_N_FLASHES = 100;

const imagesProcessed = new Counter({
  name: "image_engine_images_processed_total",
  help: "Total images processed",
  registers: [registry],
});

const ipfsUploads = new Counter({
  name: "image_engine_ipfs_uploads_total",
  help: "Total IPFS uploads",
  registers: [registry],
});

const ipfsFailures = new Counter({
  name: "image_engine_ipfs_failures_total",
  help: "Total IPFS upload failures",
  registers: [registry],
});

const circuitBreakerState = new Gauge({
  name: "image_engine_circuit_breaker_state",
  help: "IPFS circuit breaker state (0=closed, 1=open, 2=half-open)",
  registers: [registry],
});

const CIRCUIT_GAUGE_VALUE: Record<CircuitState, number> = { closed: 0, open: 1, "half-open": 2 };

const ipfsBreaker = new CircuitBreaker({
  failureThreshold: IPFS_FAILURE_THRESHOLD,
  openDurationMs: IPFS_OPEN_DURATION_MS,
  onStateChange: (state) => {
    circuitBreakerState.set(CIRCUIT_GAUGE_VALUE[state]);
    log.warn(`IPFS circuit breaker ${state}`);
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

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
];

function getRealisticHeaders(): Record<string, string> {
  return {
    "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Sec-Fetch-Dest": "image",
    "Sec-Fetch-Mode": "no-cors",
  };
}

const publisher = new FlashcastrPublisher("image-engine");
const proxyRotator = new ProxyRotator();

interface DownloadedImage {
  data: ArrayBuffer;
  contentType: string;
}

async function downloadImage(imageUrl: string): Promise<DownloadedImage> {
  const headers = getRealisticHeaders();
  const { agent, proxy } = proxyRotator.createAgent(imageUrl);
  const agentOption = agent ? (imageUrl.startsWith("https://") ? { httpsAgent: agent } : { httpAgent: agent }) : {};

  try {
    const response = await withRetry(
      () => axios.get<ArrayBuffer>(imageUrl, {
        responseType: "arraybuffer",
        headers,
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: (status) => status < 400,
        ...agentOption,
      }),
      { maxAttempts: 4, baseDelayMs: 1000, jitterMs: 1000 }
    );
    return { data: response.data, contentType: String(response.headers["content-type"] ?? "image/jpeg") };
  } catch (error) {
    if (proxy) proxyRotator.markFailed(proxy);
    throw error;
  }
}

async function pinOnce(image: DownloadedImage, filename: string): Promise<string> {
  const file = new File([new Uint8Array(image.data)], filename, { type: image.contentType });
  const formData = new FormData();
  formData.append("file", file);
  formData.append("pinataMetadata", JSON.stringify({ name: filename }));

  const response = await axios.post(PINATA_PIN_URL, formData, {
    headers: { Authorization: `Bearer ${PINATA_JWT}`, "Content-Type": "multipart/form-data" },
    timeout: 60000,
    validateStatus: (status) => status < 500,
  });

  if (response.status === 429) throw new Error("Rate limited by Pinata API");
  if (response.status >= 400) throw new Error(`Pinata API error: ${response.status}`);
  return response.data.IpfsHash as string;
}

function pinToIpfs(image: DownloadedImage, filename: string): Promise<string> {
  return ipfsBreaker.execute(() =>
    withRetry(() => pinOnce(image, filename), { maxAttempts: 6, baseDelayMs: 10000, maxDelayMs: 200000, jitterMs: 1000 })
  );
}

function circuitWait(retryAfterMs: number): number {
  return Math.min(Math.max(retryAfterMs, 1000), MAX_CIRCUIT_RETRY_WAIT_MS);
}

class ImageEngineConsumer extends FlashcastrConsumer<FlashReceivedPayload> {
  constructor() {
    super("image-engine", QUEUES.FLASH_RECEIVED, { maxAttempts: intEnv("CONSUMER_MAX_ATTEMPTS", 10) });
  }

  protected override shouldRequeueOnFailure(error: Error): boolean {
    const msg = error.message.toLowerCase();
    if (msg.includes("already processed") || msg.includes("duplicate")) return false;
    return true;
  }

  protected async handleMessage(envelope: MessageEnvelope<FlashReceivedPayload>, _raw: ConsumeMessage): Promise<void> {
    const flash = envelope.payload;

    if (ipfsBreaker.state === "open") {
      throw new TransientError(`Circuit breaker open - deferring flash ${flash.flash_id}`, circuitWait(ipfsBreaker.retryAfterMs()));
    }

    await rateLimiter.wait();

    const image = await downloadImage(BASE_URL + flash.img);
    const filename = flash.img.split("/").pop() || `image_${flash.flash_id}.jpg`;

    let cid: string;
    try {
      cid = await pinToIpfs(image, filename);
      ipfsUploads.inc();
    } catch (error) {
      if (error instanceof CircuitBreakerOpenError) {
        throw new TransientError(`Circuit breaker open - deferring flash ${flash.flash_id}`, circuitWait(error.retryAfterMs));
      }
      ipfsFailures.inc();
      throw error;
    }

    const payload: ImagePinnedPayload = { ...flash, ipfs_cid: cid, ipfs_url: `${PINATA_GATEWAY}/${cid}` };
    await publisher.publish(ROUTING_KEYS.IMAGE_PINNED, payload, envelope.correlationId);
    imagesProcessed.inc();

    if (flash.flash_id % LOG_EVERY_N_FLASHES === 0) {
      log.info(`Pinned flash ${flash.flash_id}: ${cid}`);
    }
  }
}

const consumer = new ImageEngineConsumer();

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
