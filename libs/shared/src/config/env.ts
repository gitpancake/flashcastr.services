import 'dotenv/config';

export function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/** Claude model IDs — overridable via env for model upgrades without redeploy */
export const CLAUDE_MODEL_OPUS = process.env.CLAUDE_MODEL_OPUS ?? 'claude-opus-4-7';
export const CLAUDE_MODEL_SONNET = process.env.CLAUDE_MODEL_SONNET ?? 'claude-sonnet-4-20250514';
export const CLAUDE_MODEL_HAIKU = process.env.CLAUDE_MODEL_HAIKU ?? 'claude-haiku-4-5-20251001';
