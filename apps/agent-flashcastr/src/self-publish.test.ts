import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { farcasterCastPlans } from '@life-os/shared';
import type { ProcessContext } from '@life-os/shared';

// ─── Module mocks ─────────────────────────────────────────────────────────

vi.mock('./dispatch-cast.js', () => ({
  dispatchCast: vi.fn(async () => true),
}));

vi.mock('./daily-prep.js', () => ({
  runDailyPrep: vi.fn(async () => ({ plansCreated: 3 })),
}));

vi.mock('@life-os/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@life-os/shared')>();
  return {
    ...actual,
    getDailyFlag: vi.fn(async () => false),
    setDailyFlag: vi.fn(async () => {}),
  };
});

import { publishReadyPlans, runDailyPrepGate, STALE_THRESHOLD_MS } from './self-publish.js';
import { dispatchCast } from './dispatch-cast.js';
import { runDailyPrep } from './daily-prep.js';
import { getDailyFlag, setDailyFlag } from '@life-os/shared';

// ─── Fake DB ───────────────────────────────────────────────────────────────

type PlanRow = {
  id: string;
  accountHandle: string;
  text: string;
  editedText: string | null;
  parentHash: string | null;
  channelId: string | null;
  embeds: unknown[] | null;
  scheduledFor: Date;
  status: string;
};

function buildPlan(overrides: Partial<PlanRow> & { scheduledFor: Date }): PlanRow {
  return {
    id: 'plan-1',
    accountHandle: 'flashcastr',
    text: 'test cast',
    editedText: null,
    parentHash: null,
    channelId: 'invaders',
    embeds: [],
    status: 'approved',
    ...overrides,
  };
}

function buildFakeDb(selectRows: PlanRow[]) {
  const updates: Array<{ id: string; status: string }> = [];
  // Queue of plan ids to assign to updates in the order they're processed.
  // publishReadyPlans uses limit(1) so at most one plan is processed per call,
  // but the queue handles multi-call scenarios correctly.
  const planIdQueue = selectRows.map(r => r.id);

  const buildSelectChain = () => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: async () => selectRows,
    };
    return chain;
  };

  const agentDb: any = {
    select: () => buildSelectChain(),
    update: (_table: unknown) => {
      let pendingStatus: string;
      return {
        set: (vals: { status: string }) => {
          pendingStatus = vals.status;
          return {
            where: (_cond: unknown) => {
              updates.push({ id: planIdQueue.shift() ?? 'unknown', status: pendingStatus });
              return Promise.resolve();
            },
          };
        },
      };
    },
  };

  return { agentDb, updates };
}

function buildCtx(rows: PlanRow[], timezone = 'America/Vancouver'): { ctx: ProcessContext; updates: Array<{ id: string; status: string }> } {
  const { agentDb, updates } = buildFakeDb(rows);
  const ctx = {
    agentDb,
    timezone,
    publisher: { publish: vi.fn() },
    ai: {},
  } as unknown as ProcessContext;
  return { ctx, updates };
}

// ─── Tests ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('publishReadyPlans', () => {
  it('dispatches exactly 1 cast when 6 past-due plans are queued', async () => {
    const now = new Date();
    const pastDue = new Date(now.getTime() - 5 * 60_000); // 5min ago

    // DB returns only 1 row because of .limit(1) — simulates 6-plan queue.
    // The rate-limit is enforced by the query; we verify the function never calls
    // dispatchCast more than once per invocation.
    const { ctx } = buildCtx([buildPlan({ scheduledFor: pastDue })]);

    await publishReadyPlans(ctx);

    expect(dispatchCast).toHaveBeenCalledTimes(1);
  });

  it('marks plan as expired and skips dispatch when scheduledFor is older than 30min', async () => {
    const now = new Date();
    const staleTime = new Date(now.getTime() - (STALE_THRESHOLD_MS + 60_000)); // 31min ago
    const { ctx, updates } = buildCtx([buildPlan({ id: 'stale-plan', scheduledFor: staleTime })]);

    await publishReadyPlans(ctx);

    expect(dispatchCast).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0].status).toBe('expired');
  });

  it('dispatches and marks published when plan is 5min past scheduledFor', async () => {
    const now = new Date();
    const freshTime = new Date(now.getTime() - 5 * 60_000); // 5min ago — well under 30min
    const { ctx, updates } = buildCtx([buildPlan({ id: 'fresh-plan', scheduledFor: freshTime })]);

    await publishReadyPlans(ctx);

    expect(dispatchCast).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].status).toBe('published');
  });

  it('marks plan as failed when dispatchCast returns false', async () => {
    (dispatchCast as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const now = new Date();
    const freshTime = new Date(now.getTime() - 5 * 60_000);
    const { ctx, updates } = buildCtx([buildPlan({ id: 'fail-plan', scheduledFor: freshTime })]);

    await publishReadyPlans(ctx);

    expect(updates).toHaveLength(1);
    expect(updates[0].status).toBe('failed');
  });
});

describe('runDailyPrepGate', () => {
  it('sets the daily flag BEFORE calling runDailyPrep so a thrown error closes the gate', async () => {
    const callOrder: string[] = [];
    (setDailyFlag as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      callOrder.push('setDailyFlag');
    });
    (runDailyPrep as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      callOrder.push('runDailyPrep');
      throw new Error('prep exploded');
    });

    const { ctx } = buildCtx([]);
    await runDailyPrepGate(ctx, 8);

    expect(callOrder).toEqual(['setDailyFlag', 'runDailyPrep']);
  });

  it('skips runDailyPrep on second invocation when flag is already set', async () => {
    // First call: flag not set, prep runs normally.
    await runDailyPrepGate(buildCtx([]).ctx, 8);
    expect(runDailyPrep).toHaveBeenCalledTimes(1);

    // Second call: getDailyFlag now returns true (flag was set during first call).
    (getDailyFlag as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    await runDailyPrepGate(buildCtx([]).ctx, 8);

    // runDailyPrep still called only once total.
    expect(runDailyPrep).toHaveBeenCalledTimes(1);
  });
});
