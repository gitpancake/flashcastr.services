import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcessContext } from '@life-os/shared';

vi.mock('./farcaster-publish.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./farcaster-publish.js')>();
  return {
    ...actual,
    publishLike: vi.fn(async () => ({ castHash: '0xreaction' })),
    publishCast: vi.fn(async () => ({ castHash: '0xpublished' })),
  };
});

import { dispatchCast, likeCast } from './dispatch-cast.js';
import { publishLike, publishCast } from './farcaster-publish.js';

// agentDb covering the dispatchCast success path: account lookup → castQueue
// insert (returns {id}) → castQueue update; plus a no-op publisher.
function buildDispatchCtx() {
  const agentDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ handle: 'flashcastr', fid: 42, enabled: true, signerPrivateKey: 'enc' }],
        }),
      }),
    }),
    insert: () => ({ values: () => ({ returning: async () => [{ id: 'q1' }] }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  };
  return { agentDb, publisher: { publish: vi.fn() } } as unknown as ProcessContext;
}

// agentDb whose select returns one enabled account row (success path for likeCast).
function buildAccountCtx() {
  const agentDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ handle: 'flashcastr', fid: 42, enabled: true, signerPrivateKey: 'enc' }],
        }),
      }),
    }),
  };
  return { agentDb } as unknown as ProcessContext;
}

// Build a ProcessContext stub that returns an empty account list — exercises the
// "account not found" early-return path. We assert no insert/update/publish happens.
function buildEmptyAccountCtx() {
  const insert = vi.fn();
  const update = vi.fn();
  const publish = vi.fn();

  const agentDb = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [] }),
      }),
    }),
    insert,
    update,
  };

  const ctx = { agentDb, publisher: { publish } } as unknown as ProcessContext;
  return { ctx, insert, update, publish };
}

describe('dispatchCast', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('drops the cast when the account is missing — no queue insert, no publish', async () => {
    const { ctx, insert, update, publish } = buildEmptyAccountCtx();

    await dispatchCast(ctx, {
      accountHandle: 'unknown',
      text: 'hello',
      sourceEngine: 'agent-flashcastr',
    });

    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('dispatchCast — reply threading', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  it('forwards parentFid alongside parentHash so publishCast threads it as a reply', async () => {
    const ctx = buildDispatchCtx();

    await dispatchCast(ctx, {
      accountHandle: 'flashcastr',
      text: 'reply body',
      parentHash: '0xinbound',
      parentFid: 732,
      sourceEngine: 'conversational-reply',
    });

    expect(publishCast).toHaveBeenCalledTimes(1);
    const opts = (publishCast as ReturnType<typeof vi.fn>).mock.calls[0][6];
    expect(opts).toMatchObject({ parentHash: '0xinbound', parentFid: 732 });
  });

  it('omits parentFid (undefined) when not a reply — top-level cast unchanged', async () => {
    const ctx = buildDispatchCtx();

    await dispatchCast(ctx, {
      accountHandle: 'flashcastr',
      text: 'top level',
      sourceEngine: 'self-publish',
    });

    const opts = (publishCast as ReturnType<typeof vi.fn>).mock.calls[0][6];
    expect(opts.parentHash).toBeUndefined();
    expect(opts.parentFid).toBeUndefined();
  });
});

describe('likeCast', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  it('returns false when the account is missing — no Hub submit', async () => {
    const { ctx } = buildEmptyAccountCtx();

    const ok = await likeCast(ctx, { accountHandle: 'unknown', targetHash: '0xabc', targetFid: 7 });

    expect(ok).toBe(false);
    expect(publishLike).not.toHaveBeenCalled();
  });

  it('submits a LIKE on the target cast and returns true', async () => {
    const ctx = buildAccountCtx();

    const ok = await likeCast(ctx, { accountHandle: 'flashcastr', targetHash: '0xinbound', targetFid: 99 });

    expect(ok).toBe(true);
    // Env-derived args (api key, encryption key) are unset in the test env;
    // assert the account-derived + target args precisely.
    expect(publishLike).toHaveBeenCalledWith(
      expect.anything(), undefined, 'enc', undefined, 42, 99, '0xinbound',
    );
  });

  it('returns false (never throws) when the Hub rejects the like', async () => {
    (publishLike as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Hub rejected like'));
    const ctx = buildAccountCtx();

    const ok = await likeCast(ctx, { accountHandle: 'flashcastr', targetHash: '0xinbound', targetFid: 99 });

    expect(ok).toBe(false);
  });
});
