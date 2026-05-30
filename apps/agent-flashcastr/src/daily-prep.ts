import { gte } from 'drizzle-orm';
import {
  flashcastrInvaderEvents,
  flashcastrExternalNews,
  farcasterCastPlans,
  getUserToday,
  getDayBoundsUTC,
  formatUserDate,
} from '@life-os/shared';
import type { ProcessContext, CastEmbed } from '@life-os/shared';
import { fetchAllCurated, searchOpenWeb, CURATED_SOURCES } from './source-fetcher.js';
import type { FetchedSource, DiscoveredUrl } from './source-fetcher.js';
import { scrapeAwazleon, type AwazleonItem } from './scrapers/awazleon.js';
import { fetchUserFlashes, fetchFlashcasterUsers, flashPhotoUrl } from './flashcastr-api.js';
import type { UnifiedFlash } from './flashcastr-api.js';
import { buildSystemPrompt } from './persona.js';
import { resolveCityName } from './city-codes.js';
import { getActiveCorrections, formatCorrectionsBlock } from './corrections.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface DailyPrepResult {
  plansCreated: number;
}

interface ValidLists {
  invaderIds: Set<string>;
  flashIds: Set<number>;
  castHashes: Set<string>;
  urls: Set<string>;
  flashLookup: Map<number, FlashCandidate>;
}

interface FlashCandidate {
  flashId: number;
  castHash: string;
  fid: number;
  city: string;
  player: string;
  /** Real flashcastr-sourced photo URL (content-addressed), null when none. */
  photoUrl: string | null;
}

interface RawPlan {
  text: string;
  contentType: string;
  sourceInvaderIds?: string[];
  sourceFlashId?: number | null;
  embeds?: { type: 'castId'; fid: number; hash: string }[];
  scheduledHourOffset?: number;
}

interface PlanAIResponse {
  plans: RawPlan[];
}

// ─── Constants ────────────────────────────────────────────────────────────

const SLOT_HOUR_FIRST = 6;
const SLOT_HOUR_LAST = 21;       // inclusive — 16 candidate hours [6, 21]
const SLOT_STAGGER_MINUTES = 30;

const CONTENT_PRIORITY: Record<string, number> = {
  destruction: 0,
  addition: 1,
  reactivation: 2,
  highlight: 3,
  milestone: 4,
};

/**
 * Hard cap on Sonnet input — invader-events plus external-news can balloon
 * if a scrape catches up after a long outage. We cap each list at this many
 * rows to keep token cost predictable.
 */
const MAX_EVENTS_INPUT = 60;
const MAX_NEWS_INPUT = 40;
const MAX_FLASH_CANDIDATES = 60;
const MAX_DISCOVERED_URLS = 25;

// ─── Public entry point ──────────────────────────────────────────────────

/**
 * Build a 24h cast plan for @flashcastr. Run once per day at ≥7am user-tz,
 * gated by the `flashcastr_prep_done` daily flag.
 *
 * Steps:
 *   1. Pull recent unposted invader events + external news from agent DB
 *   2. Refresh curated source cache (deltas only — full bodies stay in fetch)
 *   3. One web_search call for open-web discovery
 *   4. Authenticated awazleon scrape (env-gated; persisted ON CONFLICT DO NOTHING)
 *   5. Pull recent casted flashes from flashcastr API for highlight embeds
 *   6. Single Sonnet call returning {plans: RawPlan[]}
 *   7. Drop any plan that mentions a hallucinated invader ID / flash ID / URL
 *   8. Allocate ≥30min-spaced slots in the 06–21 window (next user-tz day)
 *   9. Insert as `farcaster_cast_plans` rows with status='approved'
 */
