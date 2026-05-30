import type { NeynarAPIClient } from '@neynar/nodejs-sdk';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { flashcastrMentions } from '@life-os/shared';
import type { ProcessContext, AIClient } from '@life-os/shared';
import { buildSystemPrompt } from './persona.js';
import { buildThreadContext } from './farcaster-ingest.js';
import { dispatchCast, likeCast } from './dispatch-cast.js';
import { classifyInboundIntent } from './correction-intent.js';
import { insertCorrection, insertCorrectionAudit, isUnderFactCheckBudget } from './corrections.js';
import { assessRelevance, factCheckCorrection } from './correction-verify.js';

const FLASHCASTR_HANDLE = 'flashcastr';
const SOURCE_ENGINE = 'conversational-reply';

/** Pending mentions handled per poll cycle (one in-character reply each). */
export const REPLY_BATCH = 10;
/**
 * Author rate-limit (replaces the old flat per-author/thread cooldown). An
 * author who sends MORE than RATE_LIMIT_MAX_INBOUND inbound casts within the
 * trailing RATE_LIMIT_WINDOW_MS is suppressed — no reply — until their
 * trailing-hour volume drops back to the cap. Counting inbound `created_at`
 * (not replies) over a rolling window makes the ~1h cooldown fall out
 * statelessly: the burst ages out of the window an hour after it stops.
 */
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1h
export const RATE_LIMIT_MAX_INBOUND = 15; // strictly > this trips the cooldown

/** Minimal counter surface — keeps this module free of prom-client coupling and the test fake trivial. */
interface ReplyCounter {
  inc(value?: number): void;
}

/**
 * Relevance gate + persona reply in one call. The gate is the inversion of
 * Kelly's never-refuse floor: the model decides *whether* the inbound is in
 * scope (on-topic Invader/mosaic/own-cast talk, not spam/abuse/noise); once
 * in scope it MUST produce a substantive in-character reply (no meta-refusal).
 * Returns the reply text, or null when out of scope / empty (caller stays
 * silent only here).
 */
export async function generateReply(
  ai: AIClient,
  inboundText: string,
  authorUsername: string,
  threadContext: string | null,
  correctionsBlock = '',
): Promise<string | null> {
  try {
    const result = await ai.completeJson<{ in_scope?: boolean; reply?: string }>({
      task: 'generate',
      taskName: 'flashcastr_conversational_reply',
      maxTokens: 400,
      cacheSystem: true,
      system: buildSystemPrompt(`${correctionsBlock ? `${correctionsBlock.trimEnd()}\n\n` : ''}Your job: reply to an inbound Farcaster cast that mentioned you or replied to one of your own casts.

RELEVANCE GATE (decide this first):
- in_scope = true ONLY if the inbound is genuinely about Space Invaders / mosaics / the hunt / one of your casts, AND is not spam, an ad, pure abuse, or off-topic noise.
- in_scope = false → set reply to "" and stop. Spam / abuse / off-topic is the ONLY case where you stay silent.

ONCE IN SCOPE (in_scope = true) you MUST produce a substantive reply. No meta-refusal, no "nothing to add", no disclaimer — that violates your hard floor. Land one real Invader take, answer the question if there is one, and where it lands naturally pull the thread back to the wider hunt / community. Stay under 280 chars.

ANTI-HALLUCINATION: never assert an invader ID, install date, city, or status that is not in the inbound cast or the thread context. If you don't know a fact, say so in character rather than inventing it.

Respond with ONLY valid JSON, no markdown:
{"in_scope": true, "reply": "the in-character reply"}
or
{"in_scope": false, "reply": ""}`),
      messages: [{
        role: 'user',
        content: `Inbound cast from @${authorUsername}:\n${inboundText}\n${threadContext ? `\nThread so far:\n${threadContext}\n` : ''}\nDecide scope, then reply if in scope.`,
      }],
    });

    if (!result.in_scope) return null;
    const text = String(result.reply ?? '').trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    console.warn('[agent-flashcastr] Reply generation failed:', (err as Error).message);
    return null;
  }
}

/**
 * In-character acknowledgement of a public correction (story 04). The
 * never-refuse floor applies — this MUST land a substantive in-voice ack
 * (own the error, state the corrected fact). Falls back to a templated
 * in-voice line on any AI failure so a real correction is never met with
 * silence.
 */
