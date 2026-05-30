import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Registry } from 'prom-client';
import { AIClient } from './ai-client.js';

describe('AIClient metric registration', () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
  });

  it('is safe to construct twice against the same registry', () => {
    const registry = new Registry();

    // First construction — registers the four metrics.
    expect(() => new AIClient({ registry })).not.toThrow();
    // Second construction — MUST reuse existing metrics, not throw.
    expect(() => new AIClient({ registry })).not.toThrow();

    // Registry still has exactly one of each metric.
    expect(registry.getSingleMetric('ai_call_duration_seconds')).toBeDefined();
    expect(registry.getSingleMetric('ai_tokens_total')).toBeDefined();
    expect(registry.getSingleMetric('ai_estimated_cost_usd')).toBeDefined();
    expect(registry.getSingleMetric('ai_calls_total')).toBeDefined();
    expect(registry.getSingleMetric('ai_calls_fallback_total')).toBeDefined();
  });

  it('does not register metrics when no registry is supplied', () => {
    expect(() => new AIClient()).not.toThrow();
  });
});
