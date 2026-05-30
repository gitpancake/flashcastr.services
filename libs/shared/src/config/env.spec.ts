import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getRequiredEnv } from './env.js';

describe('env config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('getRequiredEnv returns value when set', () => {
    process.env.TEST_VAR = 'hello';
    expect(getRequiredEnv('TEST_VAR')).toBe('hello');
  });

  it('getRequiredEnv throws when not set', () => {
    delete process.env.TEST_VAR;
    expect(() => getRequiredEnv('TEST_VAR')).toThrow(
      'Missing required environment variable: TEST_VAR'
    );
  });
});
