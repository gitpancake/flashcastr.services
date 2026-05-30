import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { assessRelevance, factCheckCorrection } from './correction-verify.js';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('assessRelevance', () => {
  it('returns relevant=true when the model says so', async () => {
    const ai = { completeJson: vi.fn(async () => ({ relevant: true, reasoning: 'invader ID claim' })) } as any;
    expect(await assessRelevance(ai, 'FTBL is football', 'FTBL is Fontainebleau')).toEqual({
      relevant: true,
      reasoning: 'invader ID claim',
    });
  });

  it('returns relevant=false when the model says so', async () => {
    const ai = { completeJson: vi.fn(async () => ({ relevant: false, reasoning: 'crypto banter' })) } as any;
    expect(await assessRelevance(ai, 'BTC is up', 'BTC is down')).toMatchObject({ relevant: false });
  });

  it('fails closed: relevant=false on AI error', async () => {
    const ai = { completeJson: vi.fn(async () => { throw new Error('api down'); }) } as any;
    expect(await assessRelevance(ai, 'x', 'y')).toMatchObject({ relevant: false });
  });

  it('fails closed: relevant=false when the model returns garbage', async () => {
    const ai = { completeJson: vi.fn(async () => ({ relevant: 'maybe' as any })) } as any;
    expect(await assessRelevance(ai, 'x', 'y')).toMatchObject({ relevant: false });
  });
});

describe('factCheckCorrection', () => {
  it('returns the model verdict when it is one of high|low|reject', async () => {
    const ai = {
      complete: vi.fn(async () => ({ text: JSON.stringify({ confidence: 'high', reasoning: 'two sources agree' }) })),
    } as any;
    expect(await factCheckCorrection(ai, 'wrong', 'right')).toEqual({
      confidence: 'high',
      reasoning: 'two sources agree',
    });
  });

  it('extracts JSON from prose-wrapped responses', async () => {
    const ai = {
      complete: vi.fn(async () => ({ text: 'Searched the web. Result: {"confidence":"reject","reasoning":"contradicted"} done.' })),
    } as any;
    expect((await factCheckCorrection(ai, 'a', 'b')).confidence).toBe('reject');
  });

  it('fails closed (low) when verdict is unknown', async () => {
    const ai = {
      complete: vi.fn(async () => ({ text: JSON.stringify({ confidence: 'sometimes', reasoning: 'mixed' }) })),
    } as any;
    expect((await factCheckCorrection(ai, 'a', 'b')).confidence).toBe('low');
  });

  it('fails closed (low) when JSON is unparseable', async () => {
    const ai = { complete: vi.fn(async () => ({ text: 'no json here' })) } as any;
    expect((await factCheckCorrection(ai, 'a', 'b')).confidence).toBe('low');
  });

  it('fails closed (low) on AI error', async () => {
    const ai = { complete: vi.fn(async () => { throw new Error('rate limit'); }) } as any;
    expect((await factCheckCorrection(ai, 'a', 'b')).confidence).toBe('low');
  });

  it('passes maxSearches into the web_search tool config', async () => {
    const ai = {
      complete: vi.fn(async (opts: any) => {
        expect(opts.tools[0].max_uses).toBe(3);
        return { text: JSON.stringify({ confidence: 'low', reasoning: '' }) };
      }),
    } as any;
    await factCheckCorrection(ai, 'a', 'b', 3);
    expect(ai.complete).toHaveBeenCalledOnce();
  });
});
