import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { AgentDb } from '@life-os/shared';
import {
  fetchOne,
  fetchAllCurated,
  CURATED_SOURCES,
  type CuratedSource,
} from './source-fetcher.js';

// ─── In-memory fake AgentDb ──────────────────────────────────────────────
//
// Drizzle's chained API is hard to fake generically. We only need to mimic
// the four call shapes used by source-fetcher: select/insert/update plus
// onConflictDoNothing on insert. The fake stores rows keyed by URL since
// flashcastr_seen_urls is keyed on url and that's all we query by.

interface SeenRow {
  url: string;
  sourceLabel: string;
  classification: string;
  firstSeenAt: Date;
  lastCheckedAt: Date;
  lastChangedAt: Date;
  contentHash: string | null;
  lastSummary?: string | null;
}

function createFakeDb(): { db: AgentDb; rows: Map<string, SeenRow> } {
  const rows = new Map<string, SeenRow>();

  // Each select() returns a fresh chain so the URL filter is captured per-call,
  // safe under Promise.allSettled fan-out.
  const buildSelectChain = () => {
    let pendingUrl: string | null = null;
    const chain = {
      from: () => chain,
      where: (filter: unknown) => {
        pendingUrl = filter as string;
        return chain;
      },
      limit: async () => {
        const row = pendingUrl ? rows.get(pendingUrl) : undefined;
        return row ? [{ url: row.url, contentHash: row.contentHash }] : [];
      },
    };
    return chain;
  };

  const insertChain = (_table: unknown) => ({
    values: (vals: SeenRow) => {
      // Each call shape ends in await — return a thenable that applies the
      // appropriate side-effect once. `.onConflictDoNothing()` returns its
      // own thenable so chaining works either way.
      const applyInsert = (skipOnConflict: boolean) => {
        if (skipOnConflict && rows.has(vals.url)) return;
        rows.set(vals.url, { ...vals });
      };
      return {
        onConflictDoNothing: () => ({
          then: (resolve: (v: void) => void) => {
            applyInsert(true);
            resolve();
          },
        }),
        then: (resolve: (v: void) => void) => {
          applyInsert(false);
          resolve();
        },
      };
    },
  });

  const updateChain = (_table: unknown) => ({
    set: (patch: Partial<SeenRow>) => ({
      where: async (filter: unknown) => {
        const url = filter as string;
        const existing = rows.get(url);
        if (existing) rows.set(url, { ...existing, ...patch });
      },
    }),
  });

  const db = {
    select: () => buildSelectChain(),
    insert: insertChain,
    update: updateChain,
  } as unknown as AgentDb;

  return { db, rows };
}

// ─── Mock drizzle-orm.eq so our stub can recover the URL filter ──────────

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    // The fake DB only ever filters by URL — return the literal so our
    // selectChain.where can read it back.
    eq: (_col: unknown, val: unknown) => val,
  };
});

// ─── fetch mock ───────────────────────────────────────────────────────────

const TEST_SOURCES: CuratedSource[] = [
  { url: 'https://example-a.test/news', label: 'a-news', classification: 'news' },
  { url: 'https://example-b.test/gallery', label: 'b-gallery', classification: 'gallery' },
  { url: 'https://example-c.test/feed', label: 'c-feed', classification: 'fan' },
];

let fetchResponses: Map<string, { ok: boolean; status?: number; body: string }>;

function mockResponse(body: string, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  fetchResponses = new Map();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const r = fetchResponses.get(url);
    if (!r) throw new Error(`Unexpected fetch: ${url}`);
    if (!r.ok) return mockResponse(r.body, false, r.status ?? 500);
    return mockResponse(r.body);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe('fetchOne', () => {
  it('marks first-seen URLs and inserts a row', async () => {
    const { db, rows } = createFakeDb();
    fetchResponses.set(TEST_SOURCES[0].url, { ok: true, body: 'hello world' });

    const result = await fetchOne(TEST_SOURCES[0], db);

    expect(result.firstSeen).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.rawText).toBe('hello world');
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.size).toBe(1);
    expect(rows.get(TEST_SOURCES[0].url)?.contentHash).toBe(result.contentHash);
  });

  it('returns changed=false on identical body', async () => {
    const { db } = createFakeDb();
    fetchResponses.set(TEST_SOURCES[0].url, { ok: true, body: 'stable content' });

    await fetchOne(TEST_SOURCES[0], db);
    const second = await fetchOne(TEST_SOURCES[0], db);

    expect(second.firstSeen).toBe(false);
    expect(second.changed).toBe(false);
  });

  it('returns changed=true when body mutates', async () => {
    const { db } = createFakeDb();
    fetchResponses.set(TEST_SOURCES[0].url, { ok: true, body: 'v1' });
    await fetchOne(TEST_SOURCES[0], db);

    fetchResponses.set(TEST_SOURCES[0].url, { ok: true, body: 'v2-updated' });
    const second = await fetchOne(TEST_SOURCES[0], db);

    expect(second.firstSeen).toBe(false);
    expect(second.changed).toBe(true);
  });

  it('throws on HTTP error so the caller can skip it', async () => {
    const { db } = createFakeDb();
    fetchResponses.set(TEST_SOURCES[0].url, { ok: false, status: 503, body: 'down' });

    await expect(fetchOne(TEST_SOURCES[0], db)).rejects.toThrow(/HTTP 503/);
  });
});

describe('fetchAllCurated', () => {
  // The full curated list isn't relevant here — what matters is that one
  // failing fetch doesn't abort the others. We swap CURATED_SOURCES for
  // our test triplet by mocking fetch responses for those URLs only and
  // confirming the parallel-fan-out behaviour against the real list shape.
  it('returns successes when one source throws', async () => {
    const { db } = createFakeDb();

    // First two succeed, third throws
    for (const src of CURATED_SOURCES.slice(0, 2)) {
      fetchResponses.set(src.url, { ok: true, body: `content for ${src.label}` });
    }
    fetchResponses.set(CURATED_SOURCES[2].url, { ok: false, status: 500, body: 'oops' });
    // Remaining sources also throw (no entry in map)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const results = await fetchAllCurated(db);
    warn.mockRestore();

    // Should return only the two successful fetches
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.firstSeen)).toBe(true);
  });

  it('returns all successes on a clean run', async () => {
    const { db } = createFakeDb();
    for (const src of CURATED_SOURCES) {
      fetchResponses.set(src.url, { ok: true, body: `content for ${src.label}` });
    }

    const results = await fetchAllCurated(db);

    expect(results).toHaveLength(CURATED_SOURCES.length);
    expect(new Set(results.map((r) => r.label))).toEqual(new Set(CURATED_SOURCES.map((s) => s.label)));
  });

  it('detects per-URL change across two runs', async () => {
    const { db } = createFakeDb();

    for (const src of CURATED_SOURCES) {
      fetchResponses.set(src.url, { ok: true, body: `v1-${src.label}` });
    }
    const firstRun = await fetchAllCurated(db);
    expect(firstRun.every((r) => r.firstSeen && r.changed)).toBe(true);

    // Mutate the body for one URL only
    const target = CURATED_SOURCES[0];
    fetchResponses.set(target.url, { ok: true, body: `v2-${target.label}-changed` });

    const secondRun = await fetchAllCurated(db);
    const targetResult = secondRun.find((r) => r.url === target.url);
    expect(targetResult?.changed).toBe(true);
    expect(targetResult?.firstSeen).toBe(false);
    expect(secondRun.filter((r) => r.changed)).toHaveLength(1);
  });
});
