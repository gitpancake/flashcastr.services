import { ViemLocalEip712Signer } from "@farcaster/hub-nodejs";
import { bytesToHex, hexToBytes } from "viem";
import type { LocalAccount } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import neynarClient from "./client.js";
import { getFid } from "./get-fid.js";
import { requireEnv } from "@flashcastr/config";

export const getSignedKey = async (is_sponsored: boolean) => {
  const createSigner = await neynarClient.createSigner();
  const { deadline, signature } = await generateSignature(createSigner.public_key);

  if (deadline === 0 || signature === "") {
    throw new Error("Failed to generate signature");
  }

  const fid = await getFid();

  const signedKey = await neynarClient.registerSignedKey({
    signerUuid: createSigner.signer_uuid,
    appFid: fid,
    deadline,
    signature,
    sponsor: {
      sponsored_by_neynar: is_sponsored,
    },
  });

  return signedKey;
};

const generateSignature = async (public_key: string) => {
  const mnemonic = requireEnv("FARCASTER_DEVELOPER_MNEMONIC");
  const FID = await getFid();

  const account = mnemonicToAccount(mnemonic);
  const appAccountKey = new ViemLocalEip712Signer(account as LocalAccount);

  const deadline = Math.floor(Date.now() / 1000) + 86400;
  const uintAddress = hexToBytes(public_key as `0x${string}`);

  const signature = await appAccountKey.signKeyRequest({
    requestFid: BigInt(FID),
    key: uintAddress,
    deadline: BigInt(deadline),
  });

  if (signature.isErr()) {
    return { deadline, signature: "" };
  }

  const sigHex = bytesToHex(signature.value);
  return { deadline, signature: sigHex };
};
