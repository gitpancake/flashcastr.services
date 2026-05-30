import 'dotenv/config';
import {
  createProcess,
  createLifeEvent,
  ROUTING_KEYS,
  flashcastrInvaderEvents,
  flashcastrExternalNews,
  getUserToday,
  getUserHour,
  getDailyFlag,
  setDailyFlag,
  getSyncToken,
  updateSyncToken,
  writeAgentObservation,
  loadAgentContext,
  validateEnv,
} from '@life-os/shared';
import type {
  ProcessContext,
  LifeEvent,
  FlashcastrContentRequestPayload,
  FlashcastrContentResponsePayload,
  FlashcastrContentSuggestion,
  FlashcastrContentAcceptedPayload,
  FlashcastrHighlightRequestPayload,
  FlashcastrHighlightResponsePayload,
  FlashcastrRoundupRequestPayload,
  FlashcastrRoundupResponsePayload,
  FlashcastrRoundupEvent,
  FlashcastrStats,
  ContentReadyPayload,
  ContentDomain,
  AIUsagePublisher,
  FlashcastrDisplay,
  FarcasterCastEngagementPayload,
} from '@life-os/shared';
import { Counter, Gauge, createEventsPublishedCounter, createAIClient, farcasterAccounts } from '@life-os/shared';
import { farcasterEnvSchema } from '@life-os/shared';
import { validateSigner } from './signer-check.js';
import { eq, and, gte, desc } from 'drizzle-orm';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { scrapeInvaderNews } from './scraper.js';
import { seedKnowledgeBase } from './knowledge-seeder.js';
import { resolveCityName } from './city-codes.js';
import { fetchFlashcasterUsers, fetchUserFlashes } from './flashcastr-api.js';
import { pushSignal, getThresholds, buildScoreObservation, DEFAULT_THRESHOLD } from './preference-scores.js';
import { fetchAllCurated, searchOpenWeb } from './source-fetcher.js';
import { publishReadyPlans, runDailyPrepGate } from './self-publish.js';
import { buildSystemPrompt } from './persona.js';
import { NeynarAPIClient, Configuration } from '@neynar/nodejs-sdk';
import { ingestMentions, resolveOwnFid, persistMention } from './farcaster-ingest.js';
import { createWebhookServer } from './webhook-server.js';
import { processNewMentions } from './conversational-reply.js';
import { getActiveCorrections, formatCorrectionsBlock } from './corrections.js';

const PROCESS_NAME = 'agent-flashcastr';
const AGENT_DOMAIN = PROCESS_NAME.replace('agent-', '');
const __dirname = dirname(fileURLToPath(import.meta.url));

const env = validateEnv(farcasterEnvSchema);

let eventsPublished: Counter;
let eventsScraped: Counter;
let contentResponses: Counter;
let mentionsIngested: Counter;
let repliesSent: Counter;
let likesSent: Counter;
let webhookReceived: Counter;
let webhookRejected: Counter;
let signerValid: Gauge;

// Neynar read client (story 02 ingest). Reuses NEYNAR_API_KEY already
// required by dispatch-cast.ts — no new env. Constructed once in onStart.
const neynar = new NeynarAPIClient(new Configuration({ apiKey: env.NEYNAR_API_KEY }));

// @flashcastr's own FID, resolved once from farcaster_accounts on first tick
// (the account row is seeded out-of-band; null until present).
let ownFid: number | null = null;

// ─── Scrape + Store ──────────────────────────────────────────

async function scrapeAndStore(ctx: ProcessContext): Promise<number> {
  const events = await scrapeInvaderNews();
  let newCount = 0;

  for (const event of events) {
    const result = await ctx.agentDb!
      .insert(flashcastrInvaderEvents)
      .values({
        invaderId: event.invaderId,
        city: event.city,
        eventType: event.eventType,
        eventDate: event.eventDate,
        rawText: event.rawText,
        sourceUrl: 'https://www.invader-spotter.art/news.php',
      })
      .onConflictDoNothing()
      .returning({ id: flashcastrInvaderEvents.id });

    if (result.length > 0) {
      newCount++;

      // Publish CONTENT_READY for display-sync
      await ctx.publisher.publish(createLifeEvent<ContentReadyPayload<FlashcastrDisplay>>({
        routingKey: ROUTING_KEYS.CONTENT_READY_FLASHCASTR,
        source: PROCESS_NAME,
        payload: {
          domain: AGENT_DOMAIN as ContentDomain,
          action: 'create',
          entityId: result[0].id,
          forDate: event.eventDate,
          display: {
            invaderId: event.invaderId,
            city: resolveCityName(event.city),
            eventType: event.eventType,
          },
          fullDetailAvailable: false,
        },
      }));
      eventsPublished?.inc({ routing_key: ROUTING_KEYS.CONTENT_READY_FLASHCASTR });
    }
  }

  return newCount;
}

// ─── Content Generation (responds to requests) ──────────────

const INVADER_ID_PATTERN = /\b[A-Z]{2,6}_\d+\b/g;

const ALL_CONTENT_TYPES = ['destruction', 'reactivation', 'addition', 'city_spotlight', 'milestone'] as const;

