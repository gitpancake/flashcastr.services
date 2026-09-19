import type { Pool } from "pg";
import type { Flash } from "@flashcastr/shared-types";
import { describe, expect, it } from "vitest";
import { PostgresFlashesDb } from "./flashes-db.js";

/**
 * node-postgres returns bigint (int8) columns as strings to avoid silent precision
 * loss, but returns integer (int4) columns as real numbers. This fake mirrors that:
 * it only hands back numbers when the query casts flash_id down to int, exactly like
 * the real driver would.
 */
class FakePool {
  private readonly flashIds = ["12345", "67890"];

  async query(sql: string, _params: unknown[] = []) {
    const castToInt = /flash_id::int\b/.test(sql);
    const rows = this.flashIds.map((id) => ({ flash_id: castToInt ? Number(id) : id }));
    return { rows };
  }
}

describe("PostgresFlashesDb.getRecentFlashIds", () => {
  it("returns real numbers even though pg sends int8 columns back as strings", async () => {
    const pool = new FakePool();
    const db = new PostgresFlashesDb(pool as unknown as Pool);

    const ids = await db.getRecentFlashIds(10);

    expect(ids).toEqual([12345, 67890]);
    expect(ids.every((id) => typeof id === "number")).toBe(true);
  });
});

function makeFlash(overrides: Partial<Flash>): Flash {
  return {
    flash_id: 111,
    img: "https://example.com/img.png",
    city: "Paris",
    text: "flash text",
    player: "player-one",
    timestamp: 1_700_000_000,
    flash_count: "1",
    ipfs_cid: "",
    ...overrides,
  };
}

/**
 * Captures whatever params writeMany sends into the UNNEST query so tests can
 * assert on exactly what would reach Postgres, without a real connection.
 */
class FakeWriteManyPool {
  capturedParams: unknown[] = [];

  async query(_sql: string, params: unknown[] = []) {
    this.capturedParams = params;
    return { rows: [] };
  }
}

function captureUnnestParams(pool: FakeWriteManyPool) {
  const [flashIds, cities, players, imgs, ipfsCids, texts, timestamps, flashCounts] = pool.capturedParams as [
    number[], string[], string[], string[], string[], string[], Date[], string[],
  ];
  return { flashIds, cities, players, imgs, ipfsCids, texts, timestamps, flashCounts };
}

describe("PostgresFlashesDb.writeMany", () => {
  it("collapses duplicate flash_ids in the batch, keeping the entry with a non-empty ipfs_cid (empty first)", async () => {
    const flashes: Flash[] = [
      makeFlash({ flash_id: 111, ipfs_cid: "" }),
      makeFlash({ flash_id: 111, ipfs_cid: "bafy123" }),
    ];
    const pool = new FakeWriteManyPool();
    const db = new PostgresFlashesDb(pool as unknown as Pool);

    await db.writeMany(flashes);

    const { flashIds, ipfsCids } = captureUnnestParams(pool);
    expect(flashIds).toEqual([111]);
    expect(ipfsCids).toEqual(["bafy123"]);
  });

  it("collapses duplicate flash_ids in the batch, keeping the entry with a non-empty ipfs_cid (non-empty first)", async () => {
    const flashes: Flash[] = [
      makeFlash({ flash_id: 111, ipfs_cid: "bafy123" }),
      makeFlash({ flash_id: 111, ipfs_cid: "" }),
    ];
    const pool = new FakeWriteManyPool();
    const db = new PostgresFlashesDb(pool as unknown as Pool);

    await db.writeMany(flashes);

    const { flashIds, ipfsCids } = captureUnnestParams(pool);
    expect(flashIds).toEqual([111]);
    expect(ipfsCids).toEqual(["bafy123"]);
  });

  it("keeps the last occurrence when both duplicates have a non-empty ipfs_cid", async () => {
    const flashes: Flash[] = [
      makeFlash({ flash_id: 111, ipfs_cid: "bafy-old", player: "player-old" }),
      makeFlash({ flash_id: 111, ipfs_cid: "bafy-new", player: "player-new" }),
    ];
    const pool = new FakeWriteManyPool();
    const db = new PostgresFlashesDb(pool as unknown as Pool);

    await db.writeMany(flashes);

    const { flashIds, ipfsCids, players } = captureUnnestParams(pool);
    expect(flashIds).toEqual([111]);
    expect(ipfsCids).toEqual(["bafy-new"]);
    expect(players).toEqual(["player-new"]);
  });

  it("keeps the last occurrence when both duplicates have an empty ipfs_cid", async () => {
    const flashes: Flash[] = [
      makeFlash({ flash_id: 111, ipfs_cid: "", player: "player-old" }),
      makeFlash({ flash_id: 111, ipfs_cid: "", player: "player-new" }),
    ];
    const pool = new FakeWriteManyPool();
    const db = new PostgresFlashesDb(pool as unknown as Pool);

    await db.writeMany(flashes);

    const { flashIds, ipfsCids, players } = captureUnnestParams(pool);
    expect(flashIds).toEqual([111]);
    expect(ipfsCids).toEqual([""]);
    expect(players).toEqual(["player-new"]);
  });

  it("queries the passed transaction client instead of the instance's own pool", async () => {
    const pool = new FakeWriteManyPool();
    const client = new FakeWriteManyPool();
    const db = new PostgresFlashesDb(pool as unknown as Pool);

    await db.writeMany([makeFlash({ flash_id: 111, ipfs_cid: "bafy123" })], client as unknown as Pool);

    expect(pool.capturedParams).toEqual([]);
    const { flashIds, ipfsCids } = captureUnnestParams(client);
    expect(flashIds).toEqual([111]);
    expect(ipfsCids).toEqual(["bafy123"]);
  });
});