export async function runDailyPrep(ctx: ProcessContext): Promise<DailyPrepResult> {
  const agentDb = ctx.agentDb!;
  const today = getUserToday(ctx.timezone);
  const since7d = getDateDaysAgo(today, 7);

  // Steps 1-5 are independent I/O — fan out in parallel so the slowest leg
  // (open-web search, awazleon scrape) gates total latency.
  const [events, newsRows, sourceDeltas, discovered, awazleonItems, flashCandidates] = await Promise.all([
    agentDb.select().from(flashcastrInvaderEvents).where(gte(flashcastrInvaderEvents.eventDate, since7d)).limit(MAX_EVENTS_INPUT),
    agentDb.select().from(flashcastrExternalNews).where(gte(flashcastrExternalNews.scrapedAt, daysAgoDate(7))).limit(MAX_NEWS_INPUT),
    safeFetchCuratedDeltas(agentDb),
    safeSearchOpenWeb(ctx, agentDb),
    safeScrapeAwazleon(),
    safeFetchFlashCandidates(),
  ]);

  const unpostedEvents = events.filter((e) => !e.castGenerated);
  const unpostedNews = newsRows.filter((n) => !n.castGenerated);

  // Persist awazleon items before the AI call so they survive a crash mid-prompt.
  await persistAwazleon(agentDb, awazleonItems);

  // 6. Build the AI bundle
  const valid = buildValidLists({
    events: unpostedEvents,
    flashCandidates,
    sourceDeltas,
    discovered,
    awazleonItems,
    newsRows: unpostedNews,
  });

  // Skip the AI call entirely when we have nothing to talk about — saves a
  // wasted Sonnet round-trip on quiet days.
  const haveSignal =
    unpostedEvents.length + unpostedNews.length + sourceDeltas.length + discovered.length > 0;
  if (!haveSignal) {
    console.log('[agent-flashcastr] Daily prep: no signal — skipping plan generation');
    return { plansCreated: 0 };
  }

  // Learned public corrections (story 04) — prepended so the planner never
  // repeats a fact the community already corrected.
  const correctionsBlock = formatCorrectionsBlock(await getActiveCorrections(agentDb));

  const userPrompt = buildUserPrompt({
    valid,
    events: unpostedEvents,
    newsRows: unpostedNews,
    sourceDeltas,
    discovered,
    awazleonItems,
    today,
    correctionsBlock,
  });

  const raw = await ctx.ai!.completeJsonSafe<PlanAIResponse>(
    {
      task: 'generate',
      taskName: 'flashcastr_daily_plans',
      maxTokens: 4096,
      cacheSystem: true,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    },
    { plans: [] },
    { wrapKey: 'plans' },
  );

  // 7. Validate
  const rawPlans = raw?.plans ?? [];
  const validated = rawPlans.filter((plan) => validatePlan(plan, valid));
  const dropped = rawPlans.length - validated.length;
  if (dropped > 0) {
    console.warn(`[agent-flashcastr] Daily prep: dropped ${dropped} hallucinated plan(s)`);
  }
  if (validated.length === 0) return { plansCreated: 0 };

  // 8. Slot allocation
  const slotted = allocateSlots(validated, today, ctx.timezone);

  // 9. Insert
  let inserted = 0;
  for (const slot of slotted) {
    const aiEmbeds = (slot.plan.embeds ?? []) as CastEmbed[];
    // Real flash photo (deterministic, not AI-authored) leads the embed list
    // so it's the primary visual; cap at Farcaster's 2-embed max.
    const photoEmbed = resolvePhotoEmbed(slot.plan, valid);
    const embeds = (photoEmbed ? [photoEmbed, ...aiEmbeds] : aiEmbeds).slice(0, 2);
    await agentDb.insert(farcasterCastPlans).values({
      accountHandle: 'flashcastr',
      planType: 'original',
      text: slot.plan.text,
      reasoning: `daily-prep ${today} — ${slot.plan.contentType}`,
      contextSource: 'daily-prep',
      status: 'approved',
      embeds,
      channelId: 'invaders',
      scheduledFor: slot.scheduledFor,
      forDate: formatUserDate(slot.scheduledFor, ctx.timezone),
    });
    inserted++;
  }

  return { plansCreated: inserted };
}

