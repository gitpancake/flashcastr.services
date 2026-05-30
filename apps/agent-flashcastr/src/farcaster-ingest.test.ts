import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcessContext } from '@life-os/shared';
import { ingestMentions, resolveOwnFid, buildThreadContext, persistMention } from './farcaster-ingest.js';

const OWN_FID = 99999;

// Fake agentDb whose insert chain mirrors the real
// `.insert(t).values(v).onConflictDoNothing().returning(...)` shape used in
// main.ts:scrapeAndStore. Dedup is modeled with a Set keyed on castHash so a
// re-poll of the same notification returns [] (no row), exactly like a PG
// ON CONFLICT DO NOTHING on the cast_hash PK.
function buildFakeDb(accountRow: { fid: number; handle: string } | null) {
  const seen = new Set<string>();
  const inserted: Array<Record<string, unknown>> = [];

  const agentDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (accountRow ? [accountRow] : []),
        }),
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            const hash = row.castHash as string;
            if (seen.has(hash)) return [];
            seen.add(hash);
            inserted.push(row);
            return [{ castHash: hash }];
          },
        }),
      }),
    }),
  };

  const ctx = { agentDb } as unknown as ProcessContext;
  return { ctx, inserted };
}

function fakeNeynar(notifications: unknown[]) {
  return {
    fetchAllNotifications: vi.fn(async () => ({ notifications })),
  };
}

const MENTION = {
  type: 'mention',
  cast: {
    hash: '0xmention1',
    parent_hash: null,
    thread_hash: '0xroot1',
    text: 'hey @flashcastr what is FTBL?',
    author: { fid: 111, username: 'alice' },
  },
};

const REPLY = {
  type: 'reply',
  cast: {
    hash: '0xreply1',
    parent_hash: '0xourcast',
    thread_hash: '0xourcast',
    text: 'nice spot',
    author: { fid: 222, username: 'bob' },
  },
};

const LIKE = { type: 'likes', cast: { hash: '0xlike1', author: { fid: 333 } } };

describe('ingestMentions', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('persists mentions + own-cast replies, skips non-conversational types, counts each insert', async () => {
    const { ctx, inserted } = buildFakeDb(null);
    const neynar = fakeNeynar([MENTION, REPLY, LIKE]);
    const counter = { inc: vi.fn() };

    const { ingested } = await ingestMentions(ctx, neynar, OWN_FID, counter);

    expect(ingested).toBe(2);
    expect(counter.inc).toHaveBeenCalledTimes(2);
    expect(inserted.map((r) => r.castHash).sort()).toEqual(['0xmention1', '0xreply1']);
    const mention = inserted.find((r) => r.castHash === '0xmention1')!;
    expect(mention).toMatchObject({
      kind: 'mention',
      authorFid: 111,
      authorUsername: 'alice',
      parentHash: null,
      threadRootHash: '0xroot1',
      status: 'new',
    });
    const reply = inserted.find((r) => r.castHash === '0xreply1')!;
    expect(reply).toMatchObject({ kind: 'reply', parentHash: '0xourcast', threadRootHash: '0xourcast' });
  });

  it('re-poll of the same notifications inserts nothing (dedup on cast_hash PK)', async () => {
    const { ctx, inserted } = buildFakeDb(null);
    const neynar = fakeNeynar([MENTION, REPLY]);
    const counter = { inc: vi.fn() };

    const first = await ingestMentions(ctx, neynar, OWN_FID, counter);
    const second = await ingestMentions(ctx, neynar, OWN_FID, counter);

    expect(first.ingested).toBe(2);
    expect(second.ingested).toBe(0);
    expect(counter.inc).toHaveBeenCalledTimes(2);
    expect(inserted).toHaveLength(2);
  });

  it('skips a self-authored cast (no self-reply loop)', async () => {
    const { ctx, inserted } = buildFakeDb(null);
    const selfReply = { type: 'reply', cast: { hash: '0xself', author: { fid: OWN_FID, username: 'flashcastr' } } };
    const neynar = fakeNeynar([selfReply]);

    const { ingested } = await ingestMentions(ctx, neynar, OWN_FID);

    expect(ingested).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it('falls back to fid:<n> username and cast.hash thread root when fields missing', async () => {
    const { ctx, inserted } = buildFakeDb(null);
    const sparse = { type: 'mention', cast: { hash: '0xsparse', text: 'hi', author: { fid: 444 } } };
    const neynar = fakeNeynar([sparse]);

    await ingestMentions(ctx, neynar, OWN_FID);

    expect(inserted[0]).toMatchObject({
      castHash: '0xsparse',
      authorUsername: 'fid:444',
      threadRootHash: '0xsparse',
    });
  });
});

describe('persistMention', () => {
  function persistDb() {
    const seen = new Set<string>();
    const inserted: Array<Record<string, unknown>> = [];
    const agentDb = {
      insert: () => ({
        values: (row: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              const hash = row.castHash as string;
              if (seen.has(hash)) return [];
              seen.add(hash);
              inserted.push(row);
              return [{ castHash: hash }];
            },
          }),
        }),
      }),
    } as never;
    return { agentDb, inserted };
  }

  const ROW = {
    castHash: '0xpm1',
    authorFid: 7,
    authorUsername: 'carol',
    parentHash: null,
    threadRootHash: '0xpm1',
    text: 'gm',
    kind: 'mention' as const,
  };

  it('inserts a new row, returns true, bumps the counter once', async () => {
    const { agentDb, inserted } = persistDb();
    const counter = { inc: vi.fn() };

    expect(await persistMention(agentDb, ROW, counter)).toBe(true);
    expect(counter.inc).toHaveBeenCalledTimes(1);
    expect(inserted[0]).toMatchObject({ castHash: '0xpm1', kind: 'mention', status: 'new' });
  });

  it('re-persisting the same cast_hash returns false, no counter (PK dedup)', async () => {
    const { agentDb } = persistDb();
    const counter = { inc: vi.fn() };

    expect(await persistMention(agentDb, ROW, counter)).toBe(true);
    expect(await persistMention(agentDb, ROW, counter)).toBe(false);
    expect(counter.inc).toHaveBeenCalledTimes(1);
  });
});

describe('resolveOwnFid', () => {
  it('returns the account when the @flashcastr row exists', async () => {
    const { ctx } = buildFakeDb({ fid: OWN_FID, handle: 'flashcastr' });
    expect(await resolveOwnFid(ctx)).toEqual({ fid: OWN_FID, handle: 'flashcastr' });
  });

  it('returns null when no account row is seeded', async () => {
    const { ctx } = buildFakeDb(null);
    expect(await resolveOwnFid(ctx)).toBeNull();
  });
});

describe('buildThreadContext', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('assembles the parent/reply chain into a context string', async () => {
    const neynar = {
      lookupCastConversation: vi.fn(async () => ({
        conversation: {
          cast: {
            author: { username: 'alice' },
            text: 'is this PA_1099?',
            direct_replies: [
              { author: { username: 'bob' }, text: 'looks like it', direct_replies: [] },
            ],
          },
        },
      })),
    };

    const ctxStr = await buildThreadContext(neynar, '0xroot1');

    expect(ctxStr).toBe('@alice: is this PA_1099?\n@bob: looks like it');
  });

  it('returns null when the lookup throws', async () => {
    const neynar = {
      lookupCastConversation: vi.fn(async () => {
        throw new Error('neynar 500');
      }),
    };

    expect(await buildThreadContext(neynar, '0xroot1')).toBeNull();
  });
});
