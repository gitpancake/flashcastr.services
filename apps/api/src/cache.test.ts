import { describe, expect, it, vi } from "vitest";
import { createCache } from "./cache.js";

describe("createCache", () => {
  it("serves distinct keys independently and reuses a fresh entry", async () => {
    const clock = { t: 0 };
    const cached = createCache<string>("test", 1000, () => clock.t);
    const load = vi.fn(async (v: string) => `value:${v}`);

    await expect(cached("a", () => load("a"))).resolves.toBe("value:a");
    await expect(cached("b", () => load("b"))).resolves.toBe("value:b");
    await expect(cached("a", () => load("a"))).resolves.toBe("value:a");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reloads after the ttl elapses", async () => {
    const clock = { t: 0 };
    const cached = createCache<number>("test", 1000, () => clock.t);
    let n = 0;
    const load = async () => ++n;

    await expect(cached("k", load)).resolves.toBe(1);
    clock.t = 999;
    await expect(cached("k", load)).resolves.toBe(1);
    clock.t = 1000;
    await expect(cached("k", load)).resolves.toBe(2);
  });
});