// ─── Validation ──────────────────────────────────────────────────────────

const INVADER_ID_PATTERN = /\b[A-Z]{2,6}_\d+\b/g;
const URL_PATTERN = /https?:\/\/\S+/g;

/**
 * Drop any plan that names an invader ID, flash ID, cast hash, or URL not
 * present in the VALID lists. The check is intentionally strict — a single
 * hallucinated reference taints the whole plan.
 */
export function validatePlan(plan: RawPlan, valid: ValidLists): boolean {
  const trim = (s: string) => s.replace(/[.,;:!?)\]]+$/g, '');

  // Invader IDs in body
  for (const m of plan.text.matchAll(INVADER_ID_PATTERN)) {
    if (!valid.invaderIds.has(m[0])) {
      console.warn(`[agent-flashcastr] Daily prep: rejected — unknown invader ID "${m[0]}" in: "${plan.text}"`);
      return false;
    }
  }

  // Invader IDs claimed in source list
  for (const id of plan.sourceInvaderIds ?? []) {
    if (!valid.invaderIds.has(id)) {
      console.warn(`[agent-flashcastr] Daily prep: rejected — claimed source invader ID "${id}" not in valid set`);
      return false;
    }
  }

  // URLs in body
  for (const m of plan.text.matchAll(URL_PATTERN)) {
    if (!valid.urls.has(trim(m[0]))) {
      console.warn(`[agent-flashcastr] Daily prep: rejected — unknown URL "${m[0]}" in: "${plan.text}"`);
      return false;
    }
  }

  // Flash ID
  if (plan.sourceFlashId != null && !valid.flashIds.has(plan.sourceFlashId)) {
    console.warn(`[agent-flashcastr] Daily prep: rejected — unknown flash ID ${plan.sourceFlashId}`);
    return false;
  }

  // Embeds (castId) — fid + hash must both come from the valid flash set
  for (const embed of plan.embeds ?? []) {
    if (embed.type !== 'castId') continue;
    if (!valid.castHashes.has(embed.hash)) {
      console.warn(`[agent-flashcastr] Daily prep: rejected — unknown cast hash ${embed.hash} in embed`);
      return false;
    }
  }

  return true;
}

// ─── Slot allocation ─────────────────────────────────────────────────────

interface SlottedPlan {
  plan: RawPlan;
  scheduledFor: Date;
}

/**
 * Spread `plans` across [06:00, 21:30] of the next user-tz day with ≥30min
 * stagger. Sorted by content-type priority — destructions first so they get
 * the early-morning slot with the most attention.
 *
 * For N ≤ 16 plans, slots are evenly distributed across the 16-hour window
 * (hour = first + floor(i * 16 / N)) so a quiet day doesn't front-load every
 * cast into early morning. For N > 16, packing wraps with +30min stagger
 * rather than spilling into late-night.
 */
export function allocateSlots(plans: RawPlan[], today: string, timezone: string): SlottedPlan[] {
  const sorted = [...plans].sort((a, b) => priority(a) - priority(b));
  const tomorrow = addDaysUTC(today, 1);
  const { dayStart } = getDayBoundsUTC(tomorrow, timezone);
  const HOURS_IN_WINDOW = SLOT_HOUR_LAST - SLOT_HOUR_FIRST + 1; // 16

  const slots: SlottedPlan[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const plan = sorted[i]!;
    let hour: number;
    let halfHour: number;
    if (sorted.length <= HOURS_IN_WINDOW) {
      const step = HOURS_IN_WINDOW / sorted.length;
      hour = SLOT_HOUR_FIRST + Math.floor(i * step);
      halfHour = 0;
    } else {
      hour = SLOT_HOUR_FIRST + (i % HOURS_IN_WINDOW);
      halfHour = i >= HOURS_IN_WINDOW ? SLOT_STAGGER_MINUTES : 0;
    }
    if (hour > SLOT_HOUR_LAST) break;       // never schedule past 21:30
    const scheduledFor = new Date(dayStart.getTime() + (hour * 60 + halfHour) * 60_000);
    slots.push({ plan, scheduledFor });
  }
  return slots;
}

