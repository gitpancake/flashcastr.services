import type { Pool } from "pg";
import type { FlashcastrUser, FlashcastrFlash, UsersBroadcastPayload } from "@flashcastr/shared-types";
import { FlashcastrUsersDb, FlashcastrFlashesDb } from "@flashcastr/database";
import { FlashcastrPublisher, ROUTING_KEYS } from "@flashcastr/rabbitmq";
import { encrypt } from "@flashcastr/crypto";
import { requireEnv } from "@flashcastr/config";
import neynarClient from "../neynar/client.js";
import { getSignedKey } from "../neynar/get-signed-key.js";
import { createLogger } from "@flashcastr/logger";

const log = createLogger("api-signup");
const MAX_FLASHES_TO_INSERT = 7000;

const publisher = new FlashcastrPublisher("api");

export async function broadcastUsers(usersDb: FlashcastrUsersDb): Promise<void> {
  try {
    const users = await usersDb.getMany({});
    const usernames = users.map((u) => u.username.toLowerCase());
    const payload: UsersBroadcastPayload = { usernames };
    await publisher.publish(ROUTING_KEYS.USERS_BROADCAST, payload);
    log.info(`Broadcast ${usernames.length} users after change`);
  } catch (err) {
    log.error("Failed to broadcast users:", err);
  }
}

export class SignupOperations {
  private pool: Pool;
  private usersDb: FlashcastrUsersDb;
  private flashesDb: FlashcastrFlashesDb;

  constructor(pool: Pool) {
    this.pool = pool;
    this.usersDb = new FlashcastrUsersDb(pool);
    this.flashesDb = new FlashcastrFlashesDb(pool);
  }

  async initiateSignerCreation(username: string): Promise<{
    signer_uuid: string;
    public_key: string;
    status: string;
    signer_approval_url?: string;
    fid?: number;
  }> {
    if (!username || username.trim() === "") {
      throw new Error("Username is required to initiate signer creation.");
    }
    if (username.toLowerCase() === "anonymous") {
      throw new Error("Username 'anonymous' is not allowed.");
    }

    log.info(`Initiating signer creation for username: ${username}`);

    const signerData = await getSignedKey(true);

    log.info(`Signer created for ${username}: uuid=${signerData.signer_uuid} status=${signerData.status}`);

    return {
      signer_uuid: signerData.signer_uuid,
      public_key: signerData.public_key,
      status: signerData.status,
      signer_approval_url: signerData.signer_approval_url,
      fid: signerData.fid,
    };
  }

  async finalizeSignupProcess({ fid, signer_uuid, flashInvadersPlayerName }: {
    fid: number;
    signer_uuid: string;
    flashInvadersPlayerName: string;
  }): Promise<FlashcastrUser> {
    const encryptionKey = requireEnv("SIGNER_ENCRYPTION_KEY");
    log.info(`Finalizing signup for FID: ${fid}, Player: ${flashInvadersPlayerName}`);

    // Fetch Neynar user details
    const { users: [neynarUser] } = await neynarClient.fetchBulkUsers({ fids: [fid] });
    if (!neynarUser) throw new Error(`Could not fetch Neynar user details for FID ${fid}.`);

    const pfpUrl = neynarUser.pfp_url ?? "";
    const farcasterUsername = neynarUser.username ?? "";

    // Store user
    const userToStore: FlashcastrUser = {
      fid,
      username: flashInvadersPlayerName,
      signer_uuid: encrypt(signer_uuid, encryptionKey),
      auto_cast: true,
    };
    await this.usersDb.insert(userToStore);

    // Fetch all flashes for this player from local DB and link them
    const result = await this.pool.query<{ flash_id: number }>(
      "SELECT flash_id FROM flashes WHERE LOWER(player) = LOWER($1)",
      [flashInvadersPlayerName]
    );
    const flashCount = result.rows.length;

    if (flashCount > MAX_FLASHES_TO_INSERT) {
      log.info(`Skipping flash insertion for FID ${fid}: ${flashCount} exceeds ${MAX_FLASHES_TO_INSERT}`);
    } else if (flashCount > 0) {
      const dbFlashes: FlashcastrFlash[] = result.rows.map((f) => ({
        flash_id: f.flash_id,
        user_fid: fid,
        user_username: farcasterUsername,
        user_pfp_url: pfpUrl,
        cast_hash: null,
      }));
      await this.flashesDb.insertMany(dbFlashes);
      log.info(`Inserted ${dbFlashes.length} flash records for FID ${fid}`);
    }

    // Broadcast updated users to flash-engine
    await broadcastUsers(this.usersDb);

    // Fetch finalized user
    const finalUser = await this.usersDb.getByFid(fid);
    if (!finalUser) throw new Error(`User FID ${fid} not found in DB after finalization.`);

    log.info(`Finalized signup for Player: '${flashInvadersPlayerName}', FID: ${fid}, Flashes: ${flashCount}`);
    return finalUser;
  }
}
