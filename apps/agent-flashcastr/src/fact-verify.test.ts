import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { needsVerification, verifyDraft } from './fact-verify.js';

function fakeAi(text: string) {
  return { complete: vi.fn(async () => ({ text })) } as any;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('needsVerification (cost gate)', () => {
  it('triggers when a known-code invader is named WITHOUT its resolved city (FTBL bug shape)', () => {
    expect(needsVerification('FTBL_46 got destroyed — football fans in mourning 👾')).toBe(true);
  });

  it('does NOT trigger when the resolved city is already present', () => {
    expect(needsVerification('FTBL_46 in Fontainebleau got destroyed 👾')).toBe(false);
  });

  it('does NOT trigger for an unknown code (nothing authoritative to contradict)', () => {
    expect(needsVerification('ZZZ_99 spotted somewhere')).toBe(false);
  });

  it('does NOT trigger for a cast with no invader ID at all', () => {
    expect(needsVerification('big news for the hunt today')).toBe(false);
  });
});

describe('verifyDraft', () => {
  it('skips the web_search entirely (verdict ok) when the gate does not trip', async () => {
    const ai = fakeAi('{"verdict":"reject"}'); // would reject if called
    const result = await verifyDraft(ai, 'PA_1099 in Paris is still up');
    expect(result).toEqual({ verdict: 'ok', text: 'PA_1099 in Paris is still up' });
    expect(ai.complete).not.toHaveBeenCalled();
  });

  it('returns corrected text when the model fixes a wrong location', async () => {
    const ai = fakeAi('here: {"verdict":"corrected","correctedText":"FTBL_46 in Fontainebleau got buffed 👾"}');
    const result = await verifyDraft(ai, 'FTBL_46 the football one got buffed 👾');
    expect(result.verdict).toBe('corrected');
    expect(result.text).toBe('FTBL_46 in Fontainebleau got buffed 👾');
    expect(ai.complete).toHaveBeenCalledTimes(1);
  });

  it('rejects when the model says reject', async () => {
    const ai = fakeAi('{"verdict":"reject"}');
    const result = await verifyDraft(ai, 'FTBL_46 football news 👾');
    expect(result.verdict).toBe('reject');
    expect(result.text).toBe('FTBL_46 football news 👾'); // original retained, caller drops it
  });

  it('treats a corrected verdict with no replacement as a reject (unsafe to ship)', async () => {
    const ai = fakeAi('{"verdict":"corrected"}');
    const result = await verifyDraft(ai, 'FTBL_46 football news 👾');
    expect(result.verdict).toBe('reject');
  });

  it('fails OPEN (verdict ok) when the AI call throws — never nukes the pipeline', async () => {
    const ai = { complete: vi.fn(async () => { throw new Error('network'); }) } as any;
    const result = await verifyDraft(ai, 'FTBL_46 football news 👾');
    expect(result).toEqual({ verdict: 'ok', text: 'FTBL_46 football news 👾' });
  });
});