export async function generateCorrectionAck(
  ai: AIClient,
  wrongClaim: string,
  correctFact: string,
  authorUsername: string,
): Promise<string> {
  const fallback = `ah — you're right. ${correctFact}, not ${wrongClaim}. fixed, won't make that one again 👾`.slice(0, 280);
  try {
    const result = await ai.completeJson<{ reply?: string }>({
      task: 'generate',
      taskName: 'flashcastr_correction_ack',
      maxTokens: 300,
      cacheSystem: true,
      system: buildSystemPrompt(`Your job: a community member just publicly corrected a factual mistake you made. Acknowledge it in character per your hard floor — own the error plainly, with personality, never defensive, never a robotic "correction noted". State the corrected fact so it's clear you got it. One sharp line, under 280 chars.

Respond with ONLY valid JSON, no markdown:
{"reply": "the in-character acknowledgement"}`),
      messages: [{
        role: 'user',
        content: `@${authorUsername} corrected you.\nYour wrong claim: ${wrongClaim}\nThe correct fact: ${correctFact}\nAcknowledge it.`,
      }],
    });
    const text = String(result.reply ?? '').trim();
    return text.length > 0 ? text.slice(0, 280) : fallback;
  } catch (err) {
    console.warn('[agent-flashcastr] Correction-ack generation failed, using fallback:', (err as Error).message);
    return fallback;
  }
}

/**
 * Soft, non-committal acknowledgement of an alleged correction that did NOT
 * pass the relevance + web-fact-check gates. Distinct from
 * `generateCorrectionAck`: it MUST NOT restate either the wrongClaim or the
 * (unverified) correctFact as if either were true, and MUST NOT reveal that
 * a verification process ran. The reply just keeps the conversation civil
 * ("appreciate the flag, taking another look" in persona voice) so a public
 * correction is never met with silence even when we can't confidently
 * persist it.
 */
export async function generateSoftAck(
  ai: AIClient,
  authorUsername: string,
): Promise<string> {
  const fallback = `appreciate the flag — taking another look 👾`.slice(0, 280);
  try {
    const result = await ai.completeJson<{ reply?: string }>({
      task: 'generate',
      taskName: 'flashcastr_correction_soft_ack',
      maxTokens: 200,
      cacheSystem: true,
      system: buildSystemPrompt(`Your job: a community member publicly pushed back on a claim you supposedly made, but you cannot confirm their alternative is correct (right now). Stay in voice. Acknowledge the flag warmly without:
- agreeing the original claim was wrong
- restating either claim as if it were settled
- saying anything about "checking" / "verifying" / "research" / sources / databases
- being defensive or dismissive

One sharp neutral line under 280 chars — the kind of thing a relaxed expert says when they've heard something interesting but want to think on it. Examples: "noted — let me sit with that one", "hm, possible — keeping it in mind", "good flag, that one's on my list".

Respond with ONLY valid JSON, no markdown:
{"reply": "the in-character soft acknowledgement"}`),
      messages: [{
        role: 'user',
        content: `@${authorUsername} just pushed back on one of your claims. Acknowledge it lightly without conceding.`,
      }],
    });
    const text = String(result.reply ?? '').trim();
    return text.length > 0 ? text.slice(0, 280) : fallback;
  } catch (err) {
    console.warn('[agent-flashcastr] Soft-ack generation failed, using fallback:', (err as Error).message);
    return fallback;
  }
}

export interface ReplyRunResult {
  replied: number;
  skipped: number;
}

/**
 * Drain `flashcastr_mentions` rows with status='new': relevance-gate →
 * persona reply (01) over thread context (02) → dispatch as a Farcaster
 * reply (`parentHash` = the inbound cast) → mark the row's terminal status.
 *
 * Abuse is bounded by a per-author rate limit: an author who sent more than
 * RATE_LIMIT_MAX_INBOUND casts in the trailing RATE_LIMIT_WINDOW_MS is
 * suppressed this cycle (and until their rolling-hour volume drops back to
 * the cap). Normal-volume authors are always answered — no flat cooldown.
 * Status lifecycle: new → replied | skipped. `skipped` covers rate-limited,
 * out-of-scope, and dispatch failure (no retry — mirrors dispatch-cast.ts)
 * so re-poll never produces a duplicate reply.
 */
