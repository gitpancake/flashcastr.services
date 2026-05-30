import { eq } from 'drizzle-orm';
import {
  farcasterAccounts,
  castQueue,
  ROUTING_KEYS,
  createLifeEvent,
} from '@life-os/shared';
import type {
  ProcessContext,
  CastPublishedPayload,
  CastEmbed,
} from '@life-os/shared';
import { publishCast, publishLike, formatPublishError } from './farcaster-publish.js';

const HUB_HTTP_URL = process.env.HUB_HTTP_URL ?? 'https://hub-api.neynar.com';
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY!;
const FARCASTER_ENCRYPTION_KEY = process.env.FARCASTER_ENCRYPTION_KEY!;
const PROCESS_NAME = 'agent-flashcastr';

export interface DispatchCastInput {
  accountHandle: string;
  text: string;
  parentHash?: string | null;
  /**
   * Author FID of the cast `parentHash` points to. Farcaster's parentCastId
   * needs BOTH the hash and the parent author's fid — publishCast only
   * threads the cast as a reply when both are present, otherwise it posts
   * top-level. Always set this alongside parentHash when replying.
   */
  parentFid?: number | null;
  channelId?: string | null;
  embeds?: CastEmbed[];
  mentions?: number[];
  mentionsPositions?: number[];
  sourceEngine: string;
  sourcePlanId?: string | null;
}

/**
 * Single-account synchronous cast dispatch.
 * Returns true on success, false on account-not-found or network failure.
 * Queue row is recorded for audit; failure logs + sets status='failed' but does not retry.
 * Retry loop intentionally omitted — V1 of agent-flashcastr self-publish (HEN-581).
 */
export async function dispatchCast(ctx: ProcessContext, input: DispatchCastInput): Promise<boolean> {
  const agentDb = ctx.agentDb!;

  const [account] = await agentDb
    .select()
    .from(farcasterAccounts)
    .where(eq(farcasterAccounts.handle, input.accountHandle))
    .limit(1);

  if (!account || !account.enabled) {
    console.warn(`[agent-flashcastr] Account @${input.accountHandle} not found or disabled — dropping cast`);
    return false;
  }

  const [queued] = await agentDb
    .insert(castQueue)
    .values({
      accountHandle: input.accountHandle,
      text: input.text,
      parentHash: input.parentHash ?? null,
      channelId: input.channelId ?? null,
      embeds: input.embeds ?? [],
      sourceEngine: input.sourceEngine,
      sourcePlanId: input.sourcePlanId ?? null,
      status: 'publishing',
    })
    .returning({ id: castQueue.id });

  const queueId = queued.id;

  try {
    const result = await publishCast(
      HUB_HTTP_URL, NEYNAR_API_KEY,
      account.signerPrivateKey, FARCASTER_ENCRYPTION_KEY,
      account.fid, input.text,
      {
        parentHash: input.parentHash ?? undefined,
        parentFid: input.parentFid ?? undefined,
        channelId: input.channelId ?? undefined,
        embeds: input.embeds ?? [],
        mentions: input.mentions,
        mentionsPositions: input.mentionsPositions,
      },
    );

    await agentDb.update(castQueue)
      .set({ status: 'published', castHash: result.castHash, publishedAt: new Date() })
      .where(eq(castQueue.id, queueId));

    console.log(`[agent-flashcastr] Cast published: ${result.castHash} (@${input.accountHandle})`);

    await ctx.publisher.publish(createLifeEvent<CastPublishedPayload>({
      routingKey: ROUTING_KEYS.CAST_PUBLISHED,
      source: PROCESS_NAME,
      payload: {
        castQueueId: queueId,
        castHash: result.castHash,
        accountHandle: input.accountHandle,
        text: input.text,
        sourceEngine: input.sourceEngine,
        sourcePlanId: input.sourcePlanId ?? null,
      },
    }));

    return true;
  } catch (err) {
    const errorMsg = formatPublishError(err);
    await agentDb.update(castQueue)
      .set({ status: 'failed', lastError: errorMsg })
      .where(eq(castQueue.id, queueId));
    console.error(`[agent-flashcastr] Cast failed for @${input.accountHandle}: ${errorMsg}`);
    return false;
  }
}

export interface LikeCastInput {
  accountHandle: string;
  /** Hash of the inbound cast to like (the one flashcastr just replied to). */
  targetHash: string;
  /** Author FID of the inbound cast — required for the Hub reaction target. */
  targetFid: number;
}

/**
 * Submit a protocol-level LIKE on a single cast. Visible "seen you" ack fired
 * after a successful conversational reply. Best-effort: returns true on a Hub
 * ack, false on account-not-found / disabled / Hub failure. Never throws —
 * a failed like must not roll back the reply that already shipped. No queue
 * row (a like has no edit/audit lifecycle, unlike a cast).
 */
export async function likeCast(ctx: ProcessContext, input: LikeCastInput): Promise<boolean> {
  const agentDb = ctx.agentDb!;

  const [account] = await agentDb
    .select()
    .from(farcasterAccounts)
    .where(eq(farcasterAccounts.handle, input.accountHandle))
    .limit(1);

  if (!account || !account.enabled) {
    console.warn(`[agent-flashcastr] Account @${input.accountHandle} not found or disabled — skipping like`);
    return false;
  }

  try {
    await publishLike(
      HUB_HTTP_URL, NEYNAR_API_KEY,
      account.signerPrivateKey, FARCASTER_ENCRYPTION_KEY,
      account.fid, input.targetFid, input.targetHash,
    );
    console.log(`[agent-flashcastr] Liked ${input.targetHash} (fid:${input.targetFid})`);
    return true;
  } catch (err) {
    console.error(`[agent-flashcastr] Like failed for ${input.targetHash}: ${formatPublishError(err)}`);
    return false;
  }
}
