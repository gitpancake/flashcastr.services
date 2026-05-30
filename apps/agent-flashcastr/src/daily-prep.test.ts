import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  flashcastrInvaderEvents,
  flashcastrExternalNews,
  farcasterCastPlans,
} from '@life-os/shared';
import type { ProcessContext } from '@life-os/shared';
import { runDailyPrep, validatePlan, allocateSlots, buildUserPrompt } from './daily-prep.js';

// ─── Module mocks ─────────────────────────────────────────────────────────
// daily-prep imports its peers via local relative paths — we mock those so
// the AI call is the only behaviour under test. fetchAllCurated/searchOpenWeb
// are tested in their own files.

vi.mock('./source-fetcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source-fetcher.js')>();
  return {
    ...actual,
    fetchAllCurated: vi.fn(async () => []),
    searchOpenWeb: vi.fn(async () => [
      { url: 'https://discovered.example/page1', snippet: 'a' },
    ]),
  };
});

vi.mock('./scrapers/awazleon.js', () => ({
  scrapeAwazleon: vi.fn(async () => []),
}));

// runDailyPrep now fetches learned corrections (story 04). The store has its
// own unit tests — here we stub it so the fake DB doesn't need the corrections
// query shape. buildUserPrompt (FTBL regression below) takes the block as a
// plain string arg and is exercised directly, unaffected by this mock.
vi.mock('./corrections.js', () => ({
  getActiveCorrections: vi.fn(async () => []),
  formatCorrectionsBlock: vi.fn(() => ''),
}));

vi.mock('./flashcastr-api.js', () => ({
  fetchFlashcasterUsers: vi.fn(async () => []),
  fetchUserFlashes: vi.fn(async () => []),
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    gte: (_col: unknown, val: unknown) => val,
  };
});

// ─── Fake agent DB ────────────────────────────────────────────────────────
//
// Models the four call shapes daily-prep uses:
//   - select().from(table).where(filter).limit(n) — returns mocked rows
//   - select().from(table).where(filter)          — returns mocked rows (no .limit)
//   - insert(table).values(rows[].onConflictDoNothing()
//   - insert(table).values(row)                    — used for cast plans
//
// Insertions into farcaster_cast_plans are captured for assertion.

interface FakeDbRows {
  invaderEvents: Array<{ invaderId: string; city: string; eventType: string; eventDate: string; rawText: string | null; castGenerated: boolean }>;
  externalNews: Array<{ source: string; url: string; title: string; body: string; publishedAt: string | null; castGenerated: boolean }>;
}

function buildFakeDb(rows: FakeDbRows) {
  const insertedPlans: any[] = [];
  const insertedNews: any[] = [];

  // Each select() opens a fresh chain so two parallel selects can be in
  // flight without clobbering each other's pending table reference. The
  // chain awaits at .limit() — that's the call shape daily-prep uses.
  const buildSelectChain = () => {
    let pendingTable: unknown = null;

    const readRows = (): any[] => {
      if (pendingTable === flashcastrInvaderEvents) return rows.invaderEvents;
      if (pendingTable === flashcastrExternalNews) return rows.externalNews;
      return [];
    };

    const chain: any = {
      from: (table: unknown) => {
        pendingTable = table;
        return chain;
      },
      where: () => chain,
      limit: async () => readRows(),
    };
    return chain;
  };

  const insertChain = (table: unknown) => ({
    values: (vals: any) => {
      const list = Array.isArray(vals) ? vals : [vals];
      if (table === farcasterCastPlans) {
        insertedPlans.push(...list);
      } else if (table === flashcastrExternalNews) {
        insertedNews.push(...list);
      }
      return {
        onConflictDoNothing: () => Promise.resolve(),
        then: (resolve: () => void) => resolve(),
      };
    },
  });

  const db = {
    select: () => buildSelectChain(),
    insert: insertChain,
  };

  return { db, insertedPlans, insertedNews };
}

