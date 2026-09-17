import type { Pool } from "pg";
import { GraphQLError } from "graphql";
import { withApiKey } from "../auth.js";
import { SlidingWindowLimiter, withRateLimit } from "../rate-limit.js";
import { SignupOperations, broadcastUsers } from "../services/signup.js";
import {
  signupsInitiatedTotal,
  signupsCompletedTotal,
  usersDeletedTotal,
  neynarRequestsTotal,
} from "../metrics.js";
import neynarClient from "../neynar/client.js";
import { FlashcastrUsersDb } from "@flashcastr/database";
import { decrypt } from "@flashcastr/crypto";
import { requireEnv, intEnv } from "@flashcastr/config";
import { createLogger } from "@flashcastr/logger";

const log = createLogger("api");

const TEN_MINUTES_MS = 10 * 60 * 1000;

export function createUserResolvers(pool: Pool) {
  const usersDb = new FlashcastrUsersDb(pool);
  const signupOps = new SignupOperations(pool);
  const signupLimiter = new SlidingWindowLimiter(intEnv("RATE_LIMIT_SIGNUP_PER_10MIN", 5), TEN_MINUTES_MS);

  return {
    Query: {
      users: async (_: unknown, args: { username?: string; fid?: number }) => usersDb.listPublic(args),

      checkSignerStatus: async (_: unknown, args: { fid: number }) => {
        if (typeof args.fid !== "number") {
          throw new GraphQLError("fid is required.", { extensions: { code: "BAD_USER_INPUT" } });
        }

        const user = await usersDb.getByFid(args.fid);
        if (!user || !user.signer_uuid) {
          return { ok: false, status: "NO_SIGNER", fid: args.fid, message: "No signer stored for this user." };
        }

        let signerUuid: string;
        try {
          signerUuid = decrypt(user.signer_uuid, requireEnv("SIGNER_ENCRYPTION_KEY"));
        } catch (error) {
          log.error(`[checkSignerStatus] Failed to decrypt signer for fid ${args.fid}:`, error);
          return { ok: false, status: "DECRYPT_ERROR", fid: args.fid, message: "Failed to decrypt stored signer." };
        }

        try {
          neynarRequestsTotal.inc({ endpoint: "lookupSigner", status: "attempt" });
          const neynarSigner = await neynarClient.lookupSigner({ signerUuid });
          neynarRequestsTotal.inc({ endpoint: "lookupSigner", status: "success" });
          return {
            ok: neynarSigner.status === "approved",
            status: neynarSigner.status.toUpperCase(),
            fid: neynarSigner.fid ?? args.fid,
            message: null,
          };
        } catch (error) {
          neynarRequestsTotal.inc({ endpoint: "lookupSigner", status: "error" });
          log.error(`[checkSignerStatus] Neynar lookup failed for fid ${args.fid}:`, error);
          return {
            ok: false,
            status: "NEYNAR_LOOKUP_ERROR",
            fid: args.fid,
            message: error instanceof Error ? error.message : "Neynar lookup failed.",
          };
        }
      },

      pollSignupStatus: async (_: unknown, args: { signer_uuid: string; username: string }) => {
        const { signer_uuid, username } = args;

        if (!signer_uuid || !username) {
          throw new GraphQLError("signer_uuid and username are required for polling signup status.", {
            extensions: { code: "BAD_USER_INPUT" },
          });
        }

        try {
          neynarRequestsTotal.inc({ endpoint: "lookupSigner", status: "attempt" });
          const neynarSigner = await neynarClient.lookupSigner({ signerUuid: signer_uuid });
          neynarRequestsTotal.inc({ endpoint: "lookupSigner", status: "success" });

          if (neynarSigner.status === "approved" && neynarSigner.fid) {
            try {
              const finalizedUser = await signupOps.finalizeSignupProcess({
                fid: neynarSigner.fid,
                signer_uuid,
                flashInvadersPlayerName: username,
              });
              signupsCompletedTotal.inc();
              return {
                status: "APPROVED_FINALIZED",
                fid: finalizedUser.fid,
                user: { fid: finalizedUser.fid, username: finalizedUser.username, auto_cast: finalizedUser.auto_cast },
                message: "User signup finalized successfully.",
              };
            } catch (finalizationError) {
              log.error(`[pollSignupStatus] Error finalizing signup:`, finalizationError);
              return {
                status: "ERROR_FINALIZATION",
                fid: neynarSigner.fid,
                user: null,
                message: finalizationError instanceof Error ? finalizationError.message : "Failed to finalize user signup.",
              };
            }
          } else if (neynarSigner.status === "pending_approval") {
            return { status: "PENDING_APPROVAL", fid: null, user: null, message: "Signer approval is pending." };
          } else if (neynarSigner.status === "revoked") {
            return { status: "REVOKED", fid: null, user: null, message: "Signer request was revoked." };
          } else {
            return {
              status: `NEYNAR_STATUS_${neynarSigner.status.toUpperCase()}`,
              fid: null, user: null,
              message: `Signer status from Neynar: ${neynarSigner.status}`,
            };
          }
        } catch (error) {
          neynarRequestsTotal.inc({ endpoint: "lookupSigner", status: "error" });
          log.error(`[pollSignupStatus] Error looking up signer:`, error);
          return {
            status: "ERROR_NEYNAR_LOOKUP",
            fid: null, user: null,
            message: error instanceof Error ? error.message : "Failed to lookup signer on Neynar.",
          };
        }
      },
    },

    Mutation: {
      setUserAutoCast: withApiKey(async (_: unknown, args: { fid: number; auto_cast: boolean }) => {
        await usersDb.updateAutoCast(args.fid, args.auto_cast);
        const updatedUser = await usersDb.getByFid(args.fid);

        if (!updatedUser) {
          throw new GraphQLError("User not found after update.", {
            extensions: { code: "NOT_FOUND" },
          });
        }
        return updatedUser;
      }),

      deleteUser: withApiKey(async (_: unknown, args: { fid: number }) => {
        const user = await usersDb.getByFid(args.fid);
        if (!user) return { success: false, message: "User not found" };

        await usersDb.deleteWithFlashes(args.fid);
        usersDeletedTotal.inc();

        await broadcastUsers(usersDb);

        return { success: true, message: "User deleted successfully" };
      }),

      signup: async () => {
        return { success: true, message: "Old signup mutation called (currently no-op)." };
      },

      initiateSignup: withRateLimit("initiateSignup", signupLimiter, async (_: unknown, args: { username: string }) => {
        if (!args.username) {
          throw new GraphQLError("Username is required to initiate signup.", {
            extensions: { code: "BAD_USER_INPUT" },
          });
        }
        const result = await signupOps.initiateSignerCreation(args.username);
        signupsInitiatedTotal.inc();
        return result;
      }),
    },
  };
}