export async function processNewMentions(
  ctx: ProcessContext,
  neynar: Pick<NeynarAPIClient, 'lookupCastConversation'>,
  ai: AIClient,
  counter?: ReplyCounter,
  now: number = Date.now(),
  correctionsBlock = '',
  likeCounter?: ReplyCounter,
): Promise<ReplyRunResult> {
  const agentDb = ctx.agentDb!;

  const pending = await agentDb
    .select()
    .from(flashcastrMentions)
    .where(eq(flashcastrMentions.status, 'new'))
    .limit(REPLY_BATCH);

  if (pending.length === 0) return { replied: 0, skipped: 0 };

  // Author rate-limit: count each pending author's inbound casts in the
  // trailing window (all statuses — it measures messages the author SENT,
  // not replies). One grouped query over the distinct pending authors.
  // Authors over the cap are suppressed this cycle; the cooldown lifts on
  // its own once the burst ages out of the rolling window (~1h later).
  const windowStart = new Date(now - RATE_LIMIT_WINDOW_MS);
  const pendingAuthorFids = [...new Set(pending.map((p) => p.authorFid))];

  const authorCounts = await agentDb
    .select({
      authorFid: flashcastrMentions.authorFid,
      inboundCount: sql<number>`count(*)::int`,
    })
    .from(flashcastrMentions)
    .where(and(
      inArray(flashcastrMentions.authorFid, pendingAuthorFids),
      gte(flashcastrMentions.createdAt, windowStart),
    ))
    .groupBy(flashcastrMentions.authorFid);

  const rateLimitedAuthors = new Set<number>();
  for (const r of authorCounts) {
    if (Number(r.inboundCount) > RATE_LIMIT_MAX_INBOUND) rateLimitedAuthors.add(r.authorFid);
  }

  let replied = 0;
  let skipped = 0;

  for (const m of pending) {
    if (rateLimitedAuthors.has(m.authorFid)) {
      await markStatus(agentDb, m.castHash, 'skipped', now);
      skipped++;
      console.log(`[agent-flashcastr] Reply suppressed (rate-limited >${RATE_LIMIT_MAX_INBOUND}/h) for ${m.castHash} from @${m.authorUsername}`);
      continue;
    }

    const threadContext = m.threadRootHash
      ? await buildThreadContext(neynar, m.threadRootHash)
      : null;

    // Correction-intent gate (story 04): a public "you got X wrong, it's Y"
    // is classified, persisted (so it's injected into every future prompt
    // and never recurs), and acknowledged in character — distinct from the
    // normal persona reply path.
    const intent = await classifyInboundIntent(ai, m.text, threadContext);

    if (intent.kind === 'correction' && intent.correction) {
      const { wrongClaim, correctFact } = intent.correction;

      // Stage 1: relevance gate (cheap classify, fails closed). Off-topic
      // "corrections" never reach the web search.
      const relevance = await assessRelevance(ai, wrongClaim, correctFact);

      // Stage 2: bounded web fact-check (only when relevant AND under the
      // daily budget). Persisted iff confidence === 'high'.
      let verdict: { confidence: 'high' | 'low' | 'reject'; reasoning: string } | null = null;
      let persisted = false;
      let factCheckRan = false;
      if (relevance.relevant) {
        const underBudget = await isUnderFactCheckBudget(agentDb).catch((err) => {
          console.warn(`[agent-flashcastr] Fact-check budget read failed (treating as exhausted):`, (err as Error).message);
          return false;
        });
        if (underBudget) {
          factCheckRan = true;
          verdict = await factCheckCorrection(ai, wrongClaim, correctFact);
          if (verdict.confidence === 'high') {
            try {
              await insertCorrection(agentDb, {
                wrongClaim,
                correctFact,
                sourceCastHash: m.castHash,
                authorFid: m.authorFid,
                scope: 'all',
              });
              persisted = true;
            } catch (err) {
              // Persist failure must not swallow the public ack — log and still
              // acknowledge softly; the next verified correction re-teaches it.
              console.error(`[agent-flashcastr] Failed to persist verified correction for ${m.castHash}:`, (err as Error).message);
            }
          }
        }
      }

      // One audit row per inbound correction attempt, regardless of outcome.
      try {
        await insertCorrectionAudit(agentDb, {
          sourceCastHash: m.castHash,
          authorFid: m.authorFid,
          wrongClaim,
          correctFact,
          relevant: relevance.relevant,
          factCheckVerdict: factCheckRan ? verdict!.confidence : null,
          factCheckReasoning: factCheckRan ? verdict!.reasoning : (relevance.relevant ? 'budget exhausted' : relevance.reasoning),
          persisted,
        });
      } catch (err) {
        console.error(`[agent-flashcastr] Correction audit insert failed for ${m.castHash}:`, (err as Error).message);
      }

      // Ack: persisted → confident, restate the corrected fact. Otherwise →
      // discreet soft ack that does NOT restate either claim and does NOT
      // mention the verification process (preserves persona, denies trolls
      // any signal about what we did or didn't check).
      const ack = persisted
        ? await generateCorrectionAck(ai, wrongClaim, correctFact, m.authorUsername)
        : await generateSoftAck(ai, m.authorUsername);
      const ackOk = await dispatchCast(ctx, {
        accountHandle: FLASHCASTR_HANDLE,
        text: ack,
        parentHash: m.castHash,
        parentFid: m.authorFid,
        sourceEngine: SOURCE_ENGINE,
      });

      if (!ackOk) {
        await markStatus(agentDb, m.castHash, 'skipped', now);
        skipped++;
        console.error(`[agent-flashcastr] Correction ack dispatch failed for ${m.castHash} — marked skipped (no retry)`);
        continue;
      }

      await markStatus(agentDb, m.castHash, 'replied', now);
      replied++;
      counter?.inc();
      await likeRepliedInbound(ctx, m, likeCounter);
      const outcome = persisted ? 'persisted' : (factCheckRan ? `unverified (${verdict!.confidence})` : (relevance.relevant ? 'budget-skipped' : 'irrelevant'));
      console.log(`[agent-flashcastr] Correction from @${m.authorUsername} acked (${outcome}, ${m.castHash}): "${wrongClaim}" → "${correctFact}"`);
      continue;
    }

    const replyText = await generateReply(ai, m.text, m.authorUsername, threadContext, correctionsBlock);

    if (!replyText) {
      await markStatus(agentDb, m.castHash, 'skipped', now);
      skipped++;
      console.log(`[agent-flashcastr] Out-of-scope inbound ${m.castHash} from @${m.authorUsername} — no reply`);
      continue;
    }

    const ok = await dispatchCast(ctx, {
      accountHandle: FLASHCASTR_HANDLE,
      text: replyText,
      parentHash: m.castHash,
      parentFid: m.authorFid,
      sourceEngine: SOURCE_ENGINE,
    });

    if (!ok) {
      // No retry (mirrors dispatch-cast.ts). Mark skipped so re-poll can't
      // regenerate + re-dispatch the same inbound.
      await markStatus(agentDb, m.castHash, 'skipped', now);
      skipped++;
      console.error(`[agent-flashcastr] Reply dispatch failed for ${m.castHash} — marked skipped (no retry)`);
      continue;
    }

    await markStatus(agentDb, m.castHash, 'replied', now);
    replied++;
    counter?.inc();
    await likeRepliedInbound(ctx, m, likeCounter);
    console.log(`[agent-flashcastr] Replied to ${m.castHash} from @${m.authorUsername}`);
  }

  return { replied, skipped };
}

/**
 * Fire a visible "seen you" LIKE on the inbound cast we just replied to.
 * Best-effort and post-reply: likeCast never throws, and the reply has
 * already shipped + the row is already 'replied', so a like failure is
 * logged inside likeCast and otherwise ignored — it must never roll back
 * or re-trigger the reply. Only replied-to casts get a like (skipped /
 * out-of-scope mentions get none — by construction, this is only called
 * after a successful dispatch).
 */
async function likeRepliedInbound(
  ctx: ProcessContext,
  m: { castHash: string; authorFid: number },
  likeCounter?: ReplyCounter,
): Promise<void> {
  const liked = await likeCast(ctx, {
    accountHandle: FLASHCASTR_HANDLE,
    targetHash: m.castHash,
    targetFid: m.authorFid,
  });
  if (liked) likeCounter?.inc();
}

async function markStatus(
  agentDb: NonNullable<ProcessContext['agentDb']>,
  castHash: string,
  status: 'replied' | 'skipped',
  now: number,
): Promise<void> {
  await agentDb
    .update(flashcastrMentions)
    .set({ status, processedAt: new Date(now) })
    .where(eq(flashcastrMentions.castHash, castHash));
}
