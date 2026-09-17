import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter, withRateLimit, RATE_LIMITED_ERROR_CODE } from "./rate-limit.js";

describe("SlidingWindowLimiter", () => {
  it("allows up to the limit within a window and rejects the next", () => {
    const limiter = new SlidingWindowLimiter(3, 1000);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 10)).toBe(true);
    expect(limiter.allow("a", 20)).toBe(true);
    expect(limiter.allow("a", 30)).toBe(false);
  });

  it("frees capacity once old hits fall out of the window", () => {
    const limiter = new SlidingWindowLimiter(2, 1000);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 500)).toBe(true);
    expect(limiter.allow("a", 900)).toBe(false);
    expect(limiter.allow("a", 1001)).toBe(true);
  });

  it("tracks keys independently", () => {
    const limiter = new SlidingWindowLimiter(1, 1000);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("b", 0)).toBe(true);
    expect(limiter.allow("a", 1)).toBe(false);
  });
});

describe("withRateLimit", () => {
  it("keys on the request ip and throws RATE_LIMITED past the limit", async () => {
    const limiter = new SlidingWindowLimiter(1, 60_000);
    const guarded = withRateLimit<{ v: number }, Promise<number>>("test", limiter, async (_p, args) => args.v);
    const ctx = { req: { headers: {}, ip: "1.2.3.4" } };
    const otherCtx = { req: { headers: {}, ip: "5.6.7.8" } };

    await expect(guarded(null, { v: 1 }, ctx)).resolves.toBe(1);
    expect(() => guarded(null, { v: 2 }, ctx)).toThrowError(
      expect.objectContaining({ extensions: { code: RATE_LIMITED_ERROR_CODE } })
    );
    await expect(guarded(null, { v: 3 }, otherCtx)).resolves.toBe(3);
  });
});
