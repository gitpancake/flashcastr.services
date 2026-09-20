import type { Pool } from "pg";
import type { Flash } from "@flashcastr/shared-types";
import { describe, expect, it } from "vitest";
import { PostgresFlashesDb } from "./flashes-db.js";

class FakeKeepSetPool {
  calls: Array<{ sql: string; params: unknown[] }> = [];

  async query(sql: string, params: unknown[] = []) {
    this.calls.push({ sql, params });
    return {
      rows: [{ flash_id: "12345", ipfs_cid: "bafy123", image_tier: "keep" }],
    };
  }
}

describe("PostgresFlashesDb.getKeepSetCandidates", () => {
  it("selects the union of the three keep-set branches and returns typed rows", async () => {
    const pool = new FakeKeepSetPool();
    const db = new PostgresFlashesDb(pool as unknown as Pool);

    const rows = await db.getKeepSetCandidates();

    expect(pool.calls).toHaveLength(1);
    const sql = pool.calls[0].sql;
    expect(sql).toMatch(/flash_id IN \(SELECT flash_id FROM flashcastr_flashes\)/);
    expect(sql).toMatch(
      /LOWER\(player\) IN \(SELECT LOWER\(username\) FROM flashcastr_users WHERE username IS NOT NULL\)/
    );
    expect(sql).toMatch(/flashcastr_flashes ff/);
    expect(sql).toMatch(/JOIN flashes f2 ON f2\.flash_id = ff\.flash_id/);
    expect(rows).toEqual([{ flash_id: 12345, ipfs_cid: "bafy123", image_tier: "keep" }]);
  });
});

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

class FakeUpdateIpfsCidPool {
  calls: Array<{ sql: string; params: unknown[] }> = [];

  async query(sql: string, params: unknown[] = []) {
    this.calls.push({ sql, params });
    return { rows: [] };
  }
}

describe("PostgresFlashesDb.updateIpfsCid", () => {
  it("updates ipfs_cid for the given flash_id", async () => {
    const pool = new FakeUpdateIpfsCidPool();
    const db = new PostgresFlashesDb(pool as unknown as Pool);

    await db.updateIpfsCid(pool as unknown as Pool, 111, "bafy123");

    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].sql).toMatch(/UPDATE flashes SET ipfs_cid/);
    expect(pool.calls[0].params).toEqual([111, "bafy123"]);
  });

  it("is a no-op for an empty ipfs_cid", async () => {
    const pool = new FakeUpdateIpfsCidPool();
    const db = new PostgresFlashesDb(pool as unknown as Pool);

    await db.updateIpfsCid(pool as unknown as Pool, 111, "");

    expect(pool.calls).toHaveLength(0);
  });
});

describe("PostgresFlashesDb.updateImageRef", () => {
  it("writes ipfs_cid and image_tier together for a non-empty hash", async () => {
    const pool = new FakeUpdateIpfsCidPool();
    const db = new PostgresFlashesDb(pool as unknown as Pool);

    await db.updateImageRef(pool as unknown as Pool, 111, "bafy123", "b2");

    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].sql).toMatch(/UPDATE flashes SET ipfs_cid.*image_tier/s);
    expect(pool.calls[0].params).toEqual([111, "bafy123", "b2"]);
  });

  it("is a no-op when hash is empty, regardless of tier", async () => {
    const pool = new FakeUpdateIpfsCidPool();
    const db = new PostgresFlashesDb(pool as unknown as Pool);

    await db.updateImageRef(pool as unknown as Pool, 111, "", "b2");

    expect(pool.calls).toHaveLength(0);
  });
});

describe("PostgresFlashesDb.setImageTier", () => {
  it("updates only image_tier for the given flash_id", async () => {
    const pool = new FakeUpdateIpfsCidPool();
    const db = new PostgresFlashesDb(pool as unknown as Pool);

    await db.setImageTier(pool as unknown as Pool, 111, "keep");

    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].sql).toMatch(/UPDATE flashes SET image_tier/);
    expect(pool.calls[0].sql).not.toMatch(/ipfs_cid/);
    expect(pool.calls[0].params).toEqual([111, "keep"]);
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

class FakeInsertNewPool {
  calls: Array<{ sql: string; params: unknown[] }> = [];
  returningRows: Array<{ flash_id: number }> = [];

  async query(sql: string, params: unknown[] = []) {
    this.calls.push({ sql, params });
    return { rows: this.returningRows };
  }
}

describe("PostgresFlashesDb.insertNew", () => {
  it("issues no query for an empty batch and returns an empty array", async () => {
    const pool = new FakePool();
    const db = new PostgresFlashesDb(pool as unknown as Pool);
    const client = new FakeInsertNewPool();

    const inserted = await db.insertNew(client as unknown as Pool, []);

    expect(inserted).toEqual([]);
    expect(client.calls).toHaveLength(0);
  });

  it("inserts with ipfs_cid forced to a literal NULL and ON CONFLICT DO NOTHING RETURNING flash_id", async () => {
    const pool = new FakePool();
    const db = new PostgresFlashesDb(pool as unknown as Pool);
    const client = new FakeInsertNewPool();
    client.returningRows = [{ flash_id: 111 }];

    await db.insertNew(client as unknown as Pool, [makeFlash({ flash_id: 111 })]);

    expect(client.calls).toHaveLength(1);
    const { sql } = client.calls[0];
    expect(sql).toMatch(/INSERT INTO flashes/);
    expect(sql).toMatch(/ON CONFLICT \(flash_id\) DO NOTHING/);
    expect(sql).toMatch(/RETURNING flash_id/);
    expect(sql).toMatch(/SELECT[^F]*NULL[^F]*AS ipfs_cid/s);
  });

  it("maps RETURNING rows to the newly inserted flash_id array", async () => {
    const pool = new FakePool();
    const db = new PostgresFlashesDb(pool as unknown as Pool);
    const client = new FakeInsertNewPool();
    client.returningRows = [{ flash_id: 111 }];

    const inserted = await db.insertNew(client as unknown as Pool, [makeFlash({ flash_id: 111 })]);

    expect(inserted).toEqual([111]);
  });

  it("converts unix-seconds timestamps to Date objects in the query params", async () => {
    const pool = new FakePool();
    const db = new PostgresFlashesDb(pool as unknown as Pool);
    const client = new FakeInsertNewPool();

    await db.insertNew(client as unknown as Pool, [makeFlash({ flash_id: 111, timestamp: 1_700_000_000 })]);

    const timestampsParam = client.calls[0].params.find(
      (p): p is Date[] => Array.isArray(p) && p[0] instanceof Date
    );
    expect(timestampsParam).toEqual([new Date(1_700_000_000 * 1000)]);
  });

  it("inserts multiple flashes in one call and returns only the ids that came back from RETURNING", async () => {
    const pool = new FakePool();
    const db = new PostgresFlashesDb(pool as unknown as Pool);
    const client = new FakeInsertNewPool();
    client.returningRows = [{ flash_id: 111 }, { flash_id: 333 }];

    const inserted = await db.insertNew(client as unknown as Pool, [
      makeFlash({ flash_id: 111 }),
      makeFlash({ flash_id: 222 }),
      makeFlash({ flash_id: 333 }),
    ]);

    expect(client.calls).toHaveLength(1);
    expect(inserted).toEqual([111, 333]);
  });
});
