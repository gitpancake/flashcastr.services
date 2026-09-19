import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimedFlashJob, FlashJobsDb } from "@flashcastr/database";

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  flush: vi.fn(async () => undefined),
}));
vi.mock("@flashcastr/logger", () => ({ createLogger: () => logger }));

import { JobWorker } from "./job-worker.js";
import { FatalMessageError, TransientError } from "./errors.js";

type FakeDb = Pick<FlashJobsDb, "claim" | "complete" | "fail" | "defer">;

function claimedJob(overrides: Partial<ClaimedFlashJob> = {}): ClaimedFlashJob {
  return {
    flash_id: 1,
    stage: "pin",
    attempts: 1,
    next_attempt_at: new Date(),
    last_error: null,
    created_at: new Date(),
    city: "Paris",
    player: "player-one",
    img: "img.png",
    ipfs_cid: "",
    text: "flash text",
    timestamp: new Date(),
    flash_count: "1",
    ...overrides,
  };
}

function fakeDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    claim: vi.fn(async () => []),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    defer: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function claimOnce(job: ClaimedFlashJob) {
  const claim = vi.fn(async () => [] as ClaimedFlashJob[]);
  claim.mockResolvedValueOnce([job]);
  return claim;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("JobWorker", () => {
  it("never calls complete itself on a successful handle", async () => {
    const db = fakeDb({ claim: claimOnce(claimedJob()) });
    const handle = vi.fn(async () => undefined);
    const worker = new JobWorker(db as unknown as FlashJobsDb, {
      stage: "pin",
      concurrency: 1,
      leaseMs: 1000,
      maxAttempts: 5,
      pollIntervalMs: 1000,
      handle,
    });

    worker.start();
    await settle();
    await worker.close();

    expect(handle).toHaveBeenCalledWith(claimedJob());
    expect(db.complete).not.toHaveBeenCalled();
  });

  it("defers a TransientError without touching fail", async () => {
    const job = claimedJob({ flash_id: 42, stage: "cast" });
    const db = fakeDb({ claim: claimOnce(job) });
    const handle = vi.fn(async () => {
      throw new TransientError("circuit open", 5000);
    });
    const worker = new JobWorker(db as unknown as FlashJobsDb, {
      stage: "cast",
      concurrency: 1,
      leaseMs: 1000,
      maxAttempts: 5,
      pollIntervalMs: 1000,
      handle,
    });

    const now = Date.now();
    worker.start();
    await settle();
    await worker.close();

    expect(db.defer).toHaveBeenCalledTimes(1);
    const [flashId, stage, retryAtMs] = (db.defer as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(flashId).toBe(42);
    expect(stage).toBe("cast");
    expect(retryAtMs).toBeGreaterThanOrEqual(now + 5000);
    expect(db.fail).not.toHaveBeenCalled();
  });

  const NEVER_RETRY_AT_MS = 8_640_000_000_000_000;

  it("dead-letters FatalMessageError even when shouldRetry would return true", async () => {
    const job = claimedJob();
    const db = fakeDb({ claim: claimOnce(job) });
    const handle = vi.fn(async () => {
      throw new FatalMessageError("poison");
    });
    const worker = new JobWorker(db as unknown as FlashJobsDb, {
      stage: "pin",
      concurrency: 1,
      leaseMs: 1000,
      maxAttempts: 5,
      pollIntervalMs: 1000,
      handle,
      shouldRetry: () => true,
    });

    worker.start();
    await settle();
    await worker.close();

    expect(db.fail).toHaveBeenCalledWith(job.flash_id, job.stage, "poison", NEVER_RETRY_AT_MS, job.attempts);
    expect(db.defer).not.toHaveBeenCalled();
  });

  it("treats a plain Error as dead when no shouldRetry is provided", async () => {
    const job = claimedJob();
    const db = fakeDb({ claim: claimOnce(job) });
    const handle = vi.fn(async () => {
      throw new Error("boom");
    });
    const worker = new JobWorker(db as unknown as FlashJobsDb, {
      stage: "pin",
      concurrency: 1,
      leaseMs: 1000,
      maxAttempts: 5,
      pollIntervalMs: 1000,
      handle,
    });

    worker.start();
    await settle();
    await worker.close();

    expect(db.fail).toHaveBeenCalledWith(job.flash_id, job.stage, "boom", NEVER_RETRY_AT_MS, job.attempts);
  });

  it("backs off a retryable plain Error using job.attempts, capped at retryMaxDelayMs", async () => {
    const now = Date.now();
    const db = fakeDb({ claim: claimOnce(claimedJob({ attempts: 4 })) });
    const handle = vi.fn(async () => {
      throw new Error("flaky");
    });
    const worker = new JobWorker(db as unknown as FlashJobsDb, {
      stage: "pin",
      concurrency: 1,
      leaseMs: 1000,
      maxAttempts: 10,
      pollIntervalMs: 1000,
      handle,
      shouldRetry: () => true,
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 5000,
    });

    worker.start();
    await settle();
    await worker.close();

    // attempts=4 -> base * 2^3 = 8000, capped at 5000
    const [flashId, stage, error, retryAtMs] = (db.fail as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(flashId).toBe(1);
    expect(stage).toBe("pin");
    expect(error).toBe("flaky");
    expect(retryAtMs).toBeGreaterThanOrEqual(now + 5000);
    expect(retryAtMs).toBeLessThan(now + 5100);
  });

  it("does not claim while paused, and resumes claiming after resume()", async () => {
    const claim = vi.fn(async () => [] as ClaimedFlashJob[]);
    const db = fakeDb({ claim });
    const worker = new JobWorker(db as unknown as FlashJobsDb, {
      stage: "pin",
      concurrency: 1,
      leaseMs: 1000,
      maxAttempts: 5,
      pollIntervalMs: 1000,
      handle: vi.fn(async () => undefined),
    });

    worker.pause();
    worker.start();
    await settle();
    expect(claim).not.toHaveBeenCalled();

    worker.resume();
    await vi.advanceTimersByTimeAsync(1000);
    expect(claim).toHaveBeenCalled();

    await worker.close();
  });

  it("waits for an in-flight handle to finish before close() resolves", async () => {
    let resolveHandle: (() => void) | undefined;
    let handleResolved = false;
    const handle = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveHandle = () => {
            handleResolved = true;
            resolve();
          };
        })
    );
    const db = fakeDb({ claim: claimOnce(claimedJob()) });
    const worker = new JobWorker(db as unknown as FlashJobsDb, {
      stage: "pin",
      concurrency: 1,
      leaseMs: 1000,
      maxAttempts: 5,
      pollIntervalMs: 1000,
      handle,
    });

    worker.start();
    await settle();
    expect(handle).toHaveBeenCalled();

    const closed = worker.close().then(() => {
      expect(handleResolved).toBe(true);
    });
    await settle();
    resolveHandle?.();
    await closed;
  });

  it("survives settleFailure rejecting: logs and keeps the loop claiming on the next tick", async () => {
    logger.error.mockClear();
    const claim = vi.fn(async () => [] as ClaimedFlashJob[]);
    claim.mockResolvedValueOnce([claimedJob()]);
    const fail = vi.fn(async () => {
      throw new Error("db unreachable");
    });
    const db = fakeDb({ claim, fail });
    const handle = vi.fn(async () => {
      throw new Error("handler blew up");
    });
    const worker = new JobWorker(db as unknown as FlashJobsDb, {
      stage: "pin",
      concurrency: 1,
      leaseMs: 1000,
      maxAttempts: 5,
      pollIntervalMs: 1000,
      handle,
    });

    worker.start();
    await settle();

    expect(fail).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();

    // The loop iteration completed despite settleFailure rejecting: it looped
    // back around to an empty claim, then idled. The next poll tick claims
    // again instead of the lane being dead.
    const claimsAfterSettleFailure = claim.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(claim.mock.calls.length).toBeGreaterThan(claimsAfterSettleFailure);

    await worker.close();
  });

  it("start() is a no-op when already running: a second call doesn't spawn a duplicate batch of loops", async () => {
    const claim = vi.fn(async () => [] as ClaimedFlashJob[]);
    const db = fakeDb({ claim });
    const worker = new JobWorker(db as unknown as FlashJobsDb, {
      stage: "pin",
      concurrency: 1,
      leaseMs: 1000,
      maxAttempts: 5,
      pollIntervalMs: 1000,
      handle: vi.fn(async () => undefined),
    });

    worker.start();
    worker.start();
    await settle();

    // With concurrency 1 and a single call to start(), exactly one loop
    // should have polled once. A duplicated batch would poll twice.
    expect(claim).toHaveBeenCalledTimes(1);

    await worker.close();
  });

  it("isRunning reflects start()/close()", async () => {
    const db = fakeDb();
    const worker = new JobWorker(db as unknown as FlashJobsDb, {
      stage: "pin",
      concurrency: 1,
      leaseMs: 1000,
      maxAttempts: 5,
      pollIntervalMs: 1000,
      handle: vi.fn(async () => undefined),
    });

    expect(worker.isRunning()).toBe(false);
    worker.start();
    expect(worker.isRunning()).toBe(true);
    await worker.close();
    expect(worker.isRunning()).toBe(false);
  });
});
