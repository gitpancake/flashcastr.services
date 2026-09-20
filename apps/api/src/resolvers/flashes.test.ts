import { describe, expect, it, vi } from "vitest";
import { createFlashResolvers } from "./flashes.js";

const imageUrlConfig = { apiPublicBase: "https://api.test", origin: "https://origin.test" };

function fakeGlobalRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    flash_id: "12345",
    city: "Paris",
    player: "Bob",
    img: "/img.png",
    ipfs_cid: "cid",
    image_tier: null,
    text: "text",
    timestamp: "1700000000",
    flash_count: "1",
    ...overrides,
  };
}

function fakeFlashcastrRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    flash_id: "1",
    user_fid: 42,
    user_username: "bob",
    user_pfp_url: "pfp.png",
    cast_hash: "hash",
    f_flash_id: "12345",
    city: "Paris",
    player: "Bob",
    img: "/img.png",
    ipfs_cid: "cid",
    image_tier: null,
    text: "text",
    f_timestamp: "1700000000",
    flash_count: "1",
    ...overrides,
  };
}

function fakePool(rows: Record<string, unknown>[]) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

describe("globalFlashes", () => {
  it("selects image_tier", async () => {
    const pool = fakePool([fakeGlobalRow()]);
    const resolvers = createFlashResolvers(pool as any, imageUrlConfig);

    await resolvers.Query.globalFlashes(null, {});

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain("image_tier");
  });

  it("computes image_url via the api route when image_tier is set", async () => {
    const pool = fakePool([fakeGlobalRow({ image_tier: "feed" })]);
    const resolvers = createFlashResolvers(pool as any, imageUrlConfig);

    const [row] = await resolvers.Query.globalFlashes(null, {});
    expect(row.image_url).toBe("https://api.test/i/12345");
  });

  it("falls back to origin + img for a legacy row with no image_tier", async () => {
    const pool = fakePool([fakeGlobalRow({ image_tier: null, img: "/img.png" })]);
    const resolvers = createFlashResolvers(pool as any, imageUrlConfig);

    const [row] = await resolvers.Query.globalFlashes(null, {});
    expect(row.image_url).toBe("https://origin.test/img.png");
  });

  it("is null when neither image_tier nor img is set", async () => {
    const pool = fakePool([fakeGlobalRow({ image_tier: null, img: null })]);
    const resolvers = createFlashResolvers(pool as any, imageUrlConfig);

    const [row] = await resolvers.Query.globalFlashes(null, {});
    expect(row.image_url).toBeNull();
  });
});

describe("globalFlash", () => {
  it("selects image_tier and computes image_url the same way", async () => {
    const pool = fakePool([fakeGlobalRow({ image_tier: "keep" })]);
    const resolvers = createFlashResolvers(pool as any, imageUrlConfig);

    const row = await resolvers.Query.globalFlash(null, { flash_id: "12345" });

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain("image_tier");
    expect(row.image_url).toBe("https://api.test/i/12345");
  });
});

describe("flashes (FlashcastrFlash)", () => {
  it("returns a nested flash.image_url computed from the joined flashes row", async () => {
    const pool = fakePool([fakeFlashcastrRow({ image_tier: "feed" })]);
    const resolvers = createFlashResolvers(pool as any, imageUrlConfig);

    const [row] = await resolvers.Query.flashes(null, {});
    expect(row.flash.image_url).toBe("https://api.test/i/12345");
  });
});
