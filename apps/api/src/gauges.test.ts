import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GAUGE_UPDATE_INTERVAL_MS, scheduleGaugeUpdates, updateGauges } from "./gauges.js";
import { activeUsersTotal, totalFlashesCount } from "./metrics.js";

function fakePool(userCount: number, flashCount: number) {
  return {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ count: userCount }] })
      .mockResolvedValueOnce({ rows: [{ count: flashCount }] }),
  };
}

function fakeLog() {
  return { error: vi.fn() };
}

async function gaugeValue(metric: typeof activeUsersTotal): Promise<number> {
  const collected = await metric.get();
  return collected.values[0]?.value ?? 0;
}

describe("GAUGE_UPDATE_INTERVAL_MS", () => {
  it("is 10 minutes", () => {
    expect(GAUGE_UPDATE_INTERVAL_MS).toBe(600000);
  });
});

describe("updateGauges", () => {
  beforeEach(() => {
    activeUsersTotal.set(0);
    totalFlashesCount.set(0);
  });

  it("sets activeUsersTotal and totalFlashesCount from the query results", async () => {
    const pool = fakePool(7, 42);
    const log = fakeLog();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateGauges(pool as any, log as any);

    expect(await gaugeValue(activeUsersTotal)).toBe(7);
    expect(await gaugeValue(totalFlashesCount)).toBe(42);
  });

  it("logs and does not throw when pool.query rejects", async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error("connection lost")) };
    const log = fakeLog();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(updateGauges(pool as any, log as any)).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledWith("Error updating gauges:", expect.any(Error));
  });
});

describe("scheduleGaugeUpdates", () => {
  beforeEach(() => {
    activeUsersTotal.set(0);
    totalFlashesCount.set(0);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs updateGauges immediately and again after the interval elapses, but not before", async () => {
    const pool = fakePool(1, 2);
    const log = fakeLog();

    scheduleGaugeUpdates(pool as unknown as import("pg").Pool, log as unknown as import("@flashcastr/logger").Logger);
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.query).toHaveBeenCalledTimes(2);

    pool.query.mockResolvedValueOnce({ rows: [{ count: 3 }] }).mockResolvedValueOnce({ rows: [{ count: 4 }] });

    await vi.advanceTimersByTimeAsync(GAUGE_UPDATE_INTERVAL_MS - 1000);
    expect(pool.query).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(pool.query).toHaveBeenCalledTimes(4);
  });
});
