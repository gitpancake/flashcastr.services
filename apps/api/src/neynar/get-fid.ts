import { mnemonicToAccount } from "viem/accounts";
import neynarClient from "./client.js";
import { requireEnv } from "@flashcastr/config";

export const getFid = async (): Promise<number> => {
  const mnemonic = requireEnv("FARCASTER_DEVELOPER_MNEMONIC");
  const account = mnemonicToAccount(mnemonic);

  const { user: farcasterDeveloper } = await neynarClient.lookupUserByCustodyAddress({
    custodyAddress: account.address,
  });

  return Number(farcasterDeveloper.fid);
};
