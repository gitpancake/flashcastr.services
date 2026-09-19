import { describe, expect, it } from "vitest";
import { shouldPoll } from "./poll-gate.js";

describe("shouldPoll", () => {
  it("polls during peak regardless of lastAttemptAt and interval", () => {
    const now = Date.parse("2026-09-19T12:00:00Z");
    const lastAttemptAt = now - 1000;

    const result = shouldPoll({ now, lastAttemptAt, isPeak: true, offPeakMinIntervalMs: 600_000 });

    expect(result.poll).toBe(true);
  });

  it("does not poll off-peak inside the min interval", () => {
    const lastAttemptAt = Date.parse("2026-09-19T02:00:00Z");
    const now = lastAttemptAt + 300_000;

    const result = shouldPoll({ now, lastAttemptAt, isPeak: false, offPeakMinIntervalMs: 600_000 });

    expect(result.poll).toBe(false);
  });

  it("polls off-peak once the min interval has elapsed", () => {
    const lastAttemptAt = Date.parse("2026-09-19T02:00:00Z");
    const now = lastAttemptAt + 600_000;

    const result = shouldPoll({ now, lastAttemptAt, isPeak: false, offPeakMinIntervalMs: 600_000 });

    expect(result.poll).toBe(true);
  });

  it("polls off-peak past the min interval", () => {
    const lastAttemptAt = Date.parse("2026-09-19T02:00:00Z");
    const now = lastAttemptAt + 900_000;

    const result = shouldPoll({ now, lastAttemptAt, isPeak: false, offPeakMinIntervalMs: 600_000 });

    expect(result.poll).toBe(true);
  });

  it("polls the first run since boot even off-peak", () => {
    const now = Date.parse("2026-09-19T02:00:00Z");

    const result = shouldPoll({ now, lastAttemptAt: null, isPeak: false, offPeakMinIntervalMs: 600_000 });

    expect(result.poll).toBe(true);
    expect(result.reason).toBe("first poll since boot");
  });

  it("gates a schedule tick faster than the interval to one poll per 10 minutes off-peak", () => {
    const start = Date.parse("2026-09-19T02:00:00Z");
    let lastAttemptAt: number | null = null;
    const pollTimes: number[] = [];

    for (let minute = 0; minute <= 22; minute++) {
      const now = start + minute * 60_000;
      const result = shouldPoll({ now, lastAttemptAt, isPeak: false, offPeakMinIntervalMs: 600_000 });
      if (result.poll) {
        pollTimes.push(minute);
        lastAttemptAt = now;
      }
    }

    expect(pollTimes).toEqual([0, 10, 20]);
  });
});
