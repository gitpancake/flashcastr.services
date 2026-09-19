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
class RecordingPool {
  capturedParams: unknown[] = [];

  async query(_sql: string, params: unknown[] = []) {
    this.capturedParams = params;
    return { rows: [] };
  }
}

describe("PostgresFlashesDb.writeMany", () => {
  it("collapses duplicate flash_ids in the batch, keeping the entry with a non-empty ipfs_cid", async () => {
    const flashes: Flash[] = [
      makeFlash({ flash_id: 111, ipfs_cid: "" }),
      makeFlash({ flash_id: 111, ipfs_cid: "bafy123" }),
    ];
    const pool = new RecordingPool();
    const db = new PostgresFlashesDb(pool as unknown as Pool);

    await db.writeMany(flashes);

    const [flashIds, , , , ipfsCids] = pool.capturedParams as [number[], unknown, unknown, unknown, string[]];
    expect(flashIds).toEqual([111]);
    expect(ipfsCids).toEqual(["bafy123"]);
  });
});
