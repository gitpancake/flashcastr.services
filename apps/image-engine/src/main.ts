import { config } from "dotenv";
config();

import type { ConsumeMessage } from "amqplib";
import axios from "axios";
import { FlashcastrConsumer, FlashcastrPublisher, QUEUES, ROUTING_KEYS } from "@flashcastr/rabbitmq";
import { createMetricsRegistry, startMetricsServer, Counter, Gauge } from "@flashcastr/metrics";
import { createLogger } from "@flashcastr/logger";
import { requireEnv, intEnv } from "@flashcastr/config";
import { ProxyRotator } from "@flashcastr/proxy";
import type { MessageEnvelope, FlashReceivedPayload, ImagePinnedPayload } from "@flashcastr/shared-types";

const log = createLogger("image-engine");
const registry = createMetricsRegistry("image-engine");
const PINATA_JWT = requireEnv("PINATA_JWT");
const BASE_URL = "https://api.space-invaders.com";

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
  help: "IPFS circuit breaker state (0=closed, 1=open)",
  registers: [registry],
});

// Rate limiter
const requestsPerMinute = intEnv("CONSUMER_RATE_LIMIT", 250);
let requestTimestamps: number[] = [];

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter((t) => now - t < 60000);
  if (requestTimestamps.length >= requestsPerMinute) {
    const oldest = requestTimestamps[0];
    const waitTime = 60000 - (now - oldest);
    if (waitTime > 0) await new Promise((r) => setTimeout(r, waitTime));
  }
  requestTimestamps.push(Date.now());
}

// Circuit breaker
let consecutiveIpfsFailures = 0;
let circuitBreakerOpen = false;
let circuitBreakerOpenUntil = 0;
const MAX_IPFS_FAILURES = 30;

function checkCircuitBreaker(): boolean {
  if (circuitBreakerOpen && Date.now() > circuitBreakerOpenUntil) {
    circuitBreakerOpen = false;
    consecutiveIpfsFailures = 0;
    circuitBreakerState.set(0);
    log.info("IPFS circuit breaker reset");
  }
  return circuitBreakerOpen;
}

// User agents for image downloads
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

async function retryRequest<T>(fn: () => Promise<T>, maxRetries = 3, baseDelay = 1000): Promise<T> {
  let lastError: Error;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt === maxRetries) throw lastError;
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError!;
}

const publisher = new FlashcastrPublisher("image-engine");
const proxyRotator = new ProxyRotator();

class ImageEngineConsumer extends FlashcastrConsumer<FlashReceivedPayload> {
  constructor() {
    super("image-engine", QUEUES.FLASH_RECEIVED);
  }

  protected override shouldRequeueOnFailure(error: Error): boolean {
    const msg = error.message.toLowerCase();
    if (msg.includes("already processed") || msg.includes("duplicate")) return false;
    if (circuitBreakerOpen) return false;
    return true;
  }

  protected async handleMessage(
    envelope: MessageEnvelope<FlashReceivedPayload>,
    _raw: ConsumeMessage
  ): Promise<void> {
    const flash = envelope.payload;
    const imageUrl = BASE_URL + flash.img;

    if (checkCircuitBreaker()) {
      throw new Error(`Circuit breaker open - skipping flash ${flash.flash_id}`);
    }

    await waitForRateLimit();

    // Download image
    const headers = getRealisticHeaders();
    const { agent, proxy } = proxyRotator.createAgent(imageUrl);

    let response;
    try {
      response = await retryRequest(async () => {
        return await axios.get(imageUrl, {
          responseType: "arraybuffer",
          headers,
          timeout: 30000,
          maxRedirects: 5,
          validateStatus: (status) => status < 400,
          ...(agent ? (imageUrl.startsWith("https://") ? { httpsAgent: agent } : { httpAgent: agent }) : {}),
        });
      });
    } catch (error) {
      if (proxy) proxyRotator.markFailed(proxy);
      throw error;
    }

    // Upload to IPFS via Pinata
    const filename = flash.img.split("/").pop() || `image_${flash.flash_id}.jpg`;
    const contentType = response.headers["content-type"] || "image/jpeg";

    let cid: string;
    try {
      cid = await retryRequest(async () => {
        const file = new File([response.data], filename, { type: contentType });
        const formData = new FormData();
        formData.append("file", file);
        formData.append("pinataMetadata", JSON.stringify({ name: filename }));

        const pinataResponse = await axios.post(
          "https://api.pinata.cloud/pinning/pinFileToIPFS",
          formData,
          {
            headers: {
              Authorization: `Bearer ${PINATA_JWT}`,
              "Content-Type": "multipart/form-data",
            },
            timeout: 60000,
            validateStatus: (status) => status < 500,
          }
        );

        if (pinataResponse.status === 429) {
          throw new Error("Rate limited by Pinata API");
        }
        if (pinataResponse.status >= 400) {
          throw new Error(`Pinata API error: ${pinataResponse.status}`);
        }

        return pinataResponse.data.IpfsHash;
      }, 5, 10000);

      ipfsUploads.inc();
      consecutiveIpfsFailures = 0;
    } catch (error) {
      ipfsFailures.inc();
      consecutiveIpfsFailures++;

      if (consecutiveIpfsFailures >= MAX_IPFS_FAILURES) {
        circuitBreakerOpen = true;
        circuitBreakerState.set(1);
        circuitBreakerOpenUntil = Date.now() + 300000;
        log.error(`Circuit breaker OPEN for 5 minutes (${consecutiveIpfsFailures} failures)`);
      }

      throw error;
    }

    // Publish IMAGE_PINNED
    const payload: ImagePinnedPayload = {
      ...flash,
      ipfs_cid: cid,
      ipfs_url: `https://gateway.pinata.cloud/ipfs/${cid}`,
    };

    await publisher.publish(ROUTING_KEYS.IMAGE_PINNED, payload, envelope.correlationId);
    imagesProcessed.inc();

    if (flash.flash_id % 100 === 0) {
      log.info(`Pinned flash ${flash.flash_id}: ${cid}`);
    }
  }
}

// Start
const metricsPort = intEnv("METRICS_PORT", 9090);
startMetricsServer(registry, metricsPort);

const consumer = new ImageEngineConsumer();
consumer.startConsuming().catch((err) => {
  log.error("Failed to start consumer:", err);
  process.exit(1);
});

log.info("image-engine started");

const shutdown = async (signal: string) => {
  log.info(`Received ${signal}, shutting down...`);
  await consumer.close();
  await publisher.close();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