// ─── ctx builder ──────────────────────────────────────────────────────────

function buildCtx(rows: FakeDbRows, completeJsonSafe: ReturnType<typeof vi.fn>) {
  const { db, insertedPlans, insertedNews } = buildFakeDb(rows);
  const ctx = {
    agentDb: db,
    timezone: 'America/Vancouver',
    publisher: { publish: vi.fn() },
    ai: { completeJsonSafe },
  } as unknown as ProcessContext;
  return { ctx, insertedPlans, insertedNews };
}

// ─── Tests ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AWAZLEON_USER;
  delete process.env.AWAZLEON_PASS;
  delete process.env.FLASHCASTR_API_URL;
});

describe('runDailyPrep', () => {
  it('drops plans that reference hallucinated invader IDs and unknown URLs, inserts the rest', async () => {
    const rows: FakeDbRows = {
      invaderEvents: [
        { invaderId: 'PA_1099', city: 'PA', eventType: 'destruction', eventDate: '2026-04-30', rawText: 'gone', castGenerated: false },
        { invaderId: 'NY_42', city: 'NY', eventType: 'addition', eventDate: '2026-04-29', rawText: 'fresh', castGenerated: false },
      ],
      externalNews: [],
    };

    const completeJsonSafe = vi.fn(async () => ({
      plans: [
        // Valid: cites a real invader ID
        { text: 'PA_1099 is gone. RIP.', contentType: 'destruction', sourceInvaderIds: ['PA_1099'], sourceFlashId: null, embeds: [], scheduledHourOffset: 0 },
        // Valid: another real ID
        { text: 'NY_42 just landed. 👾', contentType: 'addition', sourceInvaderIds: ['NY_42'], sourceFlashId: null, embeds: [], scheduledHourOffset: 0 },
        // Invalid: hallucinated invader ID in body
        { text: 'PA_9999 also confirmed missing.', contentType: 'destruction', sourceInvaderIds: ['PA_9999'], sourceFlashId: null, embeds: [], scheduledHourOffset: 0 },
        // Invalid: URL not in the valid list
        { text: 'See the gallery at https://hallucinated.example/path', contentType: 'addition', sourceInvaderIds: [], sourceFlashId: null, embeds: [], scheduledHourOffset: 0 },
      ],
    }));

    const { ctx, insertedPlans } = buildCtx(rows, completeJsonSafe);
    const result = await runDailyPrep(ctx);

    expect(result.plansCreated).toBe(2);
    expect(insertedPlans).toHaveLength(2);
    expect(insertedPlans.every((p) => p.status === 'approved')).toBe(true);
    expect(insertedPlans.every((p) => p.accountHandle === 'flashcastr')).toBe(true);
    expect(insertedPlans.every((p) => p.channelId === 'invaders')).toBe(true);
  });

  it('spreads scheduled_for values across the 06–21 window with ≥30min stagger', async () => {
    const rows: FakeDbRows = {
      invaderEvents: [
        { invaderId: 'PA_1', city: 'PA', eventType: 'destruction', eventDate: '2026-04-30', rawText: 'a', castGenerated: false },
        { invaderId: 'PA_2', city: 'PA', eventType: 'addition', eventDate: '2026-04-30', rawText: 'b', castGenerated: false },
        { invaderId: 'PA_3', city: 'PA', eventType: 'reactivation', eventDate: '2026-04-30', rawText: 'c', castGenerated: false },
      ],
      externalNews: [],
    };

    const completeJsonSafe = vi.fn(async () => ({
      plans: [
        { text: 'PA_1 destroyed', contentType: 'destruction', sourceInvaderIds: ['PA_1'], sourceFlashId: null, embeds: [], scheduledHourOffset: 0 },
        { text: 'PA_2 new', contentType: 'addition', sourceInvaderIds: ['PA_2'], sourceFlashId: null, embeds: [], scheduledHourOffset: 0 },
        { text: 'PA_3 back', contentType: 'reactivation', sourceInvaderIds: ['PA_3'], sourceFlashId: null, embeds: [], scheduledHourOffset: 0 },
      ],
    }));

    const { ctx, insertedPlans } = buildCtx(rows, completeJsonSafe);
    await runDailyPrep(ctx);

    // 3 plans → 3 distinct slots, sorted destruction → addition → reactivation,
    // each separated by exactly 1h (60 min) — well above the 30min stagger.
    expect(insertedPlans).toHaveLength(3);
    const times = insertedPlans.map((p) => p.scheduledFor.getTime()).sort((a, b) => a - b);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(30 * 60_000);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(30 * 60_000);

    // Every slot must fall within the [06:00, 21:30] window of the next day.
    for (const p of insertedPlans) {
      const hour = parseInt(
        new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', hour: 'numeric', hourCycle: 'h23' }).format(p.scheduledFor),
        10,
      );
      expect(hour).toBeGreaterThanOrEqual(6);
      expect(hour).toBeLessThanOrEqual(21);
    }
  });

  it('returns 0 plans created when there is no signal (idempotent on quiet days)', async () => {
    // Override the open-web search mock to return [] for this test only — we
    // want the "no signal at all" branch where the AI call is skipped.
    const sourceFetcher = await import('./source-fetcher.js');
    (sourceFetcher.searchOpenWeb as any).mockResolvedValueOnce([]);

    const rows: FakeDbRows = { invaderEvents: [], externalNews: [] };
    const completeJsonSafe = vi.fn();

    const { ctx, insertedPlans } = buildCtx(rows, completeJsonSafe);
    const result = await runDailyPrep(ctx);

    expect(result.plansCreated).toBe(0);
    expect(insertedPlans).toHaveLength(0);
    // No AI call when there's nothing to talk about
    expect(completeJsonSafe).not.toHaveBeenCalled();
  });
});

