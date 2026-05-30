import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyInboundIntent } from './correction-intent.js';

function fakeAi(impl: () => unknown) {
  return { completeJson: vi.fn(async () => impl()) } as any;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('classifyInboundIntent', () => {
  it('classifies a factual correction and extracts the structured fields', async () => {
    const ai = fakeAi(() => ({
      kind: 'correction',
      correction: { wrongClaim: 'FTBL is football', correctFact: 'FTBL is Fontainebleau' },
      reasoning: 'author contradicts the FTBL expansion',
    }));

    const intent = await classifyInboundIntent(ai, 'FTBL is Fontainebleau not football mate', null);

    expect(intent.kind).toBe('correction');
    expect(intent.correction).toEqual({ wrongClaim: 'FTBL is football', correctFact: 'FTBL is Fontainebleau' });
  });

  it('classifies a question with no correction payload', async () => {
    const ai = fakeAi(() => ({ kind: 'question', correction: null, reasoning: 'just asking' }));

    const intent = await classifyInboundIntent(ai, 'is PA_1099 still up?', null);

    expect(intent.kind).toBe('question');
    expect(intent.correction).toBeNull();
  });

  it('classifies behavioural guidance', async () => {
    const ai = fakeAi(() => ({ kind: 'guidance', correction: null, reasoning: 'future behaviour rule' }));

    const intent = await classifyInboundIntent(ai, 'stop using so many emoji', null);

    expect(intent.kind).toBe('guidance');
    expect(intent.correction).toBeNull();
  });

  it('degrades a correction without both fields to question (nothing to persist)', async () => {
    const ai = fakeAi(() => ({ kind: 'correction', correction: { wrongClaim: 'x' }, reasoning: 'partial' }));

    const intent = await classifyInboundIntent(ai, 'thats wrong', null);

    expect(intent.kind).toBe('question');
    expect(intent.correction).toBeNull();
  });

  it('degrades an unknown kind to question', async () => {
    const ai = fakeAi(() => ({ kind: 'banter', correction: null, reasoning: 'n/a' }));

    const intent = await classifyInboundIntent(ai, 'lol nice', null);

    expect(intent.kind).toBe('question');
  });

  it('returns the safe question default when the classifier throws', async () => {
    const ai = { completeJson: vi.fn(async () => { throw new Error('api 500'); }) } as any;

    const intent = await classifyInboundIntent(ai, 'anything', null);

    expect(intent.kind).toBe('question');
    expect(intent.correction).toBeNull();
  });
});