function priority(plan: RawPlan): number {
  return CONTENT_PRIORITY[plan.contentType] ?? 99;
}

// ─── AI prompt ───────────────────────────────────────────────────────────

const TASK_BLOCK = `Your job: once per day, draft 24h of casts from a curated input bundle.

ANTI-HALLUCINATION (non-negotiable — validated post-generation):
- The ONLY invader IDs you may write are those in the VALID INVADER IDS list.
- The ONLY flash IDs / cast hashes you may use as embeds are those in the VALID FLASH IDS list.
- The ONLY URLs you may cite are those in the VALID URLS list.
- NEVER state installation dates, ages, or "still active" claims unless explicitly present in the event data.
- NEVER invent player names. Only mention players from the VALID FLASH IDS list.
- If insufficient data, return {"plans": []}.

CONTENT TYPES (use exactly one per plan):
- destruction — an invader was destroyed/degraded. Sad tone.
- addition — new install spotted. Celebratory.
- reactivation — restored after damage. Comeback story.
- highlight — feature an existing casted flash. Embed via castId.
- milestone — count threshold (e.g., 1000 flashes in a city).

OUTPUT FORMAT — JSON only, no prose, no markdown:
{
  "plans": [
    {
      "text": "cast body, ≤280 chars",
      "contentType": "destruction|addition|reactivation|highlight|milestone",
      "sourceInvaderIds": ["PA_1099"],
      "sourceFlashId": 1234,
      "embeds": [{"type":"castId","fid":1234,"hash":"0xabc..."}],
      "scheduledHourOffset": 0
    }
  ]
}

Field rules:
- sourceInvaderIds: every ID mentioned in text plus any background sources. Empty array OK for milestone/highlight.
- sourceFlashId: numeric flash_id used for highlight content; null otherwise.
- embeds: only for highlight content. Empty array for everything else.
- scheduledHourOffset: 0 (planner re-slots after generation — leave as 0).

Quality bar: one plan per real signal. No filler. No speculation. No "according to reports". Empty array is a valid response.`;

const SYSTEM_PROMPT = buildSystemPrompt(TASK_BLOCK);

interface PromptInputs {
  valid: ValidLists;
  events: { invaderId: string; city: string; eventType: string; eventDate: string; rawText: string | null }[];
  newsRows: { source: string; url: string; title: string; body: string; publishedAt: string | null }[];
  sourceDeltas: FetchedSource[];
  discovered: DiscoveredUrl[];
  awazleonItems: AwazleonItem[];
  today: string;
  /** Active learned-corrections block (story 04) — '' when none. */
  correctionsBlock?: string;
}

