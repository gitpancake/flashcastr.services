import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresFlashesDb, FlashJobsDb } from "@flashcastr/database";
import type { ImagePinnedPayload } from "@flashcastr/shared-types";
import { PostgresPinCompletionPort } from "../src/imagePinner.js";

describe.skipIf(!process.env.DATABASE_URL)("PostgresPinCompletionPort", () => {
  let pool: Pool;
  let flashesDb: PostgresFlashesDb;
  let flashJobsDb: FlashJobsDb;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    flashesDb = new PostgresFlashesDb(pool);
    flashJobsDb = new FlashJobsDb(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE flash_jobs, flashes CASCADE");
  });

  async function insertFlash(flashId: number): Promise<void> {
    await pool.query(
      `INSERT INTO flashes (flash_id, city, player, img, ipfs_cid, text, timestamp, flash_count)
       VALUES ($1, 'Paris', 'player-one', 'https://example.com/img.png', '', 'flash text', $2, '1')`,
      [flashId, new Date(1_700_000_000 * 1000)]
    );
  }

  function buildPayload(flashId: number): ImagePinnedPayload {
    return {
      flash_id: flashId,
      city: "Paris",
      player: "player-one",
      img: "https://example.com/img.png",
      text: "flash text",
      timestamp: 1_700_000_000,
      flash_count: "1",
      ipfs_cid: "bafypinned",
      ipfs_url: "https://gateway.pinata.cloud/ipfs/bafypinned",
    };
  }

  it("updates ipfs_cid, deletes the pin job, and enqueues a cast job on a live lease", async () => {
    const flashId = 111;
    await insertFlash(flashId);
    await flashJobsDb.enqueue(pool, flashId, "pin");
    const [claimed] = await flashJobsDb.claim("pin", 1, 60_000, 5);

    const port = new PostgresPinCompletionPort(pool, flashesDb, flashJobsDb, claimed.attempts, null);
    await port.complete(buildPayload(flashId));

    const { rows: flashRows } = await pool.query(
      "SELECT ipfs_cid, image_tier FROM flashes WHERE flash_id = $1",
      [flashId]
    );
    expect(flashRows[0].ipfs_cid).toBe("bafypinned");
    expect(flashRows[0].image_tier).toBeNull();

    const { rows: pinJobRows } = await pool.query(
      "SELECT * FROM flash_jobs WHERE flash_id = $1 AND stage = 'pin'",
      [flashId]
    );
    expect(pinJobRows).toHaveLength(0);

    const { rows: castJobRows } = await pool.query(
      "SELECT * FROM flash_jobs WHERE flash_id = $1 AND stage = 'cast'",
      [flashId]
    );
    expect(castJobRows).toHaveLength(1);
  });

  it("skips updateIpfsCid, cast enqueue, and the flash_stored NOTIFY when the lease was already reclaimed", async () => {
    const flashId = 222;
    await insertFlash(flashId);
    await flashJobsDb.enqueue(pool, flashId, "pin");

    // Worker A claims with a lease that expires almost immediately.
    const [firstClaim] = await flashJobsDb.claim("pin", 1, 10, 5);
    const staleAttempts = firstClaim.attempts;

    // Lease expires; Worker B reclaims, bumping attempts past what Worker A saw.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await flashJobsDb.claim("pin", 1, 60_000, 5);

    // Worker A, unaware it lost the lease, tries to settle using its stale attempts.
    const port = new PostgresPinCompletionPort(pool, flashesDb, flashJobsDb, staleAttempts, null);
    await port.complete(buildPayload(flashId));

    const { rows: flashRows } = await pool.query("SELECT ipfs_cid FROM flashes WHERE flash_id = $1", [flashId]);
    expect(flashRows[0].ipfs_cid).toBe("");

    const { rows: castJobRows } = await pool.query(
      "SELECT * FROM flash_jobs WHERE flash_id = $1 AND stage = 'cast'",
      [flashId]
    );
    expect(castJobRows).toHaveLength(0);

    const { rows: pinJobRows } = await pool.query(
      "SELECT * FROM flash_jobs WHERE flash_id = $1 AND stage = 'pin'",
      [flashId]
    );
    expect(pinJobRows).toHaveLength(1);
    expect(pinJobRows[0].attempts).toBe(2);
  });

  it("writes both ipfs_cid and image_tier when constructed with a tier", async () => {
    const flashId = 333;
    await insertFlash(flashId);
    await flashJobsDb.enqueue(pool, flashId, "pin");
    const [claimed] = await flashJobsDb.claim("pin", 1, 60_000, 5);

    const port = new PostgresPinCompletionPort(pool, flashesDb, flashJobsDb, claimed.attempts, "feed");
    await port.complete(buildPayload(flashId));

    const { rows: flashRows } = await pool.query(
      "SELECT ipfs_cid, image_tier FROM flashes WHERE flash_id = $1",
      [flashId]
    );
    expect(flashRows[0].ipfs_cid).toBe("bafypinned");
    expect(flashRows[0].image_tier).toBe("feed");
  });
});
