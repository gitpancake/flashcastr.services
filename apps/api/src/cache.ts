import { cacheHitsTotal, cacheMissesTotal } from "./metrics.js";

const MAX_ENTRIES_PER_CACHE = 100;

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export type Cached<T> = (key: string, load: () => Promise<T>) => Promise<T>;

/**
 * A small TTL cache keyed by the caller's arguments, so different argument
 * combinations never share a result. Hits and misses are counted under `name`.
 */
export function createCache<T>(name: string, ttlMs: number, now: () => number = Date.now): Cached<T> {
  const entries = new Map<string, Entry<T>>();

  return async (key, load) => {
    const hit = entries.get(key);
    if (hit && hit.expiresAt > now()) {
      cacheHitsTotal.inc({ cache_name: name });
      return hit.value;
    }

    cacheMissesTotal.inc({ cache_name: name });
    const value = await load();
    entries.set(key, { value, expiresAt: now() + ttlMs });

    if (entries.size > MAX_ENTRIES_PER_CACHE) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    return value;
  };
}
