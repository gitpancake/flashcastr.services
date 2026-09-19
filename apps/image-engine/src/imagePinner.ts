import { TransientError, ROUTING_KEYS, type FlashcastrPublisher } from "@flashcastr/rabbitmq";
import { CircuitBreakerOpenError, type CircuitBreaker } from "@flashcastr/resilience";
import { createLogger } from "@flashcastr/logger";
import type { Counter } from "@flashcastr/metrics";
import type { FlashReceivedPayload, ImagePinnedPayload } from "@flashcastr/shared-types";
import type { ImageSource } from "./imageSource.js";
import type { Pinner } from "./pinner.js";

const log = createLogger("image-engine");

interface RateLimiterLike {
  wait(): Promise<void>;
}

export interface ImagePinnerOptions {
  readonly source: ImageSource;
  readonly pinner: Pinner;
  readonly publisher: Pick<FlashcastrPublisher, "publish">;
  readonly breaker: CircuitBreaker;
  readonly rateLimiter: RateLimiterLike;
  readonly baseUrl: string;
  readonly gatewayUrl: string;
  readonly maxCircuitRetryWaitMs: number;
  readonly logEveryNFlashes: number;
  readonly ipfsUploads?: Counter<string>;
}

export class ImagePinner {
  constructor(private readonly options: ImagePinnerOptions) {}

  async handle(flash: FlashReceivedPayload, correlationId: string): Promise<void> {
    const { breaker } = this.options;

    if (breaker.state === "open") {
      throw new TransientError(
        `Circuit breaker open - deferring flash ${flash.flash_id}`,
        this.circuitWait(breaker.retryAfterMs())
      );
    }

    await this.options.rateLimiter.wait();

    const image = await this.options.source.download(this.options.baseUrl + flash.img);
    const filename = flash.img.split("/").pop() || `image_${flash.flash_id}.jpg`;

    let cid: string;
    try {
      cid = await breaker.execute(() => this.options.pinner.pin(image, filename));
      this.options.ipfsUploads?.inc();
    } catch (error) {
      if (error instanceof CircuitBreakerOpenError) {
        throw new TransientError(
          `Circuit breaker open - deferring flash ${flash.flash_id}`,
          this.circuitWait(error.retryAfterMs)
        );
      }
      throw error;
    }

    const payload: ImagePinnedPayload = { ...flash, ipfs_cid: cid, ipfs_url: `${this.options.gatewayUrl}/${cid}` };
    await this.options.publisher.publish(ROUTING_KEYS.IMAGE_PINNED, payload, correlationId);

    if (flash.flash_id % this.options.logEveryNFlashes === 0) {
      log.info(`Pinned flash ${flash.flash_id}: ${cid}`);
    }
  }

  private circuitWait(retryAfterMs: number): number {
    return Math.min(Math.max(retryAfterMs, 1000), this.options.maxCircuitRetryWaitMs);
  }
}
