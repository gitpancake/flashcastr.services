import { describe, expect, it, vi } from "vitest";
import { createUnifiedFlashResolvers } from "./unified-flash.js";
import { encodeFlashCursor } from "../sql/cursor.js";

const imageUrlConfig = { apiPublicBase: "https://api.test", origin: "https://origin.test" };

function fakeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    flash_id: "12345",
    city: "Paris",
    player: "Bob",
    img: "img.png",
    ipfs_cid: "cid",
    image_tier: null,
    text: "text",
    timestamp: "1700000000",
    flash_count: "1",
    farcaster_fid: null,
    farcaster_username: null,
    farcaster_pfp_url: null,
    farcaster_cast_hash: null,
    identification_id: null,
    identification_matched_flash_id: null,
    identification_matched_flash_name: null,
    identification_similarity: null,
    identification_confidence: null,
    ...overrides,
  };
}

function fakePool(rows: ReturnType<typeof fakeRow>[]) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

describe("unifiedFlashes legacy page mode (unchanged)", () => {
  it("builds the same WHERE/ORDER/LIMIT/OFFSET query as before, with no cursor logic involved", async () => {
    const pool = fakePool([fakeRow()]);
    const resolvers = createUnifiedFlashResolvers(pool as any, imageUrlConfig);

    await resolvers.Query.unifiedFlashes(null, { page: 2, limit: 10, city: "Paris" });

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("WHERE LOWER(f.city) = LOWER($1)");
    expect(sql).toContain("ORDER BY f.timestamp DESC");
    expect(sql).toContain("LIMIT $2 OFFSET $3");
    expect(sql).not.toContain("keysetBefore");
    expect(sql).not.toContain("COALESCE(f.timestamp, 'infinity'::timestamp) DESC, f.flash_id DESC");
    expect(params).toEqual(["Paris", 10, 10]);
  });

  it("defaults page/limit the same way as before when omitted", async () => {
    const pool = fakePool([fakeRow()]);
    const resolvers = createUnifiedFlashResolvers(pool as any, imageUrlConfig);

    await resolvers.Query.unifiedFlashes(null, {});

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("LIMIT $1 OFFSET $2");
    expect(params).toEqual([20, 0]);
  });
});

describe("unifiedFlashes cursor mode", () => {
  it("decodes the cursor, uses keyset WHERE + ORDER, and issues no OFFSET", async () => {
    const pool = fakePool([fakeRow()]);
    const resolvers = createUnifiedFlashResolvers(pool as any, imageUrlConfig);
    const cursor = encodeFlashCursor("1699999999", "999");

    await resolvers.Query.unifiedFlashes(null, { cursor, limit: 5, city: "Paris" });

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("WHERE LOWER(f.city) = LOWER($1)");
    expect(sql).toContain(
      "(COALESCE(f.timestamp, 'infinity'::timestamp), f.flash_id) < (COALESCE(to_timestamp($2::bigint) AT TIME ZONE 'UTC', 'infinity'::timestamp), $3::bigint)"
    );
    expect(sql).toContain("ORDER BY COALESCE(f.timestamp, 'infinity'::timestamp) DESC, f.flash_id DESC");
    expect(sql).toContain("LIMIT $4");
    expect(sql).not.toContain("OFFSET");
    expect(params).toEqual(["Paris", "1699999999", "999", 5]);
  });

  it("ignores the page arg when a cursor is provided", async () => {
    const pool = fakePool([fakeRow()]);
    const resolvers = createUnifiedFlashResolvers(pool as any, imageUrlConfig);
    const cursor = encodeFlashCursor(null, "999");

    await resolvers.Query.unifiedFlashes(null, { cursor, page: 40, limit: 5 });

    const [sql] = pool.query.mock.calls[0];
    expect(sql).not.toContain("OFFSET");
  });

  it("throws on a malformed cursor instead of querying", async () => {
    const pool = fakePool([]);
    const resolvers = createUnifiedFlashResolvers(pool as any, imageUrlConfig);

    await expect(resolvers.Query.unifiedFlashes(null, { cursor: "not-a-real-cursor!!" })).rejects.toThrow();
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe("unifiedFlashes row mapping", () => {
  it("includes an encoded cursor field on every returned row, in both modes", async () => {
    const rows = [fakeRow({ flash_id: "1", timestamp: "1700000000" }), fakeRow({ flash_id: "2", timestamp: null })];
    const pool = fakePool(rows);
    const resolvers = createUnifiedFlashResolvers(pool as any, imageUrlConfig);

    const pageResult = await resolvers.Query.unifiedFlashes(null, {});
    for (const row of pageResult) {
      expect(typeof row.cursor).toBe("string");
      expect(row.cursor.length).toBeGreaterThan(0);
    }

    const cursorResult = await resolvers.Query.unifiedFlashes(null, { cursor: encodeFlashCursor(null, "0") });
    for (const row of cursorResult) {
      expect(typeof row.cursor).toBe("string");
    }
  });
});

describe("unifiedFlashes/unifiedFlash image_url", () => {
  it("selects image_tier", async () => {
    const pool = fakePool([fakeRow()]);
    const resolvers = createUnifiedFlashResolvers(pool as any, imageUrlConfig);

    await resolvers.Query.unifiedFlashes(null, {});

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain("f.image_tier");
  });

  it("points at the api's stable route when image_tier is set", async () => {
    const pool = fakePool([fakeRow({ image_tier: "feed" })]);
    const resolvers = createUnifiedFlashResolvers(pool as any, imageUrlConfig);

    const [row] = await resolvers.Query.unifiedFlashes(null, {});
    expect(row.image_url).toBe("https://api.test/i/12345");
  });

  it("falls back to origin + img when image_tier is null (legacy row)", async () => {
    const pool = fakePool([fakeRow({ image_tier: null, img: "/img.png" })]);
    const resolvers = createUnifiedFlashResolvers(pool as any, imageUrlConfig);

    const [row] = await resolvers.Query.unifiedFlashes(null, {});
    expect(row.image_url).toBe("https://origin.test/img.png");
  });

  it("is null when neither image_tier nor img is set", async () => {
    const pool = fakePool([fakeRow({ image_tier: null, img: null })]);
    const resolvers = createUnifiedFlashResolvers(pool as any, imageUrlConfig);

    const [row] = await resolvers.Query.unifiedFlashes(null, {});
    expect(row.image_url).toBeNull();
  });

  it("computes image_url on unifiedFlash the same way", async () => {
    const pool = fakePool([fakeRow({ image_tier: "keep" })]);
    const resolvers = createUnifiedFlashResolvers(pool as any, imageUrlConfig);

    const row = await resolvers.Query.unifiedFlash(null, { flash_id: "12345" });
    expect(row?.image_url).toBe("https://api.test/i/12345");
  });
});
