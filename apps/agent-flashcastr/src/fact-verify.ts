import type { AIClient } from '@life-os/shared';
import { CITY_CODES, resolveCityName } from './city-codes.js';

/**
 * Pre-publish fact verification (story 04). The FTBL-class bug — an invader
 * ID's city-code prefix free-associated into a wrong word ("FTBL" → football,
 * not Fontainebleau) — is fixed at the prompt level (resolved city names +
 * persona rule). This is the belt-and-braces second line: any draft that
 * still references a known-code invader WITHOUT naming its real city gets a
 * single capped `web_search` round-trip to confirm the location/abbreviation
 * before it is published. Mismatch → corrected or rejected pre-publish.
 *
 * Cost is bounded two ways: the heuristic gate (most casts skip the call
 * entirely) and `web_search.max_uses` (one bundle of searches, not a loop).
 * The caller (publishReadyPlans) also dispatches at most one plan per tick.
 */

const INVADER_ID_TOKEN = /\b([A-Z]{2,6})_\d+\b/g;

export type VerifyVerdict = 'ok' | 'corrected' | 'reject';

export interface VerifyResult {
  verdict: VerifyVerdict;
  /** The text to publish: original on `ok`, the model's fix on `corrected`. */
  text: string;
}

/**
 * Cheap, deterministic gate. Trigger verification only when the draft names
 * an invader whose city code we KNOW resolves to a real city, yet that city
 * name is absent from the text — exactly the shape that produced the FTBL
 * bug (a code talked about with no grounding city, leaving the model free to
 * have expanded the prefix into a wrong word). Casts that already name the
 * resolved city, or reference no known code, skip the web_search entirely.
 */
export function needsVerification(text: string): boolean {
  const lower = text.toLowerCase();
  for (const match of text.matchAll(INVADER_ID_TOKEN)) {
    const prefix = match[1]!;
    const resolved = CITY_CODES[prefix];
    if (!resolved) continue;                       // unknown code: nothing to contradict
    if (!lower.includes(resolved.toLowerCase())) return true;
  }
  return false;
}

interface RawVerdict {
  verdict?: string;
  correctedText?: unknown;
}

function extractJson(text: string): RawVerdict | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as RawVerdict;
  } catch {
    return null;
  }
}

/**
 * Verify a draft cast before publish. Fails OPEN: any AI/parse/network
 * failure returns `ok` with the original text — a verification outage must
 * never silently nuke every scheduled cast (mirrors the no-retry resilience
 * of dispatch-cast.ts). A genuine `reject` verdict from the model is the
 * only path that drops a cast.
 *
 * @param maxSearches cap on web_search tool uses for this single call.
 */
export async function verifyDraft(
  ai: AIClient,
  text: string,
  maxSearches = 3,
): Promise<VerifyResult> {
  if (!needsVerification(text)) return { verdict: 'ok', text };

  // Ground the model with the codes we DO know so it only web-searches the
  // genuinely ambiguous remainder rather than re-deriving the whole map.
  const known = [...text.matchAll(INVADER_ID_TOKEN)]
    .map((m) => m[1]!)
    .filter((p) => CITY_CODES[p])
    .map((p) => `${p} = ${resolveCityName(p)}`);
  const knownBlock = known.length ? `\nKnown city codes (authoritative — do not re-verify these):\n${[...new Set(known)].join('\n')}\n` : '';

  try {
    const result = await ai.complete({
      task: 'search',
      taskName: 'flashcastr_fact_verify',
      maxTokens: 1024,
      tools: [{
        type: 'web_search_20260209',
        name: 'web_search',
        max_uses: maxSearches,
        allowed_callers: ['direct'],
      }],
      cacheSystem: true,
      system: `You fact-check a single draft Farcaster cast about Space Invader street art before it is published. Check ONLY location names and expanded abbreviations in the draft — is every place/abbreviation correct? Use web_search sparingly to confirm anything you are unsure of. Do NOT rewrite voice or style.

Decide:
- "ok" — every factual location/abbreviation claim checks out.
- "corrected" — a claim was wrong but fixable; supply correctedText with ONLY the factual fix applied, voice unchanged, still under 280 chars.
- "reject" — a claim is wrong and not safely fixable; the cast should not publish.

Respond with ONLY valid JSON, no markdown:
{"verdict":"ok"} or {"verdict":"corrected","correctedText":"..."} or {"verdict":"reject"}`,
      messages: [{ role: 'user', content: `Draft cast:\n${text}\n${knownBlock}\nFact-check it now.` }],
    });

    const parsed = extractJson(result.text);
    const verdict = parsed?.verdict;

    if (verdict === 'reject') return { verdict: 'reject', text };
    if (verdict === 'corrected') {
      const corrected = String(parsed?.correctedText ?? '').trim();
      // A "corrected" verdict with no usable replacement is unsafe to ship.
      if (!corrected) return { verdict: 'reject', text };
      return { verdict: 'corrected', text: corrected };
    }
    return { verdict: 'ok', text };
  } catch (err) {
    console.warn('[agent-flashcastr] Fact-verify failed (failing open):', (err as Error).message);
    return { verdict: 'ok', text };
  }
}
