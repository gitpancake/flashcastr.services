import { mnemonicToAccount } from "viem/accounts";
import neynarClient from "./client.js";
import { requireEnv } from "@flashcastr/config";

let appFid: Promise<number> | null = null;

async function lookupAppFid(): Promise<number> {
  const mnemonic = requireEnv("FARCASTER_DEVELOPER_MNEMONIC");
  const account = mnemonicToAccount(mnemonic);

  const { user: farcasterDeveloper } = await neynarClient.lookupUserByCustodyAddress({
    custodyAddress: account.address,
  });

  return Number(farcasterDeveloper.fid);
}

/** The app's own FID, derived once from the developer mnemonic and memoized for the process lifetime. */
export const getFid = (): Promise<number> => {
  if (!appFid) {
    appFid = lookupAppFid().catch((err) => {
      appFid = null;
      throw err;
    });
  }
  return appFid;
};
