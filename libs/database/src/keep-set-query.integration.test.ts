import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresFlashesDb } from "./flashes-db.js";

describe.skipIf(!process.env.DATABASE_URL)("PostgresFlashesDb.getKeepSetCandidates (integration)", () => {
  let pool: Pool;
  let db: PostgresFlashesDb;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = new PostgresFlashesDb(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE flashcastr_flashes, flashcastr_users, flashes CASCADE");
  });

  async function insertFlash(flashId: number, player: string, ipfsCid = "bafytest"): Promise<void> {
    await pool.query(
      `INSERT INTO flashes (flash_id, city, player, img, ipfs_cid, text, timestamp, flash_count)
       VALUES ($1, 'Paris', $2, 'https://example.com/img.png', $3, 'text', now(), '1')`,
      [flashId, player, ipfsCid]
    );
  }

  async function insertUser(fid: number, username: string): Promise<void> {
    await pool.query(
      `INSERT INTO flashcastr_users (fid, username, signer_uuid, auto_cast) VALUES ($1, $2, 'signer', true)`,
      [fid, username]
    );
  }

  async function insertCast(flashId: number, userFid: number): Promise<void> {
    await pool.query(`INSERT INTO flashcastr_flashes (flash_id, user_fid) VALUES ($1, $2)`, [flashId, userFid]);
  }

  it("returns flashes cast through the app, flashes under a registered name, flashes recovered via a renamed player's history, and excludes everything else", async () => {
    // Branch (a): cast through the app, no matching registered user.
    await insertFlash(1, "CASTER-ONLY");
    await insertUser(100, "someone-else");
    await insertCast(1, 100);

    // Branch (b): player matches a registered username, never cast.
    await insertFlash(2, "REGISTERED-NAME");
    await insertUser(200, "registered-name");

    // Branch (c): a user cast under an old player name, then renamed; a
    // second flash under the old name (never itself cast) must still surface.
    await insertFlash(3, "OLDNAME");
    await insertUser(300, "OLDNAME");
    await insertCast(3, 300);
    await pool.query(`UPDATE flashcastr_users SET username = 'NEWNAME' WHERE fid = 300`);
    await insertFlash(4, "OLDNAME");

    // Matches none of the three branches.
    await insertFlash(5, "NOBODY");

    const rows = await db.getKeepSetCandidates();
    const flashIds = rows.map((r) => r.flash_id).sort((a, b) => a - b);

    expect(flashIds).toEqual([1, 2, 3, 4]);
  });
});
