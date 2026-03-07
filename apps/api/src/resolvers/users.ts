import type { Pool } from "pg";
import { GraphQLError } from "graphql";
import { verifyApiKey } from "../auth.js";
import { SignupOperations } from "../services/signup.js";
import {
  signupsInitiatedTotal,
  signupsCompletedTotal,
  neynarRequestsTotal,
} from "../metrics.js";
import neynarClient from "../neynar/client.js";
import { FlashcastrUsersDb } from "@flashcastr/database";

export function createUserResolvers(pool: Pool) {
  const usersDb = new FlashcastrUsersDb(pool);
  const signupOps = new SignupOperations(pool);

  return {
    Query: {
      users: async (_: unknown, args: { username?: string; fid?: number }) => {
        let sql = "SELECT fid, username, auto_cast FROM flashcastr_users WHERE deleted = false";
        const params: unknown[] = [];
        let paramIndex = 1;

        if (args.username) {
          sql += ` AND username = $${paramIndex++}`;
          params.push(args.username);
        }
        if (typeof args.fid === "number") {
          sql += ` AND fid = $${paramIndex++}`;
          params.push(args.fid);
        }

        const result = await pool.query(sql, params);
        return result.rows;
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
              console.error(`[pollSignupStatus] Error finalizing signup:`, finalizationError);
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
          console.error(`[pollSignupStatus] Error looking up signer:`, error);
          return {
            status: "ERROR_NEYNAR_LOOKUP",
            fid: null, user: null,
            message: error instanceof Error ? error.message : "Failed to lookup signer on Neynar.",
          };
        }
      },
    },

    Mutation: {
      setUserAutoCast: async (_: unknown, args: { fid: number; auto_cast: boolean }, context: unknown) => {
        verifyApiKey(context as { req?: { headers: Record<string, string | undefined> } });

        await usersDb.updateAutoCast(args.fid, args.auto_cast);
        const updatedUser = await usersDb.getByFid(args.fid);

        if (!updatedUser) {
          throw new GraphQLError("User not found after update.", {
            extensions: { code: "NOT_FOUND" },
          });
        }
        return updatedUser;
      },

      deleteUser: async (_: unknown, args: { fid: number }, context: unknown) => {
        verifyApiKey(context as { req?: { headers: Record<string, string | undefined> } });

        const user = await usersDb.getByFid(args.fid);
        if (!user) return { success: false, message: "User not found" };

        const { FlashcastrFlashesDb } = await import("@flashcastr/database");
        const flashesDb = new FlashcastrFlashesDb(pool);

        await usersDb.deleteByFid(args.fid);
        await flashesDb.deleteManyByFid(args.fid);

        return { success: true, message: "User deleted successfully" };
      },

      signup: async () => {
        return { success: true, message: "Old signup mutation called (currently no-op)." };
      },

      initiateSignup: async (_: unknown, args: { username: string }) => {
        if (!args.username) {
          throw new GraphQLError("Username is required to initiate signup.", {
            extensions: { code: "BAD_USER_INPUT" },
          });
        }
        const result = await signupOps.initiateSignerCreation(args.username);
        signupsInitiatedTotal.inc();
        return result;
      },
    },
  };
}
