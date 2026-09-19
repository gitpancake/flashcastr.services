import type { ClaimedFlashJob, FlashJobStage, FlashJobsDb } from "@flashcastr/database";
import { createLogger } from "@flashcastr/logger";
import { FatalMessageError, TransientError } from "./errors.js";

const log = createLogger("jobs");

export interface JobWorkerOptions {
  stage: FlashJobStage;
  concurrency: number;
  leaseMs: number;
  maxAttempts: number;
  pollIntervalMs: number;
  handle: (job: ClaimedFlashJob) => Promise<void>;
  /** Whether a thrown (non-Transient, non-Fatal) error should be retried with
   *  backoff rather than treated as dead. Mirrors consumer.ts's
   *  shouldRequeueOnFailure: DEFAULTS TO false when omitted — retry is opt-in,
   *  not opt-out (a caller must explicitly return true for errors it knows are
   *  worth retrying). */
  shouldRetry?: (error: Error) => boolean;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30000;

// JS's actual max valid Date timestamp (±8,640,000,000,000,000ms from epoch) —
// used as a "never reclaim this job naturally" sentinel for dead jobs.
const NEVER_RETRY_AT_MS = 8_640_000_000_000_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class JobWorker {
  private running = false;
  private paused = false;
  private loops: Promise<void>[] = [];
  // Resolves immediately when close() is called, so a loop parked in its idle
  // sleep (no job claimed / paused) wakes up right away instead of blocking
  // close() until the next pollIntervalMs tick.
  private stopSignal: Promise<void> = Promise.resolve();
  private resolveStopSignal: (() => void) | null = null;

  constructor(
    private readonly db: Pick<FlashJobsDb, "claim" | "complete" | "fail" | "defer">,
    private readonly options: JobWorkerOptions
  ) {}

  start(): void {
    // A second call while already running would overwrite this.loops/
    // stopSignal, orphaning the first batch: close() would then only await
    // the new batch, resolving before an in-flight handler from the
    // orphaned batch finishes.
    if (this.running) return;
    this.running = true;
    this.stopSignal = new Promise((resolve) => {
      this.resolveStopSignal = resolve;
    });
    this.loops = Array.from({ length: this.options.concurrency }, () => this.runLoop());
  }

  isRunning(): boolean {
    return this.running;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  async close(): Promise<void> {
    this.running = false;
    this.resolveStopSignal?.();
    await Promise.all(this.loops);
  }

  private idleWait(): Promise<void> {
    return Promise.race([sleep(this.options.pollIntervalMs), this.stopSignal]);
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      if (this.paused) {
        await this.idleWait();
        continue;
      }

      const [job] = await this.db.claim(this.options.stage, 1, this.options.leaseMs, this.options.maxAttempts);
      if (!job) {
        await this.idleWait();
        continue;
      }

      await this.processJob(job);
    }
  }

  private async processJob(job: ClaimedFlashJob): Promise<void> {
    try {
      await this.options.handle(job);
    } catch (err) {
      await this.settleFailureSafely(job, err as Error);
    }
  }

  // A DB hiccup here must not propagate: that would kill this loop's
  // while(this.running) iteration permanently (runLoop/close() don't guard
  // processJob). Worst case the job's lease simply expires and gets
  // reclaimed later, which is an acceptable outcome.
  private async settleFailureSafely(job: ClaimedFlashJob, error: Error): Promise<void> {
    try {
      await this.settleFailure(job, error);
    } catch (settleErr) {
      log.error(`[JobWorker] Failed to settle job ${job.flash_id}/${job.stage}:`, settleErr);
    }
  }

  private async settleFailure(job: ClaimedFlashJob, error: Error): Promise<void> {
    if (error instanceof TransientError) {
      await this.db.defer(job.flash_id, job.stage, Date.now() + error.retryAfterMs, job.attempts);
      return;
    }

    const { shouldRetry } = this.options;
    const isRetryable = !(error instanceof FatalMessageError) && shouldRetry !== undefined && shouldRetry(error);
    if (!isRetryable) {
      await this.db.fail(job.flash_id, job.stage, error.message, NEVER_RETRY_AT_MS, job.attempts);
      return;
    }

    const baseDelayMs = this.options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    const maxDelayMs = this.options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    const delay = Math.min(baseDelayMs * Math.pow(2, job.attempts - 1), maxDelayMs);
    await this.db.fail(job.flash_id, job.stage, error.message, Date.now() + delay, job.attempts);
  }
}
