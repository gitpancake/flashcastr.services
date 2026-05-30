import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProcessContext } from '@life-os/shared';

// dispatch-cast is mocked so we assert dispatch intent (parentHash, count)
// without a real publish path. Mirrors self-publish.test.ts.
vi.mock('./dispatch-cast.js', () => ({
  dispatchCast: vi.fn(async () => true),
  likeCast: vi.fn(async () => true),
}));

import { generateReply, processNewMentions } from './conversational-reply.js';
import { dispatchCast, likeCast } from './dispatch-cast.js';

type MentionRow = {
  castHash: string;
  authorFid: number;
  authorUsername: string;
  parentHash: string | null;
  threadRootHash: string | null;
  text: string;
  kind: string;
  status: string;
  processedAt: Date | null;
};

function mention(overrides: Partial<MentionRow> & { castHash: string }): MentionRow {
  return {
    authorFid: 111,
    authorUsername: 'alice',
    parentHash: null,
    threadRootHash: '0xroot1',
    text: 'hey @flashcastr is PA_1099 still up?',
    kind: 'mention',
    status: 'new',
    processedAt: null,
    ...overrides,
  };
}

type AuthorCount = { authorFid: number; inboundCount: number };

// select() drains a queue of result-sets in call order. processNewMentions
// issues exactly two selects when there are pending rows: [pending,
// authorCounts]. pending resolves via .limit(); the rate-limit count query
// resolves via .groupBy().
function buildFakeDb(pending: MentionRow[], authorCounts: AuthorCount[]) {
  const selectQueue: unknown[][] = [pending, authorCounts];
  const updates: Array<{ status: string; processedAt: Date | null }> = [];

  const buildSelectChain = () => {
    const rows = selectQueue.shift() ?? [];
    const chain: any = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: async () => rows,
      groupBy: async () => rows,
    };
    return chain;
  };

  const agentDb: any = {
    select: () => buildSelectChain(),
    update: () => ({
      set: (vals: { status: string; processedAt: Date | null }) => ({
        where: () => {
          updates.push({ status: vals.status, processedAt: vals.processedAt });
          return Promise.resolve();
        },
      }),
    }),
  };

  return { agentDb, updates };
}

function buildCtx(pending: MentionRow[], authorCounts: AuthorCount[] = []) {
  const { agentDb, updates } = buildFakeDb(pending, authorCounts);
  const ctx = { agentDb } as unknown as ProcessContext;
  return { ctx, updates };
}

const fakeNeynar = {
  lookupCastConversation: vi.fn(async () => ({
    conversation: { cast: { author: { username: 'alice' }, text: 'is PA_1099 up?', direct_replies: [] } },
  })),
};

