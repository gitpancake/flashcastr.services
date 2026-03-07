import { config } from "dotenv";
config();

import type { ConsumeMessage } from "amqplib";
import { NeynarAPIClient } from "@neynar/nodejs-sdk";
import { FlashcastrConsumer, FlashcastrPublisher, QUEUES, ROUTING_KEYS } from "@flashcastr/rabbitmq";
import { getPool, FlashcastrFlashesDb, FlashcastrUsersDb, closePool } from "@flashcastr/database";
import { decrypt } from "@flashcastr/crypto";
import { createMetricsRegistry, startMetricsServer, Counter } from "@flashcastr/metrics";
import { createLogger } from "@flashcastr/logger";
import { requireEnv, intEnv } from "@flashcastr/config";
import type { AxiosError } from "axios";
import type {
  MessageEnvelope,
  FlashStoredPayload,
  FlashCastedPayload,
  FlashcastrFlash,
} from "@flashcastr/shared-types";

function formatError(err: unknown): string {
  const axErr = err as AxiosError<{ message?: string; property?: string }>;
  if (axErr.response) {
    const data = axErr.response.data;
    return `${axErr.response.status} ${axErr.response.statusText}: ${data?.message ?? JSON.stringify(data)}`;
  }
  return (err as Error).message;
}

const log = createLogger("neynar-engine");
const registry = createMetricsRegistry("neynar-engine");

const castsPublished = new Counter({
  name: "neynar_engine_casts_published_total",
  help: "Total casts published to Farcaster",
  registers: [registry],
});

const castsFailed = new Counter({
  name: "neynar_engine_casts_failed_total",
  help: "Total cast failures",
  registers: [registry],
});

const NEYNAR_API_KEY = requireEnv("NEYNAR_API_KEY");
const SIGNER_ENCRYPTION_KEY = requireEnv("SIGNER_ENCRYPTION_KEY");

const neynarClient = new NeynarAPIClient({ apiKey: NEYNAR_API_KEY });
const pool = getPool();
const flashcastrFlashesDb = new FlashcastrFlashesDb(pool);
const flashcastrUsersDb = new FlashcastrUsersDb(pool);
const publisher = new FlashcastrPublisher("neynar-engine");

class NeynarEngineConsumer extends FlashcastrConsumer<FlashStoredPayload> {
  constructor() {
    super("neynar-engine", QUEUES.FLASH_STORED);
  }

  protected override shouldRequeueOnFailure(error: Error): boolean {
    const msg = error.message.toLowerCase();
    if (msg.includes("no user found") || msg.includes("not a flashcastr user")) return false;
    if (msg.includes("revoked") || msg.includes("403") || msg.includes("forbidden")) return false;
    return true;
  }

  protected async handleMessage(
    envelope: MessageEnvelope<FlashStoredPayload>,
    _raw: ConsumeMessage
  ): Promise<void> {
    const payload = envelope.payload;

    // Find the flashcastr user for this flash's player
    const users = await flashcastrUsersDb.getMany({});
    const appUser = users.find(
      (u) => u.username.toLowerCase() === payload.player.toLowerCase()
    );

    if (!appUser) {
      // Not a flashcastr user — skip silently
      return;
    }

    // Check if already processed
    const existing = await flashcastrFlashesDb.getByFlashIds([payload.flash_id]);
    if (existing.length > 0 && existing[0].cast_hash) {
      return; // Already casted
    }

    // Get Neynar profile
    let neynarUser;
    try {
      const users = await neynarClient.fetchBulkUsers({ fids: [appUser.fid] });
      neynarUser = users.users[0];
    } catch (err) {
      log.error(`Failed to fetch Neynar profile for fid ${appUser.fid}: ${formatError(err)}`);
      throw err;
    }

    if (!neynarUser) {
      log.warn(`No Neynar user found for fid ${appUser.fid}`);
      return;
    }

    let castHash: string | null = null;

    if (appUser.auto_cast) {
      if (!payload.ipfs_cid || payload.ipfs_cid.trim() === "") {
        log.warn(`Skipping auto-cast for flash ${payload.flash_id} — no IPFS CID`);
        return;
      }

      try {
        const signerUuid = decrypt(appUser.signer_uuid, SIGNER_ENCRYPTION_KEY);

        const cast = await neynarClient.publishCast({
          signerUuid,
          text: `I just flashed an Invader in ${payload.city}! 👾`,
          embeds: [{ url: `https://www.flashcastr.app/flash/${payload.flash_id}` }],
          channelId: "invaders",
        });

        castHash = cast.cast.hash;
        castsPublished.inc();
        log.info(`Cast published for flash ${payload.flash_id}: ${castHash}`);
      } catch (err) {
        castsFailed.inc();
        log.error(`Failed to cast flash ${payload.flash_id}: ${formatError(err)}`);
        // Continue — record with null cast_hash for retry
      }
    }

    // Record in flashcastr_flashes
    const doc: FlashcastrFlash = {
      flash_id: payload.flash_id,
      user_fid: appUser.fid,
      user_pfp_url: neynarUser.pfp_url ?? "",
      user_username: neynarUser.username,
      cast_hash: castHash,
    };

    if (existing.length === 0) {
      await flashcastrFlashesDb.insertMany([doc]);
    } else if (castHash) {
      await flashcastrFlashesDb.updateCastHash(payload.flash_id, castHash);
    }

    // Publish FLASH_CASTED
    const castedPayload: FlashCastedPayload = {
      ...payload,
      cast_hash: castHash,
      user_fid: appUser.fid,
      user_username: neynarUser.username,
      auto_cast: appUser.auto_cast,
    };

    await publisher.publish(ROUTING_KEYS.FLASH_CASTED, castedPayload, envelope.correlationId);
  }
}

