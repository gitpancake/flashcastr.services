import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Must be set before importing the module under test
process.env.OPENVIKING_URL = 'http://openviking';

// ovReadDirect is private — test its retry behavior via readFromOV, which calls ovRead → ovReadDirect.
// The TTL cache is cleared in beforeEach so each test starts cold.
import * as contextStore from './context-store.js';

describe('ovReadDirect retry behaviour', () => {
  beforeEach(() => {
    // Reset TTL cache between tests so each test starts cold
    contextStore.invalidateContextCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries once after a transport error and returns content on success', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ result: 'hello' }), { status: 200 });
    }));

    const result = await contextStore.readFromOV('/test/path.md');

    expect(result).toBe('hello');
    expect(callCount).toBe(2);
  });

  it('exhausts all 3 attempts and returns null when every attempt throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      callCount++;
      throw new TypeError('fetch failed');
    }));

    const result = await contextStore.readFromOV('/test/flaky.md');

    expect(result).toBeNull();
    expect(callCount).toBe(3);
    // 3 warn calls: attempt 1 warn, attempt 2 warn, attempt 3 final warn
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('attempt 1/3'))).toBe(true);
    expect(warnSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('attempt 3/3'))).toBe(true);
  });
});