export function buildUserPrompt(input: PromptInputs): string {
  const { valid, events, newsRows, sourceDeltas, discovered, awazleonItems, today, correctionsBlock } = input;

  const validFlashLines = [...valid.flashLookup.values()]
    .map((f) => `${f.flashId} | castHash=${f.castHash} | fid=${f.fid} | city=${resolveCityName(f.city)} | player=${f.player}`)
    .join('\n');

  // FTBL-class fix: render the RESOLVED city, never the raw code, so the
  // model never has to (and is told never to) expand a code itself.
  const eventLines = events
    .map((e) => `${e.eventDate} | ${e.eventType} | ${e.invaderId} (${resolveCityName(e.city)}) — ${e.rawText ?? ''}`)
    .join('\n');

  // Authoritative code→city glossary for every code present this run.
  const codesPresent = [...new Set(events.map((e) => e.city))]
    .map((c) => `${c} = ${resolveCityName(c)}`)
    .sort();
  const codeGlossary = codesPresent.join('\n');

  const newsLines = newsRows
    .map((n) => `${n.publishedAt ?? '—'} | [${n.source}] ${n.title} — ${n.body.slice(0, 240)}`)
    .join('\n');

  const deltaLines = sourceDeltas
    .filter((d) => d.changed)
    .map((d) => `${d.label} (${d.classification}) — ${d.url}`)
    .join('\n');

  const discoveredLines = discovered
    .map((d) => `${d.url} — ${d.snippet}`)
    .join('\n');

  const awazLines = awazleonItems
    .map((a) => `${a.publishedAt ?? '—'} | ${a.title} — ${a.body.slice(0, 200)}`)
    .join('\n');

  const sections = [
    ...(correctionsBlock ? [correctionsBlock.trimEnd()] : []),
    `DATE: ${today}`,
    `CITY CODES (authoritative — use these resolved names, never expand a code yourself):\n${codeGlossary || '(none)'}`,
    `VALID INVADER IDS:\n${[...valid.invaderIds].join(', ') || '(none)'}`,
    `VALID FLASH IDS:\n${validFlashLines || '(none)'}`,
    `VALID URLS:\n${[...valid.urls].join('\n') || '(none)'}`,
    `RECENT INVADER EVENTS (last 7d, unposted):\n${eventLines || '(none)'}`,
    `RECENT EXTERNAL NEWS (last 7d, unposted):\n${newsLines || '(none)'}`,
    `CURATED SOURCE DELTAS (changed since last run):\n${deltaLines || '(none)'}`,
    `OPEN-WEB DISCOVERY:\n${discoveredLines || '(none)'}`,
    `AWAZLEON ITEMS (this run):\n${awazLines || '(none)'}`,
  ];

  return sections.join('\n\n');
}

// ─── Source bundling ──────────────────────────────────────────────────────

interface ValidListInputs {
  events: { invaderId: string }[];
  flashCandidates: FlashCandidate[];
  sourceDeltas: FetchedSource[];
  discovered: DiscoveredUrl[];
  awazleonItems: AwazleonItem[];
  newsRows: { url: string }[];
}

function buildValidLists(input: ValidListInputs): ValidLists {
  const invaderIds = new Set<string>(input.events.map((e) => e.invaderId));
  const flashIds = new Set<number>();
  const castHashes = new Set<string>();
  const urls = new Set<string>();
  const flashLookup = new Map<number, FlashCandidate>();

  for (const f of input.flashCandidates) {
    flashIds.add(f.flashId);
    castHashes.add(f.castHash);
    flashLookup.set(f.flashId, f);
  }

  for (const src of CURATED_SOURCES) urls.add(src.url);
  for (const d of input.sourceDeltas) urls.add(d.url);
  for (const d of input.discovered) urls.add(d.url);
  for (const a of input.awazleonItems) urls.add(a.url);
  for (const n of input.newsRows) urls.add(n.url);

  return { invaderIds, flashIds, castHashes, urls, flashLookup };
}

// ─── External calls (each isolated; failures don't abort the run) ────────

async function safeFetchCuratedDeltas(agentDb: ProcessContext['agentDb']): Promise<FetchedSource[]> {
  try {
    return await fetchAllCurated(agentDb!);
  } catch (err) {
    console.warn('[agent-flashcastr] Daily prep: curated fetch failed (non-fatal):', (err as Error).message);
    return [];
  }
}

async function safeSearchOpenWeb(
  ctx: ProcessContext,
  agentDb: ProcessContext['agentDb'],
): Promise<DiscoveredUrl[]> {
  try {
    const found = await searchOpenWeb(
      ctx.ai!,
      'Space Invader street art news this week',
      8,
      agentDb!,
    );
    return found.slice(0, MAX_DISCOVERED_URLS);
  } catch (err) {
    console.warn('[agent-flashcastr] Daily prep: open-web search failed (non-fatal):', (err as Error).message);
    return [];
  }
}