// Retry worker — runs every 5 minutes
async function retryFailedCasts(): Promise<void> {
  try {
    const failedFlashes = await flashcastrFlashesDb.getFailedCastsForRetry(50, 7);
    if (!failedFlashes.length) return;

    log.info(`Retrying ${failedFlashes.length} failed casts`);
    let successCount = 0;

    for (const flash of failedFlashes) {
      try {
        const f = flash as Record<string, unknown>;
        const signerUuid = decrypt(f.signer_uuid as string, SIGNER_ENCRYPTION_KEY);

        const cast = await neynarClient.publishCast({
          signerUuid,
          text: `I just flashed an Invader in ${f.city}! 👾`,
          embeds: [{ url: `https://www.flashcastr.app/flash/${f.flash_id}` }],
          channelId: "invaders",
        });

        await flashcastrFlashesDb.updateCastHash(f.flash_id as number, cast.cast.hash);
        successCount++;
        castsPublished.inc();
      } catch (err) {
        castsFailed.inc();
        const f = flash as Record<string, unknown>;
        log.error(`Retry failed for flash ${f.flash_id}: ${formatError(err)}`);
      }
    }

    log.info(`Retry complete: ${successCount}/${failedFlashes.length} successful`);
  } catch (error) {
    log.error("Retry worker failed:", error);
  }
}

// Check signer statuses on startup
async function checkSignerStatuses(): Promise<void> {
  try {
    const users = await flashcastrUsersDb.getMany({});
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
        const signerUuid = decrypt(user.signer_uuid, SIGNER_ENCRYPTION_KEY);
        const signer = await neynarClient.lookupSigner({ signerUuid });

        if (signer.status === "approved") {
          approved++;
        } else {
          if (signer.status === "revoked") {
            await flashcastrUsersDb.updateAutoCast(user.fid, false);
            log.warn(`Signer for ${user.username} (fid ${user.fid}): revoked — auto_cast disabled`);
            revoked++;
          } else {
            log.warn(`Signer for ${user.username} (fid ${user.fid}): ${signer.status}`);
            other++;
          }
        }
      } catch (err) {
        log.warn(`Failed to check signer for ${user.username} (fid ${user.fid}): ${formatError(err)}`);
        other++;
      }
    }

    log.info(`Signer status: ${approved} approved, ${revoked} revoked, ${other} other`);
  } catch (err) {
    log.error(`Signer status check failed: ${formatError(err)}`);
  }
}

// Start
const metricsPort = intEnv("METRICS_PORT", 9090);
startMetricsServer(registry, metricsPort);

// Run signer check before starting consumer
checkSignerStatuses().then(() => {
  const consumer = new NeynarEngineConsumer();
  consumer.startConsuming().catch((err) => {
    log.error("Failed to start consumer:", err);
    process.exit(1);
  });

  // Start retry worker
  const retryInterval = intEnv("RETRY_INTERVAL_MS", 300000); // 5 minutes
  setInterval(() => {
    retryFailedCasts().catch((err) => log.error("Retry interval error:", err));
  }, retryInterval);

  log.info("neynar-engine started");

  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down...`);
    await consumer.close();
    await publisher.close();
    await closePool();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
});
