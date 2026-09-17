import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker, CircuitBreakerOpenError, withRetry } from "./index.js";

const noSleep = async () => undefined;

describe("withRetry", () => {
  it("returns the first successful result", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("a")).mockResolvedValueOnce("ok");
    await expect(withRetry(fn, { maxAttempts: 3, sleep: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("rethrows the last error after maxAttempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always"));
    await expect(withRetry(fn, { maxAttempts: 3, sleep: noSleep })).rejects.toThrow("always");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("stops immediately when the error is not retryable", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fatal"));
    await expect(
      withRetry(fn, { maxAttempts: 5, sleep: noSleep, isRetryable: (e) => (e as Error).message !== "fatal" })
    ).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("backs off exponentially up to maxDelayMs and reports each retry", async () => {
    const waits: number[] = [];
    const fn = vi.fn().mockRejectedValue(new Error("x"));
    await withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 350,
      sleep: async (ms) => { waits.push(ms); },
    }).catch(() => undefined);
    expect(waits).toEqual([100, 200, 350, 350]);
  });
});

describe("CircuitBreaker", () => {
  function breaker(now: { t: number }, threshold = 3, openMs = 1000) {
    const states: string[] = [];
    const cb = new CircuitBreaker({ failureThreshold: threshold, openDurationMs: openMs, now: () => now.t, onStateChange: (s) => states.push(s) });
    return { cb, states };
  }

  it("stays closed until the failure threshold is reached", async () => {
    const now = { t: 0 };
    const { cb, states } = breaker(now);
    const fail = () => cb.execute(async () => { throw new Error("boom"); });
    await expect(fail()).rejects.toThrow("boom");
    await expect(fail()).rejects.toThrow("boom");
    expect(cb.state).toBe("closed");
    await expect(fail()).rejects.toThrow("boom");
    expect(cb.state).toBe("open");
    expect(states).toEqual(["open"]);
  });

  it("fails fast while open and reports the remaining wait", async () => {
    const now = { t: 0 };
    const { cb } = breaker(now, 1, 1000);
    await cb.execute(async () => { throw new Error("x"); }).catch(() => undefined);
    now.t = 400;
    const attempt = cb.execute(async () => "should not run");
    await expect(attempt).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    await expect(attempt).rejects.toMatchObject({ retryAfterMs: 600 });
  });

  it("allows one trial in half-open; success closes, failure reopens", async () => {
    const now = { t: 0 };
    const { cb, states } = breaker(now, 1, 1000);
    await cb.execute(async () => { throw new Error("x"); }).catch(() => undefined);

    now.t = 1000;
    expect(cb.state).toBe("half-open");
    await cb.execute(async () => { throw new Error("still down"); }).catch(() => undefined);
    expect(cb.state).toBe("open");

    now.t = 2000;
    await expect(cb.execute(async () => "back")).resolves.toBe("back");
    expect(cb.state).toBe("closed");
    expect(cb.failures).toBe(0);
    expect(states).toEqual(["open", "half-open", "open", "half-open", "closed"]);
  });

  it("only lets a single trial through concurrently in half-open", async () => {
    const now = { t: 0 };
    const { cb } = breaker(now, 1, 1000);
    await cb.execute(async () => { throw new Error("x"); }).catch(() => undefined);
    now.t = 1000;

    let release: () => void = () => undefined;
    const trial = cb.execute(() => new Promise<string>((resolve) => { release = () => resolve("ok"); }));
    await expect(cb.execute(async () => "second")).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    release();
    await expect(trial).resolves.toBe("ok");
  });
});
