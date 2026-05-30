import type { AIClient } from '@life-os/shared';

/**
 * Reply-driven correction verification gate (story 05).
 *
 * Sits between `correction-intent` (which extracts {wrongClaim, correctFact})
 * and `persistCorrection` so a stranger's reply can't poison the corrections
 * block by asserting a fake "fix". Two stages:
 *
 *   1) `assessRelevance` — cheap classify call. Drops trolls / off-topic
 *      claims (not about Space Invaders, IDs, cities, dates, status) before
 *      we spend a web search on them.
 *   2) `factCheckCorrection` — Opus + bounded `web_search` (max_uses=2).
 *      Returns confidence: `high` (web evidence supports correctFact),
 *      `low` (insufficient evidence either way), or `reject` (web evidence
 *      contradicts correctFact).
 *
 * Fails CLOSED — unlike `fact-verify.ts` (which fails open so a publish
 * outage doesn't nuke every cast), an inability to verify a reply-driven
 * correction must NOT auto-persist. Trust requires evidence.
 *
 * Caller responsibilities (in `conversational-reply.ts`):
 *   - apply a per-24h budget cap to `factCheckCorrection`
 *   - on `high`: persist + acknowledge restating the corrected fact
 *   - on anything else: soft non-committal ack, no persist, audit row only
 *   - never reveal the verification process in any reply text
 */

export interface RelevanceResult {
  relevant: boolean;
  reasoning: string;
}

export type CorrectionVerdict = 'high' | 'low' | 'reject';

export interface FactCheckResult {
  confidence: CorrectionVerdict;
  reasoning: string;
}

const RELEVANCE_SYSTEM = `You decide whether an alleged factual "correction" to @flashcastr is about its actual domain.

@flashcastr is an automated account that hunts and documents Space Invader street art mosaics by the French artist Invader. In-domain topics:
- invader IDs (e.g. "PA_1099", "FTBL_05") and their city-code prefixes
- city names where invaders are placed (Paris, Fontainebleau, London, etc.)
- the artist Invader, his crew, his history
- invader status (active / destroyed / restored) and dates
- physical locations / addresses / arrondissements

OUT of domain: politics, crypto, sports scores, generic banter, the user's own personal life, jokes that happen to use "wrong"/"actually".

Respond with ONLY valid JSON, no markdown:
{"relevant": true, "reasoning": "one short sentence"}
or
{"relevant": false, "reasoning": "one short sentence"}`;

interface RawRelevance {
  relevant?: unknown;
  reasoning?: unknown;
}

/**
 * Cheap Invader-domain relevance gate. Fails CLOSED — any AI / parse failure
 * returns `relevant: false` so we don't burn a web search on garbage and we
 * don't risk persisting an off-topic "correction".
 */
export async function assessRelevance(
  ai: AIClient,
  wrongClaim: string,
  correctFact: string,
): Promise<RelevanceResult> {
  try {
    const raw = await ai.completeJson<RawRelevance>({
      task: 'classify',
      taskName: 'flashcastr_correction_relevance',
      maxTokens: 200,
      cacheSystem: true,
      system: RELEVANCE_SYSTEM,
      messages: [{
        role: 'user',
        content: `Alleged correction:\n- wrong claim: "${wrongClaim}"\n- correct fact: "${correctFact}"\n\nEmit the JSON object now.`,
      }],
    });

    const relevant = raw?.relevant === true;
    const reasoning = typeof raw?.reasoning === 'string' ? raw.reasoning : '(none)';
    return { relevant, reasoning };
  } catch (err) {
    console.warn('[agent-flashcastr] Correction relevance assessment failed (failing closed):', (err as Error).message);
    return { relevant: false, reasoning: 'relevance check failed' };
  }
}

const FACT_CHECK_SYSTEM = `You fact-check a single alleged correction sent to @flashcastr (a Space Invader street art tracker).

You are given the claim the account allegedly made (wrongClaim) and the asserted correction (correctFact). Use the web_search tool sparingly to find independent evidence about correctFact. Sources to favour: invaderspotter.art, space-invaders.com, the artist Invader's official site, the Invader app's public data, reputable street-art press. Wikipedia and random forums are weak evidence.

Decide:
- "high" — web evidence clearly supports correctFact (multiple consistent sources, or one authoritative source). Safe to persist.
- "reject" — web evidence clearly contradicts correctFact (it would itself be wrong). Drop.
- "low" — insufficient or conflicting evidence. Default when unsure. Do NOT persist.

Be conservative: prefer "low" over "high" when in doubt. A false-positive "high" poisons future generated casts.

Respond with ONLY valid JSON, no markdown:
{"confidence":"high","reasoning":"one short sentence citing what the web sources said"}
or {"confidence":"low","reasoning":"..."} or {"confidence":"reject","reasoning":"..."}`;

interface RawFactCheck {
  confidence?: unknown;
  reasoning?: unknown;
}

const VERDICTS: readonly CorrectionVerdict[] = ['high', 'low', 'reject'];

function extractJson(text: string): RawFactCheck | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as RawFactCheck;
  } catch {
    return null;
  }
}

/**
 * Web-evidence fact-check of an alleged correction. Bounded by `maxSearches`
 * web_search uses (default 2). Fails CLOSED: any AI / parse / network error
 * returns confidence `low` so the correction is NOT persisted.
 */
export async function factCheckCorrection(
  ai: AIClient,
  wrongClaim: string,
  correctFact: string,
  maxSearches = 2,
): Promise<FactCheckResult> {
  try {
    const result = await ai.complete({
      task: 'search',
      taskName: 'flashcastr_correction_fact_check',
      maxTokens: 1024,
      tools: [{
        type: 'web_search_20260209',
        name: 'web_search',
        max_uses: maxSearches,
        allowed_callers: ['direct'],
      }],
      cacheSystem: true,
      system: FACT_CHECK_SYSTEM,
      messages: [{
        role: 'user',
        content: `Alleged correction sent to @flashcastr:\n- wrong claim: "${wrongClaim}"\n- correct fact (to verify): "${correctFact}"\n\nFact-check it now and emit the JSON verdict.`,
      }],
    });

    const parsed = extractJson(result.text);
    const verdict = parsed?.confidence;
    const reasoning = typeof parsed?.reasoning === 'string' ? parsed.reasoning : '(none)';

    if (VERDICTS.includes(verdict as CorrectionVerdict)) {
      return { confidence: verdict as CorrectionVerdict, reasoning };
    }
    return { confidence: 'low', reasoning: 'unparseable verdict' };
  } catch (err) {
    console.warn('[agent-flashcastr] Correction fact-check failed (failing closed):', (err as Error).message);
    return { confidence: 'low', reasoning: 'fact-check call failed' };
  }
}
