import type { AIClient } from '@life-os/shared';

/**
 * Inbound-intent classifier (story 04). Mirrors kelly-frears
 * `feedbackIntent.ts` + `.claude/commands/feedback-intent.md`, ported to the
 * life-os stack (`createAIClient()`, not the Claude Code CLI). Classifies a
 * Farcaster reply/mention to @flashcastr as:
 *
 * - `correction` — the author asserts @flashcastr stated a fact WRONG
 *   ("FTBL is Fontainebleau, not football", "that's not PA_1099", "wrong,
 *   it was destroyed in 2019"). Only this kind carries a structured
 *   `{wrongClaim, correctFact}` and drives the persist + ack loop.
 * - `guidance` — a behavioural rule for the future ("stop using so many
 *   emoji", "always tag the city"). Acknowledged via the normal reply path.
 * - `question` — anything else (the safe default): a question, banter,
 *   praise. Routed to the normal persona reply.
 *
 * Classification only — no side effects. The caller (processNewMentions)
 * persists corrections and dispatches the in-character acknowledgement.
 */

export type InboundIntentKind = 'question' | 'correction' | 'guidance';

export interface InboundIntent {
  kind: InboundIntentKind;
  /** Present (and only meaningful) when kind === 'correction'. */
  correction: { wrongClaim: string; correctFact: string } | null;
  reasoning: string;
}

const INTENT_KINDS: InboundIntentKind[] = ['question', 'correction', 'guidance'];

interface RawIntent {
  kind?: string;
  correction?: { wrongClaim?: unknown; correctFact?: unknown } | null;
  reasoning?: unknown;
}

const SYSTEM = `You are an intent classifier for public Farcaster replies sent to @flashcastr, an automated Space Invader hunt account.

Decide if the inbound reply is a factual CORRECTION of something @flashcastr said, behavioural GUIDANCE for the future, or just a QUESTION (default).

# Kinds
- "correction" — the author says @flashcastr stated a fact WRONG and supplies the right one. Indicators: "wrong", "actually", "that's not", "it's X not Y", "FTBL is Fontainebleau not football", a direct contradiction of an ID / city / status / date @flashcastr asserted. Extract:
  - wrongClaim: the incorrect assertion, short ("FTBL is football")
  - correctFact: the corrected fact, short ("FTBL is Fontainebleau")
- "guidance" — a behavioural rule for the future ("from now on", "always", "stop doing X", "be less Y", tone/style notes). No structured fields.
- "question" — anything else: a question, banter, praise, off-topic. The safe default.

If it could be question OR correction but no specific wrong fact is supplied, pick "question". If unclear → "question".

# Output
Respond with ONLY valid JSON, no markdown:
{"kind":"correction","correction":{"wrongClaim":"...","correctFact":"..."},"reasoning":"one short sentence"}
or
{"kind":"guidance","correction":null,"reasoning":"..."}
or
{"kind":"question","correction":null,"reasoning":"..."}`;

/**
 * Classify an inbound reply. Robust by design: any parse failure, missing
 * kind, or a `correction` verdict without both extracted fields degrades to
 * `question` (the safe default) so a misfire never blocks the normal reply
 * path. Uses the cheap `classify` task (Sonnet) per the AIClient policy.
 */
export async function classifyInboundIntent(
  ai: AIClient,
  inboundText: string,
  threadContext: string | null,
): Promise<InboundIntent> {
  const safe: InboundIntent = { kind: 'question', correction: null, reasoning: 'default (classifier unavailable)' };

  try {
    const raw = await ai.completeJson<RawIntent>({
      task: 'classify',
      taskName: 'flashcastr_inbound_intent',
      maxTokens: 300,
      cacheSystem: true,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `${threadContext ? `Thread so far:\n${threadContext}\n\n` : ''}Inbound reply to @flashcastr:\n${inboundText}\n\nEmit the JSON object now.`,
      }],
    });

    const kind = INTENT_KINDS.includes(raw?.kind as InboundIntentKind)
      ? (raw!.kind as InboundIntentKind)
      : 'question';
    const reasoning = typeof raw?.reasoning === 'string' ? raw.reasoning : '(none)';

    if (kind !== 'correction') return { kind, correction: null, reasoning };

    const wrongClaim = String(raw?.correction?.wrongClaim ?? '').trim();
    const correctFact = String(raw?.correction?.correctFact ?? '').trim();
    if (!wrongClaim || !correctFact) {
      // correction without both fields → can't persist anything; treat as a
      // normal reply rather than store a half-formed correction.
      return { kind: 'question', correction: null, reasoning: `${reasoning} (correction lacked fields; degraded)` };
    }
    return { kind: 'correction', correction: { wrongClaim, correctFact }, reasoning };
  } catch (err) {
    console.warn('[agent-flashcastr] Intent classification failed:', (err as Error).message);
    return safe;
  }
}
