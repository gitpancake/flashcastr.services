import type { FailedCastRow, FlashcastrFlashesDb, FlashcastrUsersDb } from "@flashcastr/database";
import { createLogger } from "@flashcastr/logger";
import type { Counter } from "@flashcastr/metrics";
import type { FlashCastedPayload, FlashcastrFlash } from "@flashcastr/shared-types";
import type { CastGateway } from "./castGateway.js";

const log = createLogger("neynar-engine");

const PINATA_GATEWAY = "https://gateway.pinata.cloud/ipfs";

function isSignerRevokedError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return message.includes("revoked") || message.includes("403") || message.includes("forbidden");
}

// Joined flash row a caller hands FlashCaster.handle — a structural subset of the
// Postgres cast-job (ClaimedFlashJob) shape.
export interface CastableFlash {
  flash_id: number;
  city: string;
  player: string;
  img: string;
  ipfs_cid: string;
  text: string;
  timestamp: number; // unix seconds
  flash_count: string;
}

export interface FlashCasterOptions {
  readonly users: FlashcastrUsersDb;
  readonly flashes: FlashcastrFlashesDb;
  readonly gateway: CastGateway;
  readonly decrypt: (encryptedData: string, key: string) => string;
  readonly signerEncryptionKey: string;
  readonly castsPublished?: Counter<string>;
}

export class FlashCaster {
  private readonly users: FlashcastrUsersDb;
  private readonly flashes: FlashcastrFlashesDb;
  private readonly gateway: CastGateway;
  private readonly decrypt: (encryptedData: string, key: string) => string;
  private readonly signerEncryptionKey: string;
  private readonly castsPublished: Counter<string> | undefined;

  constructor(options: FlashCasterOptions) {
    this.users = options.users;
    this.flashes = options.flashes;
    this.gateway = options.gateway;
    this.decrypt = options.decrypt;
    this.signerEncryptionKey = options.signerEncryptionKey;
    this.castsPublished = options.castsPublished;
  }

  async handle(flash: CastableFlash): Promise<FlashCastedPayload | null> {
    const appUser = await this.users.getByUsername(flash.player);
    if (!appUser) return null;

    const existing = await this.flashes.getByFlashIds([flash.flash_id]);
    if (existing.length > 0 && existing[0].cast_hash) return null;

    let neynarUser;
    try {
      neynarUser = await this.gateway.fetchUser(appUser.fid);
    } catch (err) {
      log.error(`Failed to fetch Neynar profile for fid ${appUser.fid}: ${(err as Error).message}`);
      throw err;
    }

    if (!neynarUser) {
      log.warn(`No Neynar user found for fid ${appUser.fid}`);
      return null;
    }

    const shouldAttemptCast = Boolean(appUser.auto_cast && flash.ipfs_cid && flash.ipfs_cid.trim() !== "");
    if (appUser.auto_cast && !shouldAttemptCast) {
      log.warn(`Skipping auto-cast for flash ${flash.flash_id} — no IPFS CID`);
      return null;
    }

    // Claim the row (cast_hash NULL) before ever attempting to cast, so a redelivery after
    // an insert failure never re-publishes: getByFlashIds will see the claim on retry.
    if (existing.length === 0) {
      const doc: FlashcastrFlash = {
        flash_id: flash.flash_id,
        user_fid: appUser.fid,
        user_pfp_url: neynarUser.pfpUrl,
        user_username: neynarUser.username,
        cast_hash: null,
      };
      await this.flashes.insertMany([doc]);
    }

    let castHash: string | null = null;
    if (shouldAttemptCast) {
      try {
        const signerUuid = this.decrypt(appUser.signer_uuid, this.signerEncryptionKey);
        const cast = await this.gateway.publishCast(signerUuid, flash.flash_id, flash.city);
        castHash = cast.hash;
        this.castsPublished?.inc();
        log.info(`Cast published for flash ${flash.flash_id}: ${castHash}`);
      } catch (err) {
        log.error(`Failed to cast flash ${flash.flash_id}: ${(err as Error).message}`);
      }
    }

    if (castHash) {
      await this.flashes.updateCastHash(flash.flash_id, castHash);
    }

    return {
      flash_id: flash.flash_id,
      img: flash.img,
      city: flash.city,
      text: flash.text,
      player: flash.player,
      timestamp: flash.timestamp,
      flash_count: flash.flash_count,
      ipfs_cid: flash.ipfs_cid,
      ipfs_url: flash.ipfs_cid ? `${PINATA_GATEWAY}/${flash.ipfs_cid}` : "",
      db_flash_id: flash.flash_id,
      stored_at: Date.now(),
      // Not computed here: notifyFlashCasted doesn't read image_url off this
      // payload today (only notifyFlashStored does, see libs/database/src/notify.ts).
      image_url: null,
      cast_hash: castHash,
      user_fid: appUser.fid,
      user_username: neynarUser.username,
      auto_cast: appUser.auto_cast,
    };
  }

  private async disableAutoCastIfRevoked(flash: FailedCastRow, err: unknown): Promise<void> {
    if (!isSignerRevokedError(err)) return;
    await this.users.updateAutoCast(flash.user_fid, false);
    log.warn(`Signer for fid ${flash.user_fid} rejected the cast; auto_cast disabled`);
  }

  async retryFailedCasts(): Promise<void> {
    try {
      const failedFlashes = await this.flashes.getFailedCastsForRetry(50, 7);
      if (!failedFlashes.length) return;

      log.info(`Retrying ${failedFlashes.length} failed casts`);
      let successCount = 0;

      for (const flash of failedFlashes) {
        try {
          const signerUuid = this.decrypt(flash.signer_uuid, this.signerEncryptionKey);
          const cast = await this.gateway.publishCast(signerUuid, flash.flash_id, flash.city);
          await this.flashes.updateCastHash(flash.flash_id, cast.hash);
          successCount++;
          this.castsPublished?.inc();
        } catch (err) {
          log.error(`Retry failed for flash ${flash.flash_id}: ${(err as Error).message}`);
          await this.disableAutoCastIfRevoked(flash, err);
        }
      }

      log.info(`Retry complete: ${successCount}/${failedFlashes.length} successful`);
    } catch (error) {
      log.error("Retry worker failed:", error);
    }
  }

  async checkSignerStatuses(): Promise<void> {
    try {
      const users = await this.users.getAll();
      const autoCastUsers = users.filter((u) => u.auto_cast);

      if (autoCastUsers.length === 0) {
        log.info("No auto_cast users found");
        return;
      }

      log.info(`Checking signer status for ${autoCastUsers.length} auto_cast users...`);

      let approved = 0;
      let revoked = 0;
      let other = 0;

      for (const user of autoCastUsers) {
        try {
          const signerUuid = this.decrypt(user.signer_uuid, this.signerEncryptionKey);
          const signer = await this.gateway.lookupSigner(signerUuid);

          if (signer.status === "approved") {
            approved++;
          } else if (signer.status === "revoked") {
            await this.users.updateAutoCast(user.fid, false);
            log.warn(`Signer for ${user.username} (fid ${user.fid}): revoked — auto_cast disabled`);
            revoked++;
          } else {
            log.warn(`Signer for ${user.username} (fid ${user.fid}): ${signer.status}`);
            other++;
          }
        } catch (err) {
          log.warn(`Failed to check signer for ${user.username} (fid ${user.fid}): ${(err as Error).message}`);
          other++;
        }
      }

      log.info(`Signer status: ${approved} approved, ${revoked} revoked, ${other} other`);
    } catch (err) {
      log.error(`Signer status check failed: ${(err as Error).message}`);
    }
  }
}