function fakeAi(impl: () => unknown) {
  return { completeJson: vi.fn(async () => impl()) } as any;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('generateReply', () => {
  it('returns the trimmed reply when in scope', async () => {
    const ai = fakeAi(() => ({ in_scope: true, reply: '  PA_1099 still holding the wall 👾  ' }));
    expect(await generateReply(ai, 'is PA_1099 up?', 'alice', null)).toBe('PA_1099 still holding the wall 👾');
  });

  it('returns null when out of scope (spam/abuse/off-topic)', async () => {
    const ai = fakeAi(() => ({ in_scope: false, reply: '' }));
    expect(await generateReply(ai, 'buy cheap followers', 'spammer', null)).toBeNull();
  });

  it('returns null when in scope but reply text is empty', async () => {
    const ai = fakeAi(() => ({ in_scope: true, reply: '   ' }));
    expect(await generateReply(ai, 'hi', 'alice', null)).toBeNull();
  });

  it('returns null (no throw) when the AI call fails', async () => {
    const ai = { completeJson: vi.fn(async () => { throw new Error('api 500'); }) } as any;
    expect(await generateReply(ai, 'hi', 'alice', null)).toBeNull();
  });
});

describe('processNewMentions', () => {
  it('replies once to an in-scope mention, as a reply to the inbound cast', async () => {
    const { ctx, updates } = buildCtx([mention({ castHash: '0xm1' })]);
    const ai = fakeAi(() => ({ in_scope: true, reply: 'PA_1099 still up. classic.' }));
    const counter = { inc: vi.fn() };

    const result = await processNewMentions(ctx, fakeNeynar, ai, counter);

    expect(result).toEqual({ replied: 1, skipped: 0 });
    expect(dispatchCast).toHaveBeenCalledTimes(1);
    expect(dispatchCast).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ accountHandle: 'flashcastr', parentHash: '0xm1', parentFid: 111, text: 'PA_1099 still up. classic.' }),
    );
    expect(counter.inc).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([{ status: 'replied', processedAt: expect.any(Date) }]);
  });

  it('likes the inbound cast after a successful reply (seen-you ack), increments likeCounter', async () => {
    const { ctx } = buildCtx([mention({ castHash: '0xm1', authorFid: 111 })]);
    const ai = fakeAi(() => ({ in_scope: true, reply: 'PA_1099 still up.' }));
    const likeCounter = { inc: vi.fn() };

    await processNewMentions(ctx, fakeNeynar, ai, { inc: vi.fn() }, Date.now(), '', likeCounter);

    expect(likeCast).toHaveBeenCalledTimes(1);
    expect(likeCast).toHaveBeenCalledWith(
      ctx,
      { accountHandle: 'flashcastr', targetHash: '0xm1', targetFid: 111 },
    );
    expect(likeCounter.inc).toHaveBeenCalledTimes(1);
  });

  it('does not like an out-of-scope inbound (only replied-to casts get a like)', async () => {
    const { ctx } = buildCtx([mention({ castHash: '0xspam', text: 'follow for follow' })]);
    const ai = fakeAi(() => ({ in_scope: false, reply: '' }));
    const likeCounter = { inc: vi.fn() };

    await processNewMentions(ctx, fakeNeynar, ai, { inc: vi.fn() }, Date.now(), '', likeCounter);

    expect(likeCast).not.toHaveBeenCalled();
    expect(likeCounter.inc).not.toHaveBeenCalled();
  });

  it('does not like when reply dispatch fails', async () => {
    (dispatchCast as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const { ctx } = buildCtx([mention({ castHash: '0xfail' })]);
    const ai = fakeAi(() => ({ in_scope: true, reply: 'tried' }));
    const likeCounter = { inc: vi.fn() };

    await processNewMentions(ctx, fakeNeynar, ai, { inc: vi.fn() }, Date.now(), '', likeCounter);

    expect(likeCast).not.toHaveBeenCalled();
    expect(likeCounter.inc).not.toHaveBeenCalled();
  });

  it('reply still counts when the like fails (like is best-effort, post-reply)', async () => {
    (likeCast as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const { ctx, updates } = buildCtx([mention({ castHash: '0xm9' })]);
    const ai = fakeAi(() => ({ in_scope: true, reply: 'take' }));
    const counter = { inc: vi.fn() };
    const likeCounter = { inc: vi.fn() };

    const result = await processNewMentions(ctx, fakeNeynar, ai, counter, Date.now(), '', likeCounter);

    expect(result).toEqual({ replied: 1, skipped: 0 });
    expect(counter.inc).toHaveBeenCalledTimes(1);
    expect(likeCounter.inc).not.toHaveBeenCalled();
    expect(updates).toEqual([{ status: 'replied', processedAt: expect.any(Date) }]);
  });

  it('out-of-scope inbound → no dispatch, marked skipped', async () => {
    const { ctx, updates } = buildCtx([mention({ castHash: '0xspam', text: 'follow for follow' })]);
    const ai = fakeAi(() => ({ in_scope: false, reply: '' }));

    const result = await processNewMentions(ctx, fakeNeynar, ai, { inc: vi.fn() });

    expect(result).toEqual({ replied: 0, skipped: 1 });
    expect(dispatchCast).not.toHaveBeenCalled();
    expect(updates).toEqual([{ status: 'skipped', processedAt: expect.any(Date) }]);
  });

  it('suppresses replies to an author over the rate limit (>15 inbound/h)', async () => {
    const { ctx, updates } = buildCtx(
      [mention({ castHash: '0xrl', authorFid: 111 })],
      [{ authorFid: 111, inboundCount: 16 }],
    );
    const ai = fakeAi(() => ({ in_scope: true, reply: 'should not post' }));

    const result = await processNewMentions(ctx, fakeNeynar, ai, { inc: vi.fn() });

    expect(result).toEqual({ replied: 0, skipped: 1 });
    expect(dispatchCast).not.toHaveBeenCalled();
    expect(updates).toEqual([{ status: 'skipped', processedAt: expect.any(Date) }]);
  });

  it('still replies at exactly the cap (15/h is not over the limit)', async () => {
    const { ctx } = buildCtx(
      [mention({ castHash: '0xcap', authorFid: 111 })],
      [{ authorFid: 111, inboundCount: 15 }],
    );
    const ai = fakeAi(() => ({ in_scope: true, reply: 'still good' }));

    const result = await processNewMentions(ctx, fakeNeynar, ai, { inc: vi.fn() });

    expect(result).toEqual({ replied: 1, skipped: 0 });
    expect(dispatchCast).toHaveBeenCalledTimes(1);
  });

  it('no flat cooldown: two pending casts from the same author both get replies', async () => {
    const { ctx, updates } = buildCtx([
      mention({ castHash: '0xa', threadRootHash: '0xroot1', authorFid: 7 }),
      mention({ castHash: '0xb', threadRootHash: '0xroot1', authorFid: 7 }),
    ]);
    const ai = fakeAi(() => ({ in_scope: true, reply: 'a take' }));

    const result = await processNewMentions(ctx, fakeNeynar, ai, { inc: vi.fn() });

    expect(result).toEqual({ replied: 2, skipped: 0 });
    expect(dispatchCast).toHaveBeenCalledTimes(2);
    expect(updates).toEqual([
      { status: 'replied', processedAt: expect.any(Date) },
      { status: 'replied', processedAt: expect.any(Date) },
    ]);
  });

  it('rate-limits only the over-cap author; others in the same batch still get replies', async () => {
    const { ctx, updates } = buildCtx(
      [
        mention({ castHash: '0xspam', authorFid: 111 }),
        mention({ castHash: '0xok', authorFid: 222 }),
      ],
      [{ authorFid: 111, inboundCount: 50 }, { authorFid: 222, inboundCount: 2 }],
    );
    const ai = fakeAi(() => ({ in_scope: true, reply: 'take' }));

    const result = await processNewMentions(ctx, fakeNeynar, ai, { inc: vi.fn() });

    expect(result).toEqual({ replied: 1, skipped: 1 });
    expect(dispatchCast).toHaveBeenCalledTimes(1);
    expect(dispatchCast).toHaveBeenCalledWith(ctx, expect.objectContaining({ parentHash: '0xok', parentFid: 222 }));
    expect(updates).toEqual([
      { status: 'skipped', processedAt: expect.any(Date) },
      { status: 'replied', processedAt: expect.any(Date) },
    ]);
  });

  it('dispatch failure → marked skipped, no retry', async () => {
    (dispatchCast as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const { ctx, updates } = buildCtx([mention({ castHash: '0xfail' })]);
    const ai = fakeAi(() => ({ in_scope: true, reply: 'tried' }));

    const result = await processNewMentions(ctx, fakeNeynar, ai, { inc: vi.fn() });

    expect(result).toEqual({ replied: 0, skipped: 1 });
    expect(updates).toEqual([{ status: 'skipped', processedAt: expect.any(Date) }]);
  });

  it('no pending rows → no work, no second select', async () => {
    const { ctx } = buildCtx([]);
    const ai = fakeAi(() => ({ in_scope: true, reply: 'x' }));

    const result = await processNewMentions(ctx, fakeNeynar, ai, { inc: vi.fn() });

    expect(result).toEqual({ replied: 0, skipped: 0 });
    expect(dispatchCast).not.toHaveBeenCalled();
  });
});

// ─── Correction loop (story 04) ───────────────────────────────────────────
//
// A public "you got X wrong, it's Y" is classified `correction`, persisted to
// flashcastr_corrections, and acknowledged in character via the reply path.
// The fake DB here adds insert().values().returning() (the existing fake only
// modelled select/update — the non-correction paths never insert).

// Capture both the correction insert (uses .returning()) and the audit
// insert (no .returning() — awaits .values() directly). The fake's insert
// branches on whether .returning() is called by the caller.
function buildCorrectionDb(pending: MentionRow[], opts: { auditCount?: number } = {}) {
  // selectQueue order: [pending, authorCounts, factCheckBudgetRows...]
  // isUnderFactCheckBudget issues one select per correction. We seed an empty
  // result-set per expected correction so the budget always passes.
  const factCheckBudgetSlots = Array.from({ length: pending.length }, () => Array.from({ length: opts.auditCount ?? 0 }, (_, i) => ({ id: `aud-${i}` })));
  const selectQueue: unknown[][] = [pending, [], ...factCheckBudgetSlots];
  const updates: Array<{ status: string }> = [];
  const corrections: any[] = [];
  const audits: any[] = [];

  const buildSelectChain = () => {
    const rows = selectQueue.shift() ?? [];
    const chain: any = { from: () => chain, where: () => chain, orderBy: () => chain, limit: async () => rows, groupBy: async () => rows, then: (resolve: any) => resolve(rows) };
    return chain;
  };

  const agentDb: any = {
    select: () => buildSelectChain(),
    insert: () => {
      let captured: any = null;
      const valuesChain: any = (vals: any) => {
        captured = vals;
        // .returning() → corrections insert. Bare await → audit insert.
        return {
          returning: async () => {
            corrections.push(captured);
            return [{ id: 'corr-1' }];
          },
          then: (resolve: any) => {
            audits.push(captured);
            resolve(undefined);
          },
        };
      };
      return { values: valuesChain };
    },
    update: () => ({
      set: (vals: { status: string }) => ({
        where: () => { updates.push({ status: vals.status }); return Promise.resolve(); },
      }),
    }),
  };
  return { agentDb, updates, corrections, audits };
}

// completeJson is called on classify, relevance, ack, soft-ack. complete is
// called on the web-fact-check. Branch on taskName so each returns its own
// shape. `verdict` lets the test pick the web verdict.
function correctionAi(verdict: 'high' | 'low' | 'reject' = 'high', relevant = true) {
  return {
    completeJson: vi.fn(async (opts: any) => {
      if (opts.taskName === 'flashcastr_inbound_intent') {
        return {
          kind: 'correction',
          correction: { wrongClaim: 'FTBL is football', correctFact: 'FTBL is Fontainebleau' },
          reasoning: 'author contradicts FTBL',
        };
      }
      if (opts.taskName === 'flashcastr_correction_relevance') {
        return { relevant, reasoning: relevant ? 'about FTBL city code' : 'off-topic banter' };
      }
      if (opts.taskName === 'flashcastr_correction_ack') {
        return { reply: "ah you're right — FTBL is Fontainebleau, not football. fixed 👾" };
      }
      if (opts.taskName === 'flashcastr_correction_soft_ack') {
        return { reply: 'noted — sitting with that one 👾' };
      }
      return { in_scope: true, reply: 'should not be used on the correction path' };
    }),
    complete: vi.fn(async (opts: any) => {
      if (opts.taskName === 'flashcastr_correction_fact_check') {
        return { text: JSON.stringify({ confidence: verdict, reasoning: `web evidence: ${verdict}` }) };
      }
      return { text: '{}' };
    }),
  } as any;
}

describe('processNewMentions — correction intent', () => {
  it('persists the correction and posts a confident ack when relevant + web-verified high', async () => {
    const { agentDb, updates, corrections, audits } = buildCorrectionDb([
      mention({ castHash: '0xcorr', authorFid: 77, authorUsername: 'hunter', text: 'mate FTBL is Fontainebleau not football' }),
    ]);
    const ctx = { agentDb } as unknown as ProcessContext;
    const counter = { inc: vi.fn() };

    const result = await processNewMentions(ctx, fakeNeynar, correctionAi('high'), counter);

    expect(result).toEqual({ replied: 1, skipped: 0 });

    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({
      wrongClaim: 'FTBL is football',
      correctFact: 'FTBL is Fontainebleau',
      sourceCastHash: '0xcorr',
      authorFid: 77,
    });
    // Audit row records the verified outcome.
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ relevant: true, factCheckVerdict: 'high', persisted: true });

    expect(dispatchCast).toHaveBeenCalledTimes(1);
    expect(dispatchCast).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ parentHash: '0xcorr', parentFid: 77, text: expect.stringContaining('Fontainebleau') }),
    );
    expect(updates).toEqual([{ status: 'replied' }]);
    expect(counter.inc).toHaveBeenCalledTimes(1);
    expect(likeCast).toHaveBeenCalledWith(
      ctx,
      { accountHandle: 'flashcastr', targetHash: '0xcorr', targetFid: 77 },
    );
  });

  it('does NOT persist, posts a soft non-committal ack when web verdict is low', async () => {
    const { agentDb, corrections, audits } = buildCorrectionDb([mention({ castHash: '0xlow' })]);
    const ctx = { agentDb } as unknown as ProcessContext;

    const result = await processNewMentions(ctx, fakeNeynar, correctionAi('low'), { inc: vi.fn() });

    expect(result).toEqual({ replied: 1, skipped: 0 });
    expect(corrections).toHaveLength(0); // never persisted
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ relevant: true, factCheckVerdict: 'low', persisted: false });

    // Soft ack — does NOT restate either claim, does NOT reveal verification.
    const sent = (dispatchCast as any).mock.calls[0][1].text as string;
    expect(sent).not.toMatch(/Fontainebleau|football|check|verif|search/i);
  });

  it('does NOT persist when web verdict is reject', async () => {
    const { agentDb, corrections, audits } = buildCorrectionDb([mention({ castHash: '0xrej' })]);
    const ctx = { agentDb } as unknown as ProcessContext;

    await processNewMentions(ctx, fakeNeynar, correctionAi('reject'), { inc: vi.fn() });

    expect(corrections).toHaveLength(0);
    expect(audits[0]).toMatchObject({ factCheckVerdict: 'reject', persisted: false });
  });

  it('skips web fact-check and posts soft ack when claim is irrelevant (off-topic)', async () => {
    const { agentDb, corrections, audits } = buildCorrectionDb([mention({ castHash: '0xoff' })]);
    const ctx = { agentDb } as unknown as ProcessContext;
    const ai = correctionAi('high', false);

    await processNewMentions(ctx, fakeNeynar, ai, { inc: vi.fn() });

    expect(corrections).toHaveLength(0);
    expect(audits[0]).toMatchObject({ relevant: false, factCheckVerdict: null, persisted: false });
    // Web fact-check was NEVER called (no ai.complete invocation).
    expect((ai.complete as any).mock.calls.filter((c: any[]) => c[0].taskName === 'flashcastr_correction_fact_check')).toHaveLength(0);
  });

  it('skips web fact-check and posts soft ack when daily budget exhausted', async () => {
    // Seed isUnderFactCheckBudget to return 20+ rows so the budget check trips.
    const { agentDb, corrections, audits } = buildCorrectionDb([mention({ castHash: '0xbud' })], { auditCount: 25 });
    const ctx = { agentDb } as unknown as ProcessContext;
    const ai = correctionAi('high');

    await processNewMentions(ctx, fakeNeynar, ai, { inc: vi.fn() });

    expect(corrections).toHaveLength(0);
    expect(audits[0]).toMatchObject({ relevant: true, factCheckVerdict: null, persisted: false });
    expect((ai.complete as any).mock.calls.filter((c: any[]) => c[0].taskName === 'flashcastr_correction_fact_check')).toHaveLength(0);
  });

  it('still acks (does not crash) when persistence fails on a verified correction', async () => {
    const { agentDb, audits } = buildCorrectionDb([mention({ castHash: '0xcorr2' })]);
    // Override the correction insert to throw; audit insert path stays intact.
    const realInsert = agentDb.insert;
    agentDb.insert = vi.fn(() => {
      const chain = realInsert();
      const realValues = chain.values;
      chain.values = (vals: any) => {
        const inner = realValues(vals);
        return { ...inner, returning: async () => { throw new Error('db down'); } };
      };
      return chain;
    });
    const ctx = { agentDb } as unknown as ProcessContext;

    const result = await processNewMentions(ctx, fakeNeynar, correctionAi('high'), { inc: vi.fn() });

    expect(result).toEqual({ replied: 1, skipped: 0 });
    expect(dispatchCast).toHaveBeenCalledTimes(1);
    // Audit still recorded persisted=false because the persist threw.
    expect(audits[0]).toMatchObject({ factCheckVerdict: 'high', persisted: false });
  });
});