/** Format the learned per-contentType thresholds for prompt injection. */
function buildThresholdBlock(thresholds: Map<string, number>): string {
  return ALL_CONTENT_TYPES
    .map((type) => `- ${type}: ${(thresholds.get(type) ?? DEFAULT_THRESHOLD).toFixed(2)}`)
    .join('\n');
}

function validateSuggestion(
  suggestion: FlashcastrAISuggestion,
  validIds: Set<string>,
): boolean {
  const mentionedIds = [...suggestion.text.matchAll(INVADER_ID_PATTERN)].map((m) => m[0]);
  const claimedIds = Array.isArray(suggestion.source_invader_ids) ? suggestion.source_invader_ids : [];

  for (const id of [...mentionedIds, ...claimedIds]) {
    if (!validIds.has(id)) {
      console.warn(`[agent-flashcastr] Rejected hallucinated suggestion — unknown ID "${id}" in: "${suggestion.text}"`);
      return false;
    }
  }
  return true;
}

interface FlashcastrAISuggestion {
  text: string;
  confidence: number;
  content_type: string;
  source_invader_ids: string[];
  source_url?: string;
}

async function generateSuggestions(
  ctx: ProcessContext,
  maxSuggestions: number,
): Promise<FlashcastrContentSuggestion[]> {
  const agentDb = ctx.agentDb!;
  const today = getUserToday(ctx.timezone);

  // Load learned confidence thresholds — falls back to DEFAULT_THRESHOLD per type when data sparse
  const learnedThresholds = await getThresholds(agentDb);

  // Learned public corrections (story 04) — injected so suggestion-gen never
  // repeats a fact the community already corrected.
  const correctionsBlock = formatCorrectionsBlock(await getActiveCorrections(agentDb));

  // Load recent events not yet used for casts
  const recentEvents = await agentDb
    .select()
    .from(flashcastrInvaderEvents)
    .where(and(
      eq(flashcastrInvaderEvents.castGenerated, false),
      gte(flashcastrInvaderEvents.eventDate, getDateDaysAgo(today, 14)),
    ))
    .orderBy(desc(flashcastrInvaderEvents.eventDate))
    .limit(50);

  if (recentEvents.length === 0) return [];

  // Load learned context from OV
  let agentCtx = await loadAgentContext(AGENT_DOMAIN);
  let cityActivity = agentCtx.learned['city-activity.md'] ?? '';
  let artistContext = agentCtx.learned['artist-context.md'] ?? '';
  let communityCulture = agentCtx.learned['community-culture.md'] ?? '';
  let globalMap = agentCtx.learned['global-map.md'] ?? '';

  // If deep knowledge is missing, seed it now rather than waiting for Sunday
  if (!artistContext && !communityCulture && !globalMap) {
    console.warn('[agent-flashcastr] No deep knowledge in OV — seeding knowledge base before generating');
    try {
      await seedKnowledgeBase(null, ctx.ai!, '');
      agentCtx = await loadAgentContext(AGENT_DOMAIN);
      artistContext = agentCtx.learned['artist-context.md'] ?? '';
      communityCulture = agentCtx.learned['community-culture.md'] ?? '';
      globalMap = agentCtx.learned['global-map.md'] ?? '';
    } catch (err) {
      console.error('[agent-flashcastr] Knowledge seed failed:', (err as Error).message);
    }
  }

  // Group events by type
  const byType: Record<string, typeof recentEvents> = {};
  for (const e of recentEvents) {
    const list = byType[e.eventType] ?? [];
    list.push(e);
    byType[e.eventType] = list;
  }

  const validIds = new Set(recentEvents.map((e) => e.invaderId));
  const validIdList = [...validIds].join(', ');

  const eventSummary = Object.entries(byType)
    .map(([type, events]) => {
      const details = events.map((e) => `${e.invaderId} in ${resolveCityName(e.city)} (${e.eventDate})`).join(', ');
      return `${type}: ${details}`;
    })
    .join('\n');

  try {
    const parsed = await ctx.ai!.completeJson<{ suggestions: FlashcastrAISuggestion[] }>({
      task: 'generate',
      taskName: 'generate_flashcastr_suggestions',
      maxTokens: 1024,
      cacheSystem: true,
      system: buildSystemPrompt(`${correctionsBlock ? `${correctionsBlock.trimEnd()}\n\n` : ''}Your job: provide verified content suggestions when asked.

When background knowledge is available (artist context, community culture, global map), use it to add depth and significance to your suggestions. Explain WHY an event matters — was it a notable piece? Part of a wave? In a culturally significant location?

ANTI-HALLUCINATION (non-negotiable — validated post-generation):
- The ONLY invader IDs you may write are those in the VALID INVADER IDS list at the top of the event data. Any other ID will be rejected automatically.
- NEVER state installation dates, historical ages, or status claims unless explicitly present in the event data.
- NEVER use phrases like "spotted in the wild", "confirmed active", "still going strong", or anything implying a live sighting. You only know what the event feed tells you.
- If event data is empty, return {"suggestions": []}.

OTHER RULES:
- NEVER include @mentions. Only reference invader IDs (e.g., PA_1099) and city names.
- Destructions are sad. Reactivations are exciting. New installs are celebrations.

PRIORITIZE by newsworthiness:
1. Destructions of notable invaders (breaking news)
2. New installations (fresh content)
3. Reactivations (comeback stories)
4. City activity trends (aggregated data)
5. Milestones (count thresholds)

${artistContext ? `## Artist Background\n${artistContext}\n` : ''}
${communityCulture ? `## Community Culture\n${communityCulture}\n` : ''}
${globalMap ? `## Global Map Overview\n${globalMap}\n` : ''}
${cityActivity ? `## Recent City Activity Patterns\n${cityActivity}\n` : ''}

CONFIDENCE SCORING:
- 1.0 = directly backed by a specific event with an invader ID
- 0.7-0.9 = aggregation of multiple events (city trends)
- Below 0.7 = too speculative, don't generate

ADAPTIVE CONFIDENCE THRESHOLDS (learned from accepted suggestions):
${buildThresholdBlock(learnedThresholds)}
Below the threshold for a content type = too speculative, don't generate that type.

Respond with ONLY valid JSON, no markdown:
{"suggestions": [{"text": "cast text", "confidence": 0.95, "content_type": "destruction|reactivation|addition|city_spotlight|milestone", "source_invader_ids": ["PA_1099"], "source_url": "https://www.invader-spotter.art/news.php"}]}`),
      messages: [{
        role: 'user',
        content: `VALID INVADER IDS: ${validIdList}\n\nRecent unposted invader events:\n\n${eventSummary}\n\nProvide your best content suggestions. Quality over quantity.`,
      }],
    }, { wrapKey: 'suggestions' });

    const raw = parsed.suggestions ?? [];
    const validated = raw.filter((c) => validateSuggestion(c, validIds));
    if (validated.length < raw.length) {
      console.warn(`[agent-flashcastr] Filtered ${raw.length - validated.length} hallucinated suggestion(s)`);
    }

    return validated.map((c) => ({
      text: String(c.text ?? ''),
      confidence: Number(c.confidence ?? 0),
      contentType: String(c.content_type ?? 'unknown'),
      sourceInvaderIds: Array.isArray(c.source_invader_ids) ? c.source_invader_ids : [],
      sourceUrl: c.source_url ?? 'https://www.invader-spotter.art/news.php',
    }));
  } catch (err) {
    console.error('[agent-flashcastr] AI suggestion generation failed:', err);
    return [];
  }
}

/** Mark specific invader events as used — called when agent-farcaster confirms a cast was published */
async function markEventsUsed(ctx: ProcessContext, invaderIds: string[], eventDate: string): Promise<void> {
  for (const invaderId of invaderIds) {
    await ctx.agentDb!
      .update(flashcastrInvaderEvents)
      .set({ castGenerated: true })
      .where(and(
        eq(flashcastrInvaderEvents.invaderId, invaderId),
        eq(flashcastrInvaderEvents.castGenerated, false),
        gte(flashcastrInvaderEvents.eventDate, getDateDaysAgo(eventDate, 14)),
      ));
  }
}

// ─── Refinement ──────────────────────────────────────────────

async function runRefinementTasks(ctx: ProcessContext): Promise<void> {
  const agentDb = ctx.agentDb!;
  const today = getUserToday(ctx.timezone);

  // 1. Scrape latest invader news (once per day — site updates daily, not hourly)
  const alreadyScraped = await getDailyFlag(agentDb, PROCESS_NAME, 'scraped', ctx.timezone);
  if (!alreadyScraped) {
    console.log('[agent-flashcastr] Scraping invader-spotter.art...');
    const newEvents = await scrapeAndStore(ctx);
    eventsScraped?.inc(newEvents);
    await setDailyFlag(agentDb, PROCESS_NAME, 'scraped', ctx.timezone);
    console.log(`[agent-flashcastr] Scraped ${newEvents} new events`);
  }

  // 2. Summarize city activity from all stored events (agent DB)
  const allEvents = await agentDb
    .select()
    .from(flashcastrInvaderEvents)
    .orderBy(desc(flashcastrInvaderEvents.eventDate))
    .limit(200);

  if (allEvents.length === 0) {
    console.log('[agent-flashcastr] No events to refine');
    return;
  }

  // 3. AI summarization into knowledge observations
  const eventsByCity: Record<string, number> = {};
  const eventsByType: Record<string, number> = {};
  for (const e of allEvents) {
    const cityName = resolveCityName(e.city);
    eventsByCity[cityName] = (eventsByCity[cityName] ?? 0) + 1;
    eventsByType[e.eventType] = (eventsByType[e.eventType] ?? 0) + 1;
  }

  const cityActivityResult = await ctx.ai!.complete({
    task: 'summarize',
    taskName: 'refine_city_activity',
    maxTokens: 512,
    cacheSystem: true,
    system: `Summarize Space Invader mosaic activity by city. Note which cities have the most destructions (concerning), reactivations (exciting), and new installations (growing). Highlight trends. Be concise — this feeds into a content agent's knowledge base.`,
    messages: [{
      role: 'user',
      content: `Event counts by city: ${JSON.stringify(eventsByCity)}\nEvent counts by type: ${JSON.stringify(eventsByType)}\n\nRecent notable events:\n${allEvents.slice(0, 30).map((e) => `${e.eventDate}: ${e.eventType} — ${e.invaderId} (${resolveCityName(e.city)})`).join('\n')}`,
    }],
  });

  await writeAgentObservation(null, AGENT_DOMAIN, 'city-activity.md', cityActivityResult.text);

  // 4. Knowledge seeding — first run (empty OV) or weekly refresh (Sundays)
  const agentCtxForSeed = await loadAgentContext(AGENT_DOMAIN);
  const hasDeepKnowledge = !!(agentCtxForSeed.learned['artist-context.md']);
  const [yr, mo, dy] = today.split('-').map(Number);
  const dayOfWeek = new Date(Date.UTC(yr!, mo! - 1, dy!)).getUTCDay();
  if (!hasDeepKnowledge || dayOfWeek === 0) {
    const agentDbForSync = ctx.agentDb!;
    const knowledgeSeeded = await getDailyFlag(agentDbForSync, PROCESS_NAME, 'knowledge_seeded', ctx.timezone);
    if (!knowledgeSeeded && ctx.ai) {
      try {
        const cityStats = Object.entries(eventsByCity)
          .sort((a, b) => b[1] - a[1])
          .map(([city, count]) => `${city}: ${count} events`)
          .join('\n');
        await seedKnowledgeBase(null, ctx.ai, cityStats);
        await setDailyFlag(agentDbForSync, PROCESS_NAME, 'knowledge_seeded', ctx.timezone);
      } catch (err) {
        console.error('[agent-flashcastr] Knowledge seeding failed:', err);
      }
    }
  }

  // 5. Write per-contentType preference score summary to OV
  try {
    const scoreObservation = await buildScoreObservation(agentDb);
    await writeAgentObservation(null, AGENT_DOMAIN, 'suggestion-patterns.md', scoreObservation);
  } catch (err) {
    console.error('[agent-flashcastr] Failed to write suggestion-patterns observation:', (err as Error).message);
  }

  console.log('[agent-flashcastr] Refinement complete — knowledge base updated');
}

// ─── Daily Highlight (responds to agent-farcaster requests) ─────────────────

const FLASHCASTR_API_URL = process.env.FLASHCASTR_API_URL;

async function handleHighlightRequest(event: LifeEvent, ctx: ProcessContext): Promise<void> {
  const payload = event.payload as FlashcastrHighlightRequestPayload;

  if (!FLASHCASTR_API_URL) {
    console.warn('[agent-flashcastr] FLASHCASTR_API_URL not set — skipping highlight request');
    return;
  }

  const lastHighlighted = await getSyncToken(ctx.agentDb!, `${PROCESS_NAME}:flashcastr_last_highlighted`);

  const users = await fetchFlashcasterUsers(FLASHCASTR_API_URL);
  if (users.length === 0) {
    console.warn('[agent-flashcastr] Highlight request: no users found in flashcastr API');
    return;
  }

  const eligible = users.length > 1 ? users.filter((u) => u.username !== lastHighlighted) : users;
  const shuffled = eligible.sort(() => Math.random() - 0.5);

  for (const candidate of shuffled) {
    const flashes = await fetchUserFlashes(FLASHCASTR_API_URL, candidate.username);
    const castedFlashes = flashes.filter((f) => f.farcaster_user?.cast_hash);
    if (castedFlashes.length === 0) continue;

    const flash = castedFlashes[Math.floor(Math.random() * castedFlashes.length)];
    await updateSyncToken(ctx.agentDb!, `${PROCESS_NAME}:flashcastr_last_highlighted`, candidate.username);

    await ctx.publisher.publish(createLifeEvent<FlashcastrHighlightResponsePayload>({
      routingKey: ROUTING_KEYS.FLASHCASTR_HIGHLIGHT_RESPONSE,
      source: PROCESS_NAME,
      payload: {
        requestId: payload.requestId,
        user: { fid: candidate.fid, username: candidate.username },
        flash: { castHash: flash.farcaster_user!.cast_hash!, fid: flash.farcaster_user!.fid },
      },
    }));

    console.log(`[agent-flashcastr] Highlight response: @${candidate.username} — flash in ${flash.city}`);
    return;
  }

  console.warn('[agent-flashcastr] Highlight request: no eligible users with casted flashes');
}

// ─── Roundup Data (responds to agent-blog requests) ─────────

const ROUNDUP_SOURCE_SUMMARY_CHARS = 600;

const EMPTY_STATS: FlashcastrStats = { topHunters: [], topCities: [], totalFlashes: 0 };

async function handleRoundupRequest(event: LifeEvent, ctx: ProcessContext): Promise<void> {
  const payload = event.payload as FlashcastrRoundupRequestPayload;
  const agentDb = ctx.agentDb!;
  const today = getUserToday(ctx.timezone);

  console.log(`[agent-flashcastr] Roundup request: ${payload.periodDays} days ending ${payload.forDate}`);

  // 1. Pull invader events from the period
  const sinceDate = getDateDaysAgo(today, payload.periodDays);
  const recentEvents = await agentDb
    .select()
    .from(flashcastrInvaderEvents)
    .where(gte(flashcastrInvaderEvents.eventDate, sinceDate))
    .orderBy(desc(flashcastrInvaderEvents.eventDate))
    .limit(200);

  const events: FlashcastrRoundupEvent[] = recentEvents.map((e) => ({
    invaderId: e.invaderId,
    city: resolveCityName(e.city),
    eventType: e.eventType,
    eventDate: e.eventDate,
    rawText: e.rawText ?? '',
  }));

  // 2. Pull external news (HEN-583 — auth-gated awazleon scrape lives here)
  const externalNewsRows = await agentDb
    .select()
    .from(flashcastrExternalNews)
    .where(gte(flashcastrExternalNews.scrapedAt, daysAgoTimestamp(payload.periodDays)))
    .orderBy(desc(flashcastrExternalNews.scrapedAt))
    .limit(50);

  const externalNews = externalNewsRows.map((n) => ({
    source: n.source,
    url: n.url,
    title: n.title,
    body: n.body,
    publishedAt: n.publishedAt,
  }));

  // 3-5. Independent I/O — fan out so the slowest leg gates total latency.
  // Each one is best-effort; a single failure must not abort the roundup.
  const [sourceFetched, discovered, flashcastrStats] = await Promise.all([
    fetchAllCurated(agentDb).catch((err) => {
      console.warn('[agent-flashcastr] Roundup: source fetch failed:', (err as Error).message);
      return [];
    }),
    ctx.ai
      ? searchOpenWeb(ctx.ai, 'Space Invader street art news this week', 10, agentDb).catch((err) => {
          console.warn('[agent-flashcastr] Roundup: open-web search failed:', (err as Error).message);
          return [];
        })
      : Promise.resolve([]),
    safeComputeFlashcastrStats(payload.periodDays),
  ]);

  const sourceDeltas = sourceFetched
    .filter((s) => s.changed)
    .map((s) => ({
      url: s.url,
      label: s.label,
      summary: s.rawText.slice(0, ROUNDUP_SOURCE_SUMMARY_CHARS),
    }));

  // 6. Load deep knowledge from OV
  const agentCtx = await loadAgentContext(AGENT_DOMAIN);
  const knowledge = {
    artistContext: agentCtx.learned['artist-context.md'] ?? '',
    communityCulture: agentCtx.learned['community-culture.md'] ?? '',
    globalMap: agentCtx.learned['global-map.md'] ?? '',
  };

  // Legacy free-form headline list — populate from external news + discovered
  // URL snippets so older blog code still receives something useful.
  const recentNews = [
    ...externalNews.slice(0, 5).map((n) => `${n.title} — ${n.body.slice(0, 100)}`),
    ...discovered.slice(0, 5).map((d) => d.snippet),
  ].slice(0, 10);

  await ctx.publisher.publish(createLifeEvent<FlashcastrRoundupResponsePayload>({
    routingKey: ROUTING_KEYS.FLASHCASTR_ROUNDUP_RESPONSE,
    source: PROCESS_NAME,
    payload: {
      requestId: payload.requestId,
      events,
      knowledge,
      sourceDeltas,
      externalNews,
      flashcastrStats,
      discoveredUrls: discovered.map((d) => d.url),
      recentNews,
    },
  }));

  eventsPublished?.inc({ routing_key: ROUTING_KEYS.FLASHCASTR_ROUNDUP_RESPONSE });
  console.log(
    `[agent-flashcastr] Roundup response sent: ${events.length} events, ${externalNews.length} external news, ${sourceDeltas.length} source deltas, ${discovered.length} discovered URLs, ${flashcastrStats.totalFlashes} flashes`,
  );
}

/**
 * Aggregate the flashcastr GraphQL API into period-scoped stats. Per-user
 * fetches fan out via Promise.allSettled — one slow user can't gate the
 * others. Returns EMPTY_STATS if the API URL is unset or the call fails.
 */
async function safeComputeFlashcastrStats(periodDays: number): Promise<FlashcastrStats> {
  const apiUrl = process.env.FLASHCASTR_API_URL;
  if (!apiUrl) return EMPTY_STATS;

  try {
    const users = await fetchFlashcasterUsers(apiUrl);
    if (users.length === 0) return EMPTY_STATS;

    const cutoffMs = Date.now() - periodDays * 86_400_000;
    const settled = await Promise.allSettled(
      users.map(async (u) => ({ username: u.username, flashes: await fetchUserFlashes(apiUrl, u.username) })),
    );

    const hunterCounts = new Map<string, number>();
    const cityCounts = new Map<string, number>();
    let totalFlashes = 0;

    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      const { username, flashes } = result.value;
      for (const flash of flashes) {
        if (Date.parse(flash.timestamp) < cutoffMs) continue;
        totalFlashes++;
        hunterCounts.set(username, (hunterCounts.get(username) ?? 0) + 1);
        if (flash.city) cityCounts.set(flash.city, (cityCounts.get(flash.city) ?? 0) + 1);
      }
    }

    return {
      totalFlashes,
      topHunters: rankTop(hunterCounts).map(([username, flashCount]) => ({ username, flashCount })),
      topCities: rankTop(cityCounts).map(([city, count]) => ({ city: resolveCityName(city), count })),
    };
  } catch (err) {
    console.warn('[agent-flashcastr] Roundup: flashcastr stats fetch failed:', (err as Error).message);
    return EMPTY_STATS;
  }
}

function rankTop(counts: Map<string, number>, limit = 5): [string, number][] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function daysAgoTimestamp(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Resolve @flashcastr's own FID once and cache it in the module-level
 * `ownFid`. Shared by the poll tick and the webhook receiver so a
 * self-authored cast is never ingested as inbound (no self-reply loop).
 * Returns null until the farcaster_accounts row is seeded.
 */
async function ensureOwnFid(ctx: ProcessContext): Promise<number | null> {
  if (ownFid === null) {
    const account = await resolveOwnFid(ctx);
    if (account) ownFid = account.fid;
  }
  return ownFid;
}

function getDateDaysAgo(today: string, days: number): string {
  const d = new Date(today + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split('T')[0];
}

// ─── Engine ──────────────────────────────────────────────────

createProcess({
  name: PROCESS_NAME,
  // Standalone in flashcastr.services: no RabbitMQ. All publish/subscribe
  // (CONTENT_READY, content/highlight/roundup requests+responses, engagement,
  // admin triggers, reconcile) is inert — the reply loop + OV context remain.
  standalone: true,
  agentMeta: { kind: 'agent', domain: 'flashcastr', role: 'Scrapes Space Invader street art news and generates domain-expert content suggestions for Farcaster.' },

  agentDb: {
    migrationsFolder: resolve(__dirname, '../drizzle-agent'),
  },
  reconcile: {
    sources: ['flashcastr_invader_events'],
    run: async (ctx, emit) => {
      const agentDb = ctx.agentDb!;
      const cutoff = getDateDaysAgo(getUserToday(ctx.timezone), 14);
      const rows = await agentDb.select().from(flashcastrInvaderEvents).where(gte(flashcastrInvaderEvents.eventDate, cutoff)).orderBy(desc(flashcastrInvaderEvents.eventDate));
      for (const e of rows) {
        await emit(ROUTING_KEYS.CONTENT_READY_FLASHCASTR, {
          domain: 'flashcastr',
          action: 'update',
          entityId: e.id,
          forDate: e.eventDate,
          display: {
            invaderId: e.invaderId,
            city: resolveCityName(e.city),
            eventType: e.eventType,
          },
          fullDetailAvailable: false,
        });
      }
    },
  },
  onBackfill: async (ctx) => {
    const agentDb = ctx.agentDb!;
    const cutoff = getDateDaysAgo(getUserToday(ctx.timezone), 14); // 14-day retention

    const rows = await agentDb
      .select()
      .from(flashcastrInvaderEvents)
      .where(gte(flashcastrInvaderEvents.eventDate, cutoff))
      .orderBy(desc(flashcastrInvaderEvents.eventDate));

    return rows.map((e) => ({
      domain: 'flashcastr' as const,
      action: 'create' as const,
      entityId: e.id,
      forDate: e.eventDate,
      display: {
        invaderId: e.invaderId,
        city: resolveCityName(e.city),
        eventType: e.eventType,
      },
      fullDetailAvailable: false,
    }));
  },

  subscriptions: [
    // Respond to content requests from agent-farcaster
    {
      queueName: 'agent-flashcastr.content-request',
      patterns: [ROUTING_KEYS.FLASHCASTR_CONTENT_REQUEST],
      handler: async (event: LifeEvent, ctx: ProcessContext) => {
        const payload = event.payload as FlashcastrContentRequestPayload;
        console.log(`[agent-flashcastr] Content request received (max ${payload.maxSuggestions} suggestions)`);

        const suggestions = await generateSuggestions(ctx, payload.maxSuggestions);

        // Don't mark events as used here — agent-farcaster will confirm
        // which suggestions it actually published, then we mark them used.

        await ctx.publisher.publish(createLifeEvent<FlashcastrContentResponsePayload>({
          routingKey: ROUTING_KEYS.FLASHCASTR_CONTENT_RESPONSE,
          source: PROCESS_NAME,
          payload: {
            requestId: payload.requestId,
            suggestions,
          },
        }));

        eventsPublished?.inc({ routing_key: ROUTING_KEYS.FLASHCASTR_CONTENT_RESPONSE });
        contentResponses?.inc();
        console.log(`[agent-flashcastr] Responded with ${suggestions.length} suggestions (${suggestions.filter((s) => s.confidence >= 0.8).length} high confidence)`);
      },
    },

    // Respond to highlight requests from agent-farcaster
    {
      queueName: 'agent-flashcastr.highlight-request',
      patterns: [ROUTING_KEYS.FLASHCASTR_HIGHLIGHT_REQUEST],
      handler: handleHighlightRequest,
    },

    // Respond to roundup requests from agent-blog (weekly newsletter data)
    {
      queueName: 'agent-flashcastr.roundup-request',
      patterns: [ROUTING_KEYS.FLASHCASTR_ROUNDUP_REQUEST],
      handler: handleRoundupRequest,
    },

    // Agent-farcaster confirms it published a suggestion — mark events as used + ingest pick signals
    {
      queueName: 'agent-flashcastr.content-accepted',
      patterns: [ROUTING_KEYS.FLASHCASTR_CONTENT_ACCEPTED],
      handler: async (event: LifeEvent, ctx: ProcessContext) => {
        const payload = event.payload as FlashcastrContentAcceptedPayload;
        const agentDb = ctx.agentDb!;

        await markEventsUsed(ctx, payload.sourceInvaderIds, payload.forDate);

        if (payload.acceptedSuggestions && payload.acceptedSuggestions.length > 0) {
          // Signals are independent — push in parallel
          await Promise.all(
            payload.acceptedSuggestions.map((s) =>
              pushSignal(agentDb, { contentType: s.contentType, city: s.city }, 1.0),
            ),
          );
          console.log(`[agent-flashcastr] Marked ${payload.sourceInvaderIds.length} events used; ingested ${payload.acceptedSuggestions.length} pick signal(s)`);
        } else {
          console.log(`[agent-flashcastr] Marked ${payload.sourceInvaderIds.length} events as used`);
        }
      },
    },

    // Stub subscription: agent-farcaster will emit engagement signals in PR2
    {
      queueName: 'agent-flashcastr.cast-engagement',
      patterns: [ROUTING_KEYS.FARCASTER_CAST_ENGAGEMENT],
      handler: async (event: LifeEvent, ctx: ProcessContext) => {
        const payload = event.payload as FarcasterCastEngagementPayload;
        if (!payload.sourceContentType) return;

        // Recasts weighted 2x — they signal active endorsement, not just passive appreciation
        const rawSignal = (payload.reactions + payload.recasts * 2 + payload.replies) / 10;
        const signal = Math.min(1, Math.max(0, rawSignal));

        await pushSignal(ctx.agentDb!, { contentType: payload.sourceContentType }, signal);
        console.log(`[agent-flashcastr] Engagement signal for ${payload.sourceContentType}: ${signal.toFixed(3)} (reactions=${payload.reactions}, recasts=${payload.recasts}, replies=${payload.replies})`);
      },
    },

    // Admin trigger: force refinement
    {
      queueName: 'agent-flashcastr.admin-refinement',
      patterns: [ROUTING_KEYS.ADMIN_TRIGGER_REFINEMENT],
      handler: async (event: LifeEvent, ctx) => {
        const payload = event.payload as { agent: string | null };
        if (payload.agent && payload.agent !== AGENT_DOMAIN) return;
        console.log('[agent-flashcastr] Admin-triggered refinement');
        try {
          await runRefinementTasks(ctx);
        } catch (err) {
          console.error(`[agent-flashcastr] Admin refinement FAILED:`, err);
        }
      },
    },

    // Admin trigger: force scrape + respond with content preview
    {
      queueName: 'agent-flashcastr.admin-trigger',
      patterns: [ROUTING_KEYS.ADMIN_TRIGGER_FLASHCASTR],
      handler: async (_event, ctx) => {
        console.log('[agent-flashcastr] Admin trigger — scraping + generating preview');
        await scrapeAndStore(ctx);
        const suggestions = await generateSuggestions(ctx, 5);
        for (const s of suggestions) {
          console.log(`  [${s.contentType}] (${s.confidence}) ${s.text}`);
        }
      },
    },
  ],

  onStart: async (ctx: ProcessContext) => {
    const r = ctx.registry;
    eventsPublished = createEventsPublishedCounter(r);
    eventsScraped = new Counter({ name: 'flashcastr_events_scraped_total', help: 'Events scraped from invader-spotter.art', registers: [r] });
    contentResponses = new Counter({ name: 'flashcastr_content_responses_total', help: 'Content responses sent to agent-farcaster', registers: [r] });
    mentionsIngested = new Counter({ name: 'flashcastr_mentions_ingested_total', help: 'Inbound Farcaster mentions/replies persisted (story 02 ingest)', registers: [r] });
    repliesSent = new Counter({ name: 'flashcastr_replies_sent_total', help: 'In-character conversational replies dispatched (story 03)', registers: [r] });
    likesSent = new Counter({ name: 'flashcastr_likes_sent_total', help: 'Visible "seen you" LIKEs submitted on inbound casts after a successful reply', registers: [r] });
    webhookReceived = new Counter({ name: 'flashcastr_webhook_received_total', help: 'Neynar cast.created webhooks accepted (valid signature, persisted)', registers: [r] });
    webhookRejected = new Counter({ name: 'flashcastr_webhook_rejected_total', help: 'Neynar webhook requests rejected (missing/invalid X-Neynar-Signature)', registers: [r] });
    ctx.ai = createAIClient({ registry: r, usagePublisher: ctx.publisher as AIUsagePublisher, source: PROCESS_NAME });

    // Boot signer-validity check. Catches a FARCASTER_ENCRYPTION_KEY that can't
    // decrypt the stored signer (common after migrating the account row to a new
    // deploy) before it silently breaks every reply/like at publish time.
    signerValid = new Gauge({ name: 'flashcastr_signer_valid', help: '1 if the @flashcastr signer decrypts and derives a valid Ed25519 key', registers: [r] });
    const [signerAccount] = await ctx.agentDb!
      .select()
      .from(farcasterAccounts)
      .where(eq(farcasterAccounts.handle, AGENT_DOMAIN))
      .limit(1);
    if (!signerAccount) {
      signerValid.set(0);
      console.warn(`[${PROCESS_NAME}] Signer check skipped — no farcaster_accounts row for @${AGENT_DOMAIN}`);
    } else {
      const check = await validateSigner(
        signerAccount.signerPrivateKey,
        process.env.FARCASTER_ENCRYPTION_KEY,
        signerAccount.fid,
        process.env.HUB_HTTP_URL ?? 'https://hub-api.neynar.com',
      );
      signerValid.set(check.ok ? 1 : 0);
      if (!check.ok) {
        console.error(`[${PROCESS_NAME}] SIGNER CHECK FAILED — cannot cast/reply/like: ${check.reason}`);
      } else if (check.activeOnHub === false) {
        console.warn(`[${PROCESS_NAME}] Signer decrypts OK (${check.publicKeyHex}) but is NOT among active on-chain signers for FID ${signerAccount.fid} — casts will be rejected by the network`);
      } else {
        console.log(`[${PROCESS_NAME}] Signer OK (${check.publicKeyHex})${check.activeOnHub ? ' — active on Hub' : ''}`);
      }
    }
  },

  // Real-time inbound: a Neynar webhook pushes cast.created here so a reply
  // lands in seconds instead of waiting up to a poll cycle. Strictly additive
  // to the 15-min poll, which stays as the silent fallback/reconcile path —
  // both write flashcastr_mentions and dedup on the cast_hash PK, so a
  // webhook+poll double-delivery is replied/liked exactly once. If
  // NEYNAR_WEBHOOK_SECRET is unset (or the server can't bind), setupPush
  // returns void and base.ts logs "falling back to polling only" — no crash.
  setupPush: env.NEYNAR_WEBHOOK_SECRET
    ? async (triggerTick, ctx) => {
        const secret = env.NEYNAR_WEBHOOK_SECRET!;
        const port = parseInt(process.env.PORT ?? '8080', 10);

        const { server, close } = createWebhookServer({
          secret,
          persist: async (row) => {
            // Never ingest a self-authored cast (defensive — mirrors the poll).
            const fid = await ensureOwnFid(ctx);
            if (fid !== null && row.authorFid === fid) return false;
            return persistMention(ctx.agentDb!, row, mentionsIngested);
          },
          triggerTick,
          onReceived: () => webhookReceived.inc(),
          onRejected: () => webhookRejected.inc(),
          onFirstPayload: (raw) =>
            console.log(`[agent-flashcastr] First webhook payload (field-path confirmation): ${raw.slice(0, 2000)}`),
        });

        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, () => {
            console.log(`[agent-flashcastr] Neynar webhook receiver listening on port ${port}`);
            resolve();
          });
        });

        return { close };
      }
    : undefined,

  onTick: async (ctx: ProcessContext) => {
    const agentDb = ctx.agentDb!;
    const { timezone } = ctx;
    const hour = getUserHour(timezone);

    // 3am daily scrape + knowledge-base build. Signal-driven refinement was
    // removed with Redis; admin trigger remains for on-demand runs.
    if (hour === 3) {
      const alreadyScraped = await getDailyFlag(agentDb, PROCESS_NAME, 'scraped', timezone);
      if (!alreadyScraped) {
        console.log('[agent-flashcastr] 3am refinement');
        await runRefinementTasks(ctx);
      }
    }

    // Read-only Farcaster ingest (story 02). Every tick (~15-min cadence) —
    // a short poll, NOT the daily flag: replies need timeliness. Dedup on
    // the cast_hash PK keeps re-poll idempotent. Isolated in try/catch so a
    // Neynar outage never blocks the scheduled-cast path below.
    try {
      const fid = await ensureOwnFid(ctx);
      if (fid === null) {
        console.warn('[agent-flashcastr] No farcaster_accounts row for @flashcastr — skipping ingest');
      } else {
        const { ingested } = await ingestMentions(ctx, neynar, fid, mentionsIngested);
        if (ingested > 0) console.log(`[agent-flashcastr] Ingested ${ingested} new mention(s)/reply(ies)`);
      }
    } catch (err) {
      console.error('[agent-flashcastr] Mention ingest failed:', (err as Error).message);
    }

    // Conversational reply engine (story 03). Drains status='new' mentions:
    // relevance gate → persona reply → dispatch as a reply (parentHash) →
    // per-author rate limit. Auto-publish, gated to mentions/own-cast replies only.
    // Isolated try/catch so an AI or Neynar failure can't block the
    // scheduled-cast path below.
    try {
      if (ctx.ai) {
        // Inject learned corrections so replies also respect them (story 04).
        const correctionsBlock = formatCorrectionsBlock(await getActiveCorrections(agentDb));
        const { replied, skipped } = await processNewMentions(ctx, neynar, ctx.ai, repliesSent, Date.now(), correctionsBlock, likesSent);
        if (replied > 0 || skipped > 0) {
          console.log(`[agent-flashcastr] Conversational replies: ${replied} sent, ${skipped} skipped`);
        }
      }
    } catch (err) {
      console.error('[agent-flashcastr] Conversational reply pass failed:', (err as Error).message);
    }

    // Daily plan generation (HEN-584) — runs once per user-tz day at hour ≥ 7.
    await runDailyPrepGate(ctx, hour);

    // Publish any approved plans whose scheduled time has arrived (HEN-581 — self-publish).
    await publishReadyPlans(ctx);
  },
}).catch(console.error);

