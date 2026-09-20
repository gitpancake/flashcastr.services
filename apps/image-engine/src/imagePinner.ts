import type { Pool } from "pg";
import { TransientError } from "@flashcastr/jobs";
import { CircuitBreakerOpenError, type CircuitBreaker } from "@flashcastr/resilience";
import { createLogger } from "@flashcastr/logger";
import type { Counter } from "@flashcastr/metrics";
import type { PostgresFlashesDb, FlashJobsDb } from "@flashcastr/database";
import { withTransaction, notifyFlashStored } from "@flashcastr/database";
import type { FlashReceivedPayload, ImagePinnedPayload, FlashStoredPayload } from "@flashcastr/shared-types";
import type { ImageSource } from "./imageSource.js";
import type { Pinner } from "./pinner.js";

const log = createLogger("image-engine");

interface RateLimiterLike {
  wait(): Promise<void>;
}

export interface PinCompletionPort {
  complete(payload: ImagePinnedPayload, correlationId: string): Promise<void>;
}

function toStoredPayload(payload: ImagePinnedPayload): FlashStoredPayload {
  return { ...payload, db_flash_id: payload.flash_id, stored_at: Date.now() };
}

// expectedAttempts fences this settle against the pin job's lease (see
// FlashJobsDb.complete): if another worker already reclaimed and completed
// the job, the DELETE matches no row and the remaining side effects
// (updateIpfsCid, enqueue(cast), notifyFlashStored) must not run — otherwise
// a reclaimed job emits a spurious duplicate flash_stored NOTIFY and a
// spurious duplicate pending cast job.
export class PostgresPinCompletionPort implements PinCompletionPort {
  constructor(
    private readonly pool: Pool,
    private readonly flashesDb: PostgresFlashesDb,
    private readonly flashJobsDb: FlashJobsDb,
    private readonly expectedAttempts: number,
    private readonly imageTier: string | null
  ) {}

  async complete(payload: ImagePinnedPayload): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const completed = await this.flashJobsDb.complete(client, payload.flash_id, "pin", this.expectedAttempts);
      if (!completed) return;
      if (this.imageTier) {
        await this.flashesDb.updateImageRef(client, payload.flash_id, payload.ipfs_cid, this.imageTier);
      } else {
        await this.flashesDb.updateIpfsCid(client, payload.flash_id, payload.ipfs_cid);
      }
      await this.flashJobsDb.enqueue(client, payload.flash_id, "cast");
      await notifyFlashStored(client, toStoredPayload(payload));
    });
  }
}

export interface ImagePinnerOptions {
  readonly source: ImageSource;
  readonly pinner: Pinner;
  readonly completionPort: PinCompletionPort;
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
    await this.options.completionPort.complete(payload, correlationId);

    if (flash.flash_id % this.options.logEveryNFlashes === 0) {
      log.info(`Pinned flash ${flash.flash_id}: ${cid}`);
    }
  }

  private circuitWait(retryAfterMs: number): number {
    return Math.min(Math.max(retryAfterMs, 1000), this.options.maxCircuitRetryWaitMs);
  }
}
