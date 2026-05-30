import { eq } from 'drizzle-orm';
import { processSyncState } from '../db/schema.js';
import { getUserToday } from '../config/timezone.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getSyncToken(db: any, processName: string): Promise<string | null> {
  const [state] = await db
    .select()
    .from(processSyncState)
    .where(eq(processSyncState.processName, processName))
    .limit(1);
  return state?.syncToken ?? null;
}

export async function updateSyncToken(db: any, processName: string, token: string): Promise<void> {
  await db
    .insert(processSyncState)
    .values({ processName, syncToken: token, lastSyncAt: new Date() })
    .onConflictDoUpdate({
      target: processSyncState.processName,
      set: { syncToken: token, lastSyncAt: new Date() },
    });
}

/**
 * Check if a daily flag has been set for today.
 * Uses a compound key `{processName}:{flag}` in the process_sync_state table,
 * with the sync_token storing today's date string.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getDailyFlag(db: any, processName: string, flag: string, timezone: string): Promise<boolean> {
  const key = `${processName}:${flag}`;
  const token = await getSyncToken(db, key);
  const today = getUserToday(timezone);
  return token === today;
}

/**
 * Set a daily flag for today.
 * Stores today's date as the sync token under key `{processName}:{flag}`.
 * Automatically resets on a new day since the date comparison in getDailyFlag will fail.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function setDailyFlag(db: any, processName: string, flag: string, timezone: string): Promise<void> {
  const key = `${processName}:${flag}`;
  const today = getUserToday(timezone);
  await updateSyncToken(db, key, today);
}

export interface WatchConfig {
  expiration: number;
  renewalWindowMs?: number;
  onRenew: () => Promise<{ expiration: number }>;
  label: string;
}

/** Check if watch needs renewal (within renewalWindow of expiry) and renew if so. Returns new expiration. */
export async function checkAndRenewWatch(config: WatchConfig): Promise<number> {
  const window = config.renewalWindowMs ?? 24 * 60 * 60 * 1000;
  if (config.expiration > 0 && Date.now() > config.expiration - window) {
    try {
      const { expiration } = await config.onRenew();
      console.log(`${config.label} watch renewed, expires: ${new Date(expiration).toISOString()}`);
      return expiration;
    } catch (error) {
      console.error(`Failed to renew ${config.label} watch:`, error);
    }
  }
  return config.expiration;
}
