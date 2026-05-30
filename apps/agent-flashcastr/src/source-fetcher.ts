import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AgentDb, AIClient } from '@life-os/shared';
import { flashcastrSeenUrls } from '@life-os/shared';

// ─── Types ────────────────────────────────────────────────────────────────

export type SourceClassification = 'news' | 'gallery' | 'social' | 'fan' | 'unknown';

export interface CuratedSource {
  url: string;
  /** Slug identifying the source (e.g. 'mapvaders'); persisted in source_label. */
  label: string;
  classification: SourceClassification;
}

export interface FetchedSource {
  url: string;
  label: string;
  classification: SourceClassification;
  rawText: string;
  contentHash: string;
  /** True when content_hash differs from the previously stored hash, OR when this is a first-seen URL. */
  changed: boolean;
  firstSeen: boolean;
}

export interface DiscoveredUrl {
  url: string;
  snippet: string;
}

// ─── Curated source list ─────────────────────────────────────────────────

/**
 * Authoritative curated source list. Every fetcher run hits these — discovery
 * via `searchOpenWeb` augments the cache but never replaces this list.
 *
 * Awazleon is intentionally absent — it requires authenticated access (HEN-583).
 * space-invaders.com is intentionally absent — anti-scraping measures block fetches.
 */
export const CURATED_SOURCES: CuratedSource[] = [
  { url: 'https://www.myartbroker.com/artist-invader', label: 'myartbroker-invader', classification: 'gallery' },
  { url: 'https://www.myartbroker.com/artist-invader/guides/top-10-places-to-find-an-invader-original', label: 'myartbroker-guide', classification: 'gallery' },
  { url: 'https://www.instagram.com/invaderwashere/', label: 'instagram-invaderwashere', classification: 'social' },
  { url: 'https://www.mapvaders.com/', label: 'mapvaders', classification: 'fan' },
  { url: 'https://www.invader-spotter.art/news.php', label: 'invader-spotter', classification: 'news' },
  { url: 'https://invaderatlas.app/news', label: 'invaderatlas', classification: 'news' },
];

const USER_AGENT = 'LifeOS-Flashcastr/1.0 (invader content agent)';

// ─── Fetch one source ─────────────────────────────────────────────────────

/**
 * GET the source URL, sha256 the body, diff against the stored hash. Always
 * bumps `last_checked_at`. Updates `content_hash` + `last_changed_at` when the
 * body changes; inserts a fresh row on first sight.
 *
 * Throws on network/HTTP failure — the caller should use Promise.allSettled
 * (see `fetchAllCurated`) to keep one bad site from aborting the run.
 */
export async function fetchOne(source: CuratedSource, agentDb: AgentDb): Promise<FetchedSource> {
  const response = await fetch(source.url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) {
    throw new Error(`fetchOne(${source.url}): HTTP ${response.status}`);
  }

  const rawText = await response.text();
  const contentHash = sha256(rawText);

  const existing = await agentDb
    .select({
      url: flashcastrSeenUrls.url,
      contentHash: flashcastrSeenUrls.contentHash,
    })
    .from(flashcastrSeenUrls)
    .where(eq(flashcastrSeenUrls.url, source.url))
    .limit(1);

  const now = new Date();
  const firstSeen = existing.length === 0;
  const changed = firstSeen || existing[0]!.contentHash !== contentHash;

  if (firstSeen) {
    await agentDb.insert(flashcastrSeenUrls).values({
      url: source.url,
      sourceLabel: source.label,
      classification: source.classification,
      firstSeenAt: now,
      lastCheckedAt: now,
      lastChangedAt: now,
      contentHash,
    });
  } else {
    // Always bump last_checked_at; on change, also refresh hash + last_changed_at.
    const patch = changed
      ? { lastCheckedAt: now, lastChangedAt: now, contentHash }
      : { lastCheckedAt: now };
    await agentDb
      .update(flashcastrSeenUrls)
      .set(patch)
      .where(eq(flashcastrSeenUrls.url, source.url));
  }

  return {
    url: source.url,
    label: source.label,
    classification: source.classification,
    rawText,
    contentHash,
    changed,
    firstSeen,
  };
}

// ─── Fetch all curated sources ────────────────────────────────────────────

/**
 * Fan out across the curated list in parallel. One site failing must not abort
 * the others — Promise.allSettled, log + skip rejections, return successes.
 */
export async function fetchAllCurated(agentDb: AgentDb): Promise<FetchedSource[]> {
  const results = await Promise.allSettled(
    CURATED_SOURCES.map((source) => fetchOne(source, agentDb)),
  );

  const fetched: FetchedSource[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === 'fulfilled') {
      fetched.push(result.value);
    } else {
      console.warn(`[source-fetcher] ${CURATED_SOURCES[i]!.url} failed:`, (result.reason as Error).message);
    }
  }
  return fetched;
}

// ─── Open-web search via Claude web_search tool ───────────────────────────

const URL_LINE_PATTERN = /^URL:\s*(\S+?)\s*\|\s*SNIPPET:\s*(.+)$/;

/**
 * Use Claude's web_search tool to surface URLs for an arbitrary query. Each
 * surfaced URL is registered in `flashcastr_seen_urls` with source_label
 * 'discovered' + classification 'unknown' so we don't re-summarize the same
 * link next week. Existing rows are left untouched (manual promotion later).
 *
 * The model is constrained to emit one line per result in the form
 * `URL: <url> | SNIPPET: <snippet>` — keeps parsing trivial and avoids the
 * model burying URLs in prose.
 */
export async function searchOpenWeb(
  ai: AIClient,
  query: string,
  maxUses: number,
  agentDb: AgentDb,
): Promise<DiscoveredUrl[]> {
  const result = await ai.complete({
    task: 'search',
    taskName: 'flashcastr_open_web_search',
    maxTokens: 2048,
    tools: [{
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: maxUses,
      allowed_callers: ['direct'],
    }],
    cacheSystem: true,
    system: `You are a research assistant searching the open web. Use the web_search tool to find pages matching the user's query. After searching, output ONLY one line per result in this exact format:

URL: <full-url> | SNIPPET: <one-sentence summary, max 200 chars>

No prose, no headers, no analysis. One line per URL.`,
    messages: [{ role: 'user', content: query }],
  });

  const discovered = parseDiscoveredUrls(result.text);
  await registerDiscoveredUrls(discovered, agentDb);
  return discovered;
}

// ─── Internal ─────────────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function parseDiscoveredUrls(text: string): DiscoveredUrl[] {
  const out: DiscoveredUrl[] = [];
  for (const line of text.split('\n')) {
    const match = line.trim().match(URL_LINE_PATTERN);
    if (!match) continue;
    const url = match[1]!;
    const snippet = match[2]!.trim();
    if (!url.startsWith('http')) continue;
    out.push({ url, snippet });
  }
  return out;
}

/**
 * Insert each discovered URL with source_label='discovered'. We deliberately
 * don't update existing rows from search results — curated entries keep their
 * canonical label, and prior 'discovered' rows already have a first_seen_at
 * we want to preserve.
 */
async function registerDiscoveredUrls(discovered: DiscoveredUrl[], agentDb: AgentDb): Promise<void> {
  if (discovered.length === 0) return;

  const now = new Date();
  const rows = discovered.map(({ url, snippet }) => ({
    url,
    sourceLabel: 'discovered',
    classification: 'unknown',
    firstSeenAt: now,
    lastCheckedAt: now,
    lastChangedAt: now,
    contentHash: null,
    lastSummary: snippet,
  }));
  await agentDb.insert(flashcastrSeenUrls).values(rows).onConflictDoNothing();
}
