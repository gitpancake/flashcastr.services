import { eq, and, lte, asc } from 'drizzle-orm';
import {
  farcasterCastPlans,
  getDailyFlag,
  setDailyFlag,
} from '@life-os/shared';
import type { ProcessContext, CastEmbed } from '@life-os/shared';
import { dispatchCast } from './dispatch-cast.js';
import { runDailyPrep } from './daily-prep.js';
import { verifyDraft } from './fact-verify.js';

const PROCESS_NAME = 'agent-flashcastr';
export const STALE_THRESHOLD_MS = 30 * 60 * 1000;

// Daily-prep gate: flag set BEFORE invoking so a thrown error never reopens it.
// Mirrors agent-blog/boot-catchup.ts:39-41.
export async function runDailyPrepGate(ctx: ProcessContext, hour: number): Promise<void> {
  const agentDb = ctx.agentDb!;
  const { timezone } = ctx;
  const prepDone = await getDailyFlag(agentDb, PROCESS_NAME, 'flashcastr_prep_done', timezone);
  if (!prepDone && hour >= 7) {
    await setDailyFlag(agentDb, PROCESS_NAME, 'flashcastr_prep_done', timezone);
    try {
      const result = await runDailyPrep(ctx);
      console.log(`[agent-flashcastr] Daily prep complete — ${result.plansCreated} plans created`);
    } catch (err) {
      console.error('[agent-flashcastr] Daily prep failed:', (err as Error).message);
    }
  }
}

// One plan per tick — natural 15-min spacing from the tick cadence.
// Plans older than STALE_THRESHOLD_MS are expired rather than published.
export async function publishReadyPlans(ctx: ProcessContext): Promise<void> {
  const agentDb = ctx.agentDb!;
  const now = new Date();

  const readyPlans = await agentDb
    .select()
    .from(farcasterCastPlans)
    .where(and(
      eq(farcasterCastPlans.status, 'approved'),
      lte(farcasterCastPlans.scheduledFor, now),
    ))
    .orderBy(asc(farcasterCastPlans.scheduledFor))
    .limit(1);

  const plan = readyPlans[0];
  if (!plan) return;

  const ageMs = now.getTime() - plan.scheduledFor!.getTime();
  if (ageMs > STALE_THRESHOLD_MS) {
    await agentDb.update(farcasterCastPlans)
      .set({ status: 'expired' })
      .where(eq(farcasterCastPlans.id, plan.id));
    console.log(`[agent-flashcastr] Skipped stale plan ${plan.id} — ${Math.round(ageMs / 60000)}min past scheduledFor`);
    return;
  }

  const finalText = plan.editedText ?? plan.text;

  // Pre-publish fact verification (story 04). The heuristic gate inside
  // verifyDraft skips the web_search for casts that already name their
  // resolved city, so most plans cost nothing here; one plan/tick caps it
  // further. `reject` → drop the cast (mark failed, no retry); `corrected`
  // → publish the fixed text; AI/parse failure fails open (publishes as-is).
  let publishText = finalText;
  if (ctx.ai) {
    const verified = await verifyDraft(ctx.ai, finalText);
    if (verified.verdict === 'reject') {
      await agentDb.update(farcasterCastPlans)
        .set({ status: 'failed' })
        .where(eq(farcasterCastPlans.id, plan.id));
      console.warn(`[agent-flashcastr] Plan ${plan.id} rejected pre-publish by fact-verify — not posted`);
      return;
    }
    if (verified.verdict === 'corrected') {
      console.log(`[agent-flashcastr] Plan ${plan.id} fact-corrected pre-publish`);
      publishText = verified.text;
    }
  }

  const embeds = (plan.embeds ?? []) as CastEmbed[];
  const dispatched = await dispatchCast(ctx, {
    accountHandle: plan.accountHandle,
    text: publishText,
    parentHash: plan.parentHash,
    channelId: plan.channelId,
    embeds,
    sourceEngine: PROCESS_NAME,
    sourcePlanId: plan.id,
  });
  await agentDb.update(farcasterCastPlans)
    .set({ status: dispatched ? 'published' : 'failed' })
    .where(eq(farcasterCastPlans.id, plan.id));
}