async function safeScrapeAwazleon(): Promise<AwazleonItem[]> {
  const user = process.env.AWAZLEON_USER;
  const pass = process.env.AWAZLEON_PASS;
  if (!user || !pass) return [];
  try {
    return await scrapeAwazleon(user, pass);
  } catch (err) {
    console.warn('[agent-flashcastr] Daily prep: awazleon scrape failed (non-fatal):', (err as Error).message);
    return [];
  }
}

async function persistAwazleon(
  agentDb: ProcessContext['agentDb'],
  items: AwazleonItem[],
): Promise<void> {
  if (items.length === 0) return;
  const rows = items.map((a) => ({
    source: 'awazleon',
    url: a.url,
    title: a.title,
    body: a.body,
    publishedAt: a.publishedAt,
  }));
  await agentDb!.insert(flashcastrExternalNews).values(rows).onConflictDoNothing();
}

/**
 * Returns the up-to-MAX_FLASH_CANDIDATES most recent casted flashes across
 * all flashcastr users. Returns [] if FLASHCASTR_API_URL is unset.
 *
 * Per-user fetches fan out via Promise.allSettled — one slow/failing user
 * shouldn't gate the others, and serial would make this O(N) GraphQL calls
 * for no reason.
 */
async function safeFetchFlashCandidates(): Promise<FlashCandidate[]> {
  const apiUrl = process.env.FLASHCASTR_API_URL;
  if (!apiUrl) return [];

  try {
    const users = await fetchFlashcasterUsers(apiUrl);
    if (users.length === 0) return [];

    const settled = await Promise.allSettled(
      users.map((u) => fetchUserFlashes(apiUrl, u.username)),
    );

    const candidates: FlashCandidate[] = [];
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      for (const flash of result.value) {
        const fc = toFlashCandidate(flash);
        if (fc) candidates.push(fc);
        if (candidates.length >= MAX_FLASH_CANDIDATES) return candidates;
      }
    }
    return candidates;
  } catch (err) {
    console.warn('[agent-flashcastr] Daily prep: flash candidate fetch failed (non-fatal):', (err as Error).message);
    return [];
  }
}

function toFlashCandidate(f: UnifiedFlash): FlashCandidate | null {
  const fc = f.farcaster_user;
  if (!fc?.cast_hash) return null;
  return {
    flashId: f.flash_id,
    castHash: fc.cast_hash,
    fid: fc.fid,
    city: f.city,
    player: f.player,
    photoUrl: flashPhotoUrl(f),
  };
}

/**
 * Deterministically resolve a real flash-photo `url` embed for a plan.
 *
 * Only `addition`/`highlight` casts get a photo, and only when the plan names
 * a `sourceFlashId` present in the validated flash set with a resolvable
 * photo URL. The URL is never AI-authored — it is rebuilt from the API's
 * `ipfs_cid`, so this adds no hallucination surface. Returns null (resolver
 * no-ops, cast stays text-only) for every other case.
 *
 * Known gap (follow-up): `addition` casts are sourced from invader *events*
 * (`flashcastr_invader_events`), which carry no flash linkage today, so an
 * addition's `sourceFlashId` is null and it stays text-only until an
 * event→flash join exists. Highlights (which set `sourceFlashId`) get photos.
 */
export function resolvePhotoEmbed(plan: RawPlan, valid: ValidLists): CastEmbed | null {
  if (plan.contentType !== 'addition' && plan.contentType !== 'highlight') return null;
  if (plan.sourceFlashId == null) return null;
  const candidate = valid.flashLookup.get(plan.sourceFlashId);
  if (!candidate?.photoUrl) return null;
  return { type: 'url', url: candidate.photoUrl };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function getDateDaysAgo(today: string, days: number): string {
  const d = new Date(today + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split('T')[0]!;
}

function daysAgoDate(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

function addDaysUTC(today: string, days: number): string {
  const d = new Date(today + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0]!;
}
