import { Pool } from "pg";
import type { Flash } from "@flashcastr/shared-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FlashJobsDb } from "./flash-jobs-db.js";

describe.skipIf(!process.env.DATABASE_URL)("FlashJobsDb", () => {
  let pool: Pool;
  let db: FlashJobsDb;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = new FlashJobsDb(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE flash_jobs, flashes CASCADE");
  });

  async function insertFlash(overrides: Partial<Flash> = {}): Promise<Flash> {
    const flash: Flash = {
      flash_id: 111,
      img: "https://example.com/img.png",
      city: "Paris",
      text: "flash text",
      player: "player-one",
      timestamp: 1_700_000_000,
      flash_count: "1",
      ipfs_cid: "bafybeitest",
      ...overrides,
    };
    await pool.query(
      `INSERT INTO flashes (flash_id, city, player, img, ipfs_cid, text, timestamp, flash_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        flash.flash_id,
        flash.city,
        flash.player,
        flash.img,
        flash.ipfs_cid,
        flash.text,
        new Date(flash.timestamp * 1000),
        flash.flash_count,
      ]
    );
    return flash;
  }

  it("claims an enqueued job and joins it with its flashes row", async () => {
    const flash = await insertFlash({ flash_id: 111, img: "https://example.com/pin-me.png" });
    await db.enqueue(pool, flash.flash_id, "pin");

    const claimed = await db.claim("pin", 10, 60_000, 5);

    expect(claimed).toHaveLength(1);
    expect(claimed[0].flash_id).toBe(111);
    expect(claimed[0].stage).toBe("pin");
    expect(claimed[0].attempts).toBe(1);
    expect(claimed[0].img).toBe("https://example.com/pin-me.png");
    expect(claimed[0].ipfs_cid).toBe(flash.ipfs_cid);
  });

  it("enqueue is idempotent: enqueueing the same (flash_id, stage) twice leaves one row", async () => {
    const flash = await insertFlash({ flash_id: 222 });
    await db.enqueue(pool, flash.flash_id, "pin");
    await db.enqueue(pool, flash.flash_id, "pin");

    const { rows } = await pool.query("SELECT * FROM flash_jobs WHERE flash_id = $1 AND stage = $2", [
      flash.flash_id,
      "pin",
    ]);

    expect(rows).toHaveLength(1);
  });

  it("complete deletes the job row", async () => {
    const flash = await insertFlash({ flash_id: 333 });
    await db.enqueue(pool, flash.flash_id, "cast");

    await db.complete(pool, flash.flash_id, "cast");

    const { rows } = await pool.query("SELECT * FROM flash_jobs WHERE flash_id = $1 AND stage = $2", [
      flash.flash_id,
      "cast",
    ]);
    expect(rows).toHaveLength(0);
  });

  it("never lets two concurrent claims take the same job", async () => {
    const flashIds = [401, 402, 403, 404, 405, 406];
    for (const flashId of flashIds) {
      await insertFlash({ flash_id: flashId });
      await db.enqueue(pool, flashId, "pin");
    }

    const [batchA, batchB] = await Promise.all([
      db.claim("pin", 3, 60_000, 5),
      db.claim("pin", 3, 60_000, 5),
    ]);

    const claimedIds = [...batchA, ...batchB].map((job) => job.flash_id).sort((a, b) => a - b);
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    expect(claimedIds).toEqual(flashIds);
  });

  it("reclaims a job once its lease has expired, incrementing attempts again", async () => {
    const flash = await insertFlash({ flash_id: 501 });
    await db.enqueue(pool, flash.flash_id, "pin");

    const firstClaim = await db.claim("pin", 1, 50, 5);
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0].attempts).toBe(1);

    const duringLease = await db.claim("pin", 1, 50, 5);
    expect(duringLease).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 75));

    const afterLease = await db.claim("pin", 1, 50, 5);
    expect(afterLease).toHaveLength(1);
    expect(afterLease[0].attempts).toBe(2);
  });

  it("never claims a job once it has reached maxAttempts", async () => {
    const flash = await insertFlash({ flash_id: 601 });
    await db.enqueue(pool, flash.flash_id, "pin");

    const firstClaim = await db.claim("pin", 1, 10, 1);
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0].attempts).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 20));

    const secondClaim = await db.claim("pin", 1, 10, 1);
    expect(secondClaim).toHaveLength(0);
  });

  it("fail records the error and reschedules next_attempt_at without touching attempts", async () => {
    const flash = await insertFlash({ flash_id: 701 });
    await db.enqueue(pool, flash.flash_id, "pin");
    await db.claim("pin", 1, 60_000, 5);

    const retryAtMs = Date.now() - 1000;
    await db.fail(flash.flash_id, "pin", "pin download timed out", retryAtMs);

    const { rows } = await pool.query("SELECT * FROM flash_jobs WHERE flash_id = $1 AND stage = $2", [
      flash.flash_id,
      "pin",
    ]);
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].last_error).toBe("pin download timed out");
    expect(new Date(rows[0].next_attempt_at).getTime()).toBe(new Date(retryAtMs).getTime());
  });

  it("defer reschedules like fail but decrements attempts back, floored at 0", async () => {
    const flash = await insertFlash({ flash_id: 801 });
    await db.enqueue(pool, flash.flash_id, "pin");
    await db.claim("pin", 1, 60_000, 5);

    const retryAtMs = Date.now() - 1000;
    await db.defer(flash.flash_id, "pin", retryAtMs);

    const afterDefer = await pool.query("SELECT * FROM flash_jobs WHERE flash_id = $1 AND stage = $2", [
      flash.flash_id,
      "pin",
    ]);
    expect(afterDefer.rows[0].attempts).toBe(0);

    await db.defer(flash.flash_id, "pin", retryAtMs);

    const afterSecondDefer = await pool.query(
      "SELECT * FROM flash_jobs WHERE flash_id = $1 AND stage = $2",
      [flash.flash_id, "pin"]
    );
    expect(afterSecondDefer.rows[0].attempts).toBe(0);
  });
});
