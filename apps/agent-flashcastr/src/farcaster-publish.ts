import {
  makeCastAdd,
  makeReactionAdd,
  NobleEd25519Signer,
  FarcasterNetwork,
  ReactionType,
  CastType,
  Message,
} from '@farcaster/core';
import type { CastEmbed } from '@life-os/shared';
import { decrypt } from '@life-os/shared';

const stripHexPrefix = (hex: string) => hex.startsWith('0x') ? hex.slice(2) : hex;

type FarcasterEmbed = { url: string } | { castId: { fid: number; hash: Buffer } };

/**
 * Map our `CastEmbed[]` to @farcaster/core embed objects. A `url` embed
 * (used for real flash-photo images) becomes `{ url }`; a `castId` embed
 * becomes `{ castId: { fid, hash } }` with the hash decoded from hex.
 * Bare strings are treated as URLs (backward compat).
 */
export function encodeEmbeds(embeds: readonly (CastEmbed | string)[]): FarcasterEmbed[] {
  return embeds.map((embed) => {
    if (typeof embed === 'string') return { url: embed };
    if (embed.type === 'url') return { url: embed.url };
    return { castId: { fid: embed.fid, hash: Buffer.from(stripHexPrefix(embed.hash), 'hex') } };
  });
}

export interface PublishResult {
  castHash: string;
}

export interface PublishOptions {
  parentHash?: string;
  parentFid?: number;
  channelId?: string;
  channelParentUrl?: string;
  embeds?: CastEmbed[];
  mentions?: number[];
  mentionsPositions?: number[];
}

/**
 * Create, sign, and submit a cast directly to a Farcaster Hub.
 * Uses the account's Ed25519 private key (no Neynar signer, no "posted by" attribution).
 */
export async function publishCast(
  hubHttpUrl: string,
  neynarApiKey: string,
  encryptedPrivateKey: string,
  encryptionKey: string,
  fid: number,
  text: string,
  options?: PublishOptions,
): Promise<PublishResult> {
  const privateKeyBytes = Buffer.from(stripHexPrefix(decrypt(encryptedPrivateKey, encryptionKey)), 'hex');

  const signer = new NobleEd25519Signer(privateKeyBytes);

  // Build the cast body
  const castBody: Parameters<typeof makeCastAdd>[0] = {
    type: CastType.CAST,
    text,
    embeds: encodeEmbeds(options?.embeds ?? []),
    embedsDeprecated: [],
    mentions: options?.mentions ?? [],
    mentionsPositions: options?.mentionsPositions ?? [],
  };

  // Reply to a specific cast
  if (options?.parentHash && options?.parentFid) {
    castBody.parentCastId = {
      fid: options.parentFid,
      hash: Buffer.from(stripHexPrefix(options.parentHash), 'hex'),
    };
  }

  // Post to a channel — use resolved parentUrl if available, otherwise construct from channelId
  if (options?.channelParentUrl) {
    castBody.parentUrl = options.channelParentUrl;
  } else if (options?.channelId) {
    castBody.parentUrl = `https://warpcast.com/~/channel/${options.channelId}`;
  }

  const castResult = await makeCastAdd(
    castBody,
    { fid, network: FarcasterNetwork.MAINNET },
    signer,
  );

  if (castResult.isErr()) {
    throw new Error(`Failed to create cast message: ${castResult.error.message}`);
  }

  // Encode and submit to Hub
  const messageBytes = Buffer.from(Message.encode(castResult.value).finish());

  const response = await fetch(`${hubHttpUrl}/v1/submitMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-api-key': neynarApiKey,
    },
    body: messageBytes,
  });

  const result = await response.json() as { hash?: string; errCode?: string; message?: string };

  if (!response.ok || !result.hash) {
    const errorMsg = result.errCode
      ? `${result.errCode}: ${result.message ?? 'Unknown error'}`
      : JSON.stringify(result);
    throw new Error(`Hub rejected message: ${errorMsg}`);
  }

  return { castHash: result.hash };
}

/**
 * Submit a protocol-level recast (ReactionAdd) to a Farcaster Hub.
 */
export async function publishRecast(
  hubHttpUrl: string,
  neynarApiKey: string,
  encryptedPrivateKey: string,
  encryptionKey: string,
  fid: number,
  targetFid: number,
  targetHash: string,
): Promise<PublishResult> {
  const privateKeyBytes = Buffer.from(stripHexPrefix(decrypt(encryptedPrivateKey, encryptionKey)), 'hex');
  const signer = new NobleEd25519Signer(privateKeyBytes);

  const hashHex = stripHexPrefix(targetHash);

  const reactionResult = await makeReactionAdd(
    {
      type: ReactionType.RECAST,
      targetCastId: {
        fid: targetFid,
        hash: Buffer.from(hashHex, 'hex'),
      },
    },
    { fid, network: FarcasterNetwork.MAINNET },
    signer,
  );

  if (reactionResult.isErr()) {
    throw new Error(`Failed to create recast message: ${reactionResult.error.message}`);
  }

  const messageBytes = Buffer.from(Message.encode(reactionResult.value).finish());

  const response = await fetch(`${hubHttpUrl}/v1/submitMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-api-key': neynarApiKey,
    },
    body: messageBytes,
  });

  const result = await response.json() as { hash?: string; errCode?: string; message?: string };

  if (!response.ok || !result.hash) {
    const errorMsg = result.errCode
      ? `${result.errCode}: ${result.message ?? 'Unknown error'}`
      : JSON.stringify(result);
    throw new Error(`Hub rejected recast: ${errorMsg}`);
  }

  return { castHash: result.hash };
}

/**
 * Submit a protocol-level LIKE (ReactionAdd) to a Farcaster Hub. Exact twin of
 * publishRecast — same signer, same Hub submitMessage path — with
 * ReactionType.LIKE. Used as a visible "seen you" ack on the inbound cast
 * flashcastr just replied to.
 */
export async function publishLike(
  hubHttpUrl: string,
  neynarApiKey: string,
  encryptedPrivateKey: string,
  encryptionKey: string,
  fid: number,
  targetFid: number,
  targetHash: string,
): Promise<PublishResult> {
  const privateKeyBytes = Buffer.from(stripHexPrefix(decrypt(encryptedPrivateKey, encryptionKey)), 'hex');
  const signer = new NobleEd25519Signer(privateKeyBytes);

  const hashHex = stripHexPrefix(targetHash);

  const reactionResult = await makeReactionAdd(
    {
      type: ReactionType.LIKE,
      targetCastId: {
        fid: targetFid,
        hash: Buffer.from(hashHex, 'hex'),
      },
    },
    { fid, network: FarcasterNetwork.MAINNET },
    signer,
  );

  if (reactionResult.isErr()) {
    throw new Error(`Failed to create like message: ${reactionResult.error.message}`);
  }

  const messageBytes = Buffer.from(Message.encode(reactionResult.value).finish());

  const response = await fetch(`${hubHttpUrl}/v1/submitMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-api-key': neynarApiKey,
    },
    body: messageBytes,
  });

  const result = await response.json() as { hash?: string; errCode?: string; message?: string };

  if (!response.ok || !result.hash) {
    const errorMsg = result.errCode
      ? `${result.errCode}: ${result.message ?? 'Unknown error'}`
      : JSON.stringify(result);
    throw new Error(`Hub rejected like: ${errorMsg}`);
  }

  return { castHash: result.hash };
}

export function formatPublishError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
