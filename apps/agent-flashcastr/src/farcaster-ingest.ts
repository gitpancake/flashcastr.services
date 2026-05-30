import type { NeynarAPIClient } from '@neynar/nodejs-sdk';
import { eq } from 'drizzle-orm';
import { farcasterAccounts, flashcastrMentions } from '@life-os/shared';
import type { ProcessContext } from '@life-os/shared';

const FLASHCASTR_HANDLE = 'flashcastr';

/** Minimal counter surface — keeps this module free of prom-client coupling and the test fake trivial. */
interface IngestCounter {
  inc(value?: number): void;
}

export interface IngestResult {
  ingested: number;
}

/** A single inbound cast ready to persist — built by the poll OR the webhook. */
export interface MentionRow {
  castHash: string;
  authorFid: number;
  authorUsername: string;
  parentHash: string | null;
  threadRootHash: string;
  text: string;
  kind: 'mention' | 'reply';
}

/**
 * Persist one inbound cast into flashcastr_mentions, deduped on the
 * cast_hash PK via onConflictDoNothing. Returns true iff a NEW row was
 * inserted (counter bumped on insert only) — re-delivery of the same cast,
 * whether from a re-poll OR a webhook+poll double-delivery, is idempotent
 * by construction. Shared by the poll (ingestMentions) and the webhook
 * receiver so both paths write identical rows and dedup the same way.
 */
export async function persistMention(
  agentDb: NonNullable<ProcessContext['agentDb']>,
  row: MentionRow,
  counter?: IngestCounter,
): Promise<boolean> {
  const result = await agentDb
    .insert(flashcastrMentions)
    .values({
      castHash: row.castHash,
      authorFid: row.authorFid,
      authorUsername: row.authorUsername,
      parentHash: row.parentHash,
      threadRootHash: row.threadRootHash,
      text: row.text,
      kind: row.kind,
      status: 'new',
    })
    .onConflictDoNothing()
    .returning({ castHash: flashcastrMentions.castHash });

  if (result.length > 0) {
    counter?.inc();
    return true;
  }
  return false;
}

/**
 * Resolve @flashcastr's own Farcaster FID from the farcaster_accounts table
 * (owned → agentDb). Returns null if the account row is missing — caller
 * skips ingest rather than guessing a fid.
 */
export async function resolveOwnFid(
  ctx: ProcessContext,
): Promise<{ fid: number; handle: string } | null> {
  const agentDb = ctx.agentDb!;
  const [account] = await agentDb
    .select()
    .from(farcasterAccounts)
    .where(eq(farcasterAccounts.handle, FLASHCASTR_HANDLE))
    .limit(1);
  if (!account) return null;
  return { fid: account.fid, handle: account.handle };
}

/**
 * Poll Neynar notifications for mentions of @flashcastr and replies on its
 * own casts; persist new ones into flashcastr_mentions. Dedup on the
 * cast_hash PK via onConflictDoNothing — re-poll is idempotent (no duplicate
 * rows). Read-only: no cast is generated or posted here (story 03 owns
 * replies). Mirrors agent-farcaster sync-history.ts notification polling.
 */
export async function ingestMentions(
  ctx: ProcessContext,
  neynar: Pick<NeynarAPIClient, 'fetchAllNotifications'>,
  ownFid: number,
  counter?: IngestCounter,
): Promise<IngestResult> {
  const agentDb = ctx.agentDb!;

  const response = await neynar.fetchAllNotifications({
    fid: ownFid,
    limit: 25,
  });

  const notifications = (response as unknown as { notifications?: unknown[] }).notifications ?? [];
  let ingested = 0;

  for (const raw of notifications) {
    const notif = raw as {
      type?: string;
      cast?: {
        hash?: string;
        parent_hash?: string | null;
        thread_hash?: string | null;
        text?: string;
        author?: { fid?: number; username?: string };
      };
    };

    // Reply scope: mentions of @flashcastr + replies on its own casts only.
    // Neynar scopes 'reply' notifications to the subject fid, so a reply
    // notification here is already on @flashcastr's own cast.
    const kind = notif.type === 'mention' ? 'mention' : notif.type === 'reply' ? 'reply' : null;
    if (!kind) continue;

    const cast = notif.cast;
    if (!cast?.hash || !cast.author?.fid) continue;

    // Never ingest our own casts as inbound (defensive — avoids self-reply loops downstream).
    if (cast.author.fid === ownFid) continue;

    const inserted = await persistMention(agentDb, {
      castHash: cast.hash,
      authorFid: cast.author.fid,
      authorUsername: cast.author.username ?? `fid:${cast.author.fid}`,
      parentHash: cast.parent_hash ?? null,
      threadRootHash: cast.thread_hash ?? cast.hash,
      text: cast.text ?? '',
      kind,
    }, counter);

    if (inserted) ingested++;
  }

  return { ingested };
}

/**
 * Assemble the parent/reply chain for a thread into a readable context
 * string for later reply generation. Mirrors agent-farcaster
 * conversations.ts `lookupCastConversation` tree walk. Returns null on
 * lookup failure or an empty thread — caller treats null as "no context".
 */
export async function buildThreadContext(
  neynar: Pick<NeynarAPIClient, 'lookupCastConversation'>,
  threadRootHash: string,
): Promise<string | null> {
  try {
    const thread = await neynar.lookupCastConversation({
      identifier: threadRootHash,
      type: 'hash' as never,
      replyDepth: 3,
    });

    const messages: string[] = [];
    const conversation = (thread as unknown as { conversation?: { cast?: ThreadCast } }).conversation;
    const root = conversation?.cast;
    if (root) {
      messages.push(`@${root.author?.username ?? 'unknown'}: ${root.text ?? ''}`);
      for (const reply of (root.direct_replies ?? []).slice(-5)) {
        messages.push(`@${reply.author?.username ?? 'unknown'}: ${reply.text ?? ''}`);
        for (const nested of (reply.direct_replies ?? []).slice(-3)) {
          messages.push(`@${nested.author?.username ?? 'unknown'}: ${nested.text ?? ''}`);
        }
      }
    }

    return messages.length > 0 ? messages.join('\n') : null;
  } catch (err) {
    console.warn(
      `[agent-flashcastr] Failed to fetch thread ${threadRootHash}:`,
      (err as Error).message,
    );
    return null;
  }
}

interface ThreadCast {
  text?: string;
  author?: { username?: string };
  direct_replies?: ThreadCast[];
}