describe('validatePlan', () => {
  const valid = {
    invaderIds: new Set(['PA_1', 'NY_2']),
    flashIds: new Set([100]),
    castHashes: new Set(['0xabc']),
    urls: new Set(['https://ok.example/']),
    flashLookup: new Map(),
  };

  it('accepts a plan with only valid references', () => {
    expect(validatePlan(
      { text: 'PA_1 is gone', contentType: 'destruction', sourceInvaderIds: ['PA_1'] },
      valid,
    )).toBe(true);
  });

  it('rejects plans with an unknown invader ID in body', () => {
    expect(validatePlan(
      { text: 'PA_999 destroyed', contentType: 'destruction', sourceInvaderIds: [] },
      valid,
    )).toBe(false);
  });

  it('rejects plans with a hallucinated URL', () => {
    expect(validatePlan(
      { text: 'See https://nope.example/x', contentType: 'addition', sourceInvaderIds: [] },
      valid,
    )).toBe(false);
  });

  it('rejects plans with an unknown cast hash in embeds', () => {
    expect(validatePlan(
      { text: 'highlight', contentType: 'highlight', sourceInvaderIds: [], embeds: [{ type: 'castId', fid: 1, hash: '0xdeadbeef' }] },
      valid,
    )).toBe(false);
  });

  it('rejects plans with an unknown flash ID', () => {
    expect(validatePlan(
      { text: 'highlight', contentType: 'highlight', sourceInvaderIds: [], sourceFlashId: 999 },
      valid,
    )).toBe(false);
  });
});

