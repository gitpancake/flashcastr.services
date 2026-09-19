import type { Pool } from "pg";
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
