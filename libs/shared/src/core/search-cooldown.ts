import { getSyncToken, updateSyncToken } from './sync-state.js';

const SYNC_KEY_PREFIX = 'last_web_search';

/**
 * Check if enough time has elapsed since the last web search for this agent.
 * Returns true if a search is allowed (cooldown elapsed or never searched).
 */
export async function canWebSearch(
  agentDb: any,
  processName: string,
  cooldownHours: number,
): Promise<boolean> {
  const key = `${processName}:${SYNC_KEY_PREFIX}`;
  const lastSearchAt = await getSyncToken(agentDb, key);
  if (!lastSearchAt) return true;

  const hoursSince = (Date.now() - new Date(lastSearchAt).getTime()) / 3_600_000;
  return hoursSince >= cooldownHours;
}

/**
 * Record that a web search was just performed.
 */
export async function markWebSearchDone(
  agentDb: any,
  processName: string,
): Promise<void> {
  const key = `${processName}:${SYNC_KEY_PREFIX}`;
  await updateSyncToken(agentDb, key, new Date().toISOString());
}
