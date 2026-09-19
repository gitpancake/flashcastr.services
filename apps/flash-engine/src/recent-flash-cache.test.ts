import { describe, expect, it } from "vitest";
import { RecentFlashCache } from "./recent-flash-cache.js";

describe("RecentFlashCache", () => {
  it("has returns false for an id never remembered", () => {
    const cache = new RecentFlashCache(3);

    expect(cache.has(1)).toBe(false);
  });

  it("has returns true after remember", () => {
    const cache = new RecentFlashCache(3);

    cache.remember(1);

    expect(cache.has(1)).toBe(true);
  });

  it("evicts only the overflow amount, not half the cache", () => {
    const cache = new RecentFlashCache(3);

    cache.remember(1);
    cache.remember(2);
    cache.remember(3);
    cache.remember(4);

    expect(cache.size).toBe(3);
    expect(cache.has(1)).toBe(false);
    expect(cache.has(2)).toBe(true);
    expect(cache.has(3)).toBe(true);
    expect(cache.has(4)).toBe(true);
  });

  it("keeps every seeded id after one successful publish fills the cache to capacity", () => {
    const cache = new RecentFlashCache(3);
    cache.seed([10, 20, 30]);

    cache.remember(40);

    expect(cache.has(10)).toBe(false);
    expect(cache.has(20)).toBe(true);
    expect(cache.has(30)).toBe(true);
    expect(cache.has(40)).toBe(true);
    expect(cache.size).toBe(3);
  });

  it("never evicts a more-recently-inserted id while an older one remains", () => {
    const cache = new RecentFlashCache(3);
    cache.seed([10, 20, 30]);

    cache.remember(40);
    expect(cache.has(20)).toBe(true);
    expect(cache.has(30)).toBe(true);

    cache.remember(50);
    expect(cache.has(30)).toBe(true);
    expect(cache.has(40)).toBe(true);
    expect(cache.has(20)).toBe(false);
  });
});