describe('allocateSlots', () => {
  it('sorts plans by content priority (destruction first)', () => {
    const plans = [
      { text: 'm', contentType: 'milestone', sourceInvaderIds: [] },
      { text: 'd', contentType: 'destruction', sourceInvaderIds: [] },
      { text: 'r', contentType: 'reactivation', sourceInvaderIds: [] },
      { text: 'a', contentType: 'addition', sourceInvaderIds: [] },
    ];
    const slots = allocateSlots(plans, '2026-05-05', 'America/Vancouver');
    expect(slots.map((s) => s.plan.contentType)).toEqual(['destruction', 'addition', 'reactivation', 'milestone']);
  });

  it('spreads N≤16 plans evenly across the 16-hour window', () => {
    // 4 plans → step = 16/4 = 4 → hours 6, 10, 14, 18 user-tz
    const plans = Array.from({ length: 4 }, (_, i) => ({
      text: `t${i}`,
      contentType: 'addition',
      sourceInvaderIds: [],
    }));
    const slots = allocateSlots(plans, '2026-05-05', 'America/Vancouver');
    expect(slots).toHaveLength(4);

    const hours = slots.map((s) =>
      parseInt(
        new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', hour: 'numeric', hourCycle: 'h23' }).format(s.scheduledFor),
        10,
      ),
    );
    expect(hours).toEqual([6, 10, 14, 18]);
  });

  it('doubles up at +30min when more than 16 plans', () => {
    const plans = Array.from({ length: 17 }, (_, i) => ({
      text: `t${i}`,
      contentType: 'addition',
      sourceInvaderIds: [],
    }));
    const slots = allocateSlots(plans, '2026-05-05', 'America/Vancouver');
    expect(slots).toHaveLength(17);

    // The 17th slot lands on hour 6 + 30min — which is exactly 30min after slot 0.
    const diff = slots[16].scheduledFor.getTime() - slots[0].scheduledFor.getTime();
    expect(diff).toBe(30 * 60_000);
  });
});

// ─── FTBL regression (story 04) ───────────────────────────────────────────
//
// https://farcaster.xyz/flashcastr/0x5ca6c770 — @flashcastr cast FTBL as
// "football". FTBL is Fontainebleau. Root cause (H1): the event line fed the
// model the raw code, never the resolved city, so the model free-associated
// the FTBL token. The fix injects the resolved city + an authoritative
// CITY CODES glossary and a persona rule "never expand a code yourself".
describe('buildUserPrompt — FTBL regression', () => {
  const ftblEvent = {
    invaderId: 'FTBL_46',
    city: 'FTBL',
    eventType: 'destruction',
    eventDate: '2026-05-16',
    rawText: 'Destruction de FTBL_46.',
  };

  const inputs = (correctionsBlock?: string) => ({
    valid: {
      invaderIds: new Set(['FTBL_46']),
      flashIds: new Set<number>(),
      castHashes: new Set<string>(),
      urls: new Set<string>(),
      flashLookup: new Map(),
    },
    events: [ftblEvent],
    newsRows: [],
    sourceDeltas: [],
    discovered: [],
    awazleonItems: [],
    today: '2026-05-16',
    correctionsBlock,
  });

  it('renders the resolved city, never the bare ambiguous code', () => {
    const prompt = buildUserPrompt(inputs() as any);
    expect(prompt).toContain('FTBL_46 (Fontainebleau)');
    expect(prompt).not.toContain('FTBL_46 (FTBL)'); // the pre-fix shape that produced "football"
  });

  it('includes an authoritative code→city glossary', () => {
    const prompt = buildUserPrompt(inputs() as any);
    expect(prompt).toContain('CITY CODES');
    expect(prompt).toContain('FTBL = Fontainebleau');
  });

  it('prepends the learned-corrections block when supplied', () => {
    const block = 'LEARNED CORRECTIONS:\n- NOT "FTBL is football" — the correct fact: FTBL is Fontainebleau';
    const prompt = buildUserPrompt(inputs(block) as any);
    expect(prompt.startsWith('LEARNED CORRECTIONS')).toBe(true);
    expect(prompt).toContain('FTBL is Fontainebleau');
  });

  it('omits the corrections block entirely when there are none', () => {
    const prompt = buildUserPrompt(inputs('') as any);
    expect(prompt).not.toContain('LEARNED CORRECTIONS');
    expect(prompt.startsWith('DATE: 2026-05-16')).toBe(true);
  });
});
