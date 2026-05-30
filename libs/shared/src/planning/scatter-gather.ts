import { loadUserContext } from '../core/context-store.js';
import { TIMESLOT_DEFAULTS } from '../events/types.js';
import type { PlanRequestPayload, PlanContributionPayload } from '../events/types.js';

const CONTEXT_DOMAINS = new Set(['weather', 'calendar', 'fi', 'football']);

/**
 * Build the base PlanRequest by loading user context from OV.
 * Determines day type (weekday/weekend), sets time blocks, parses goals.
 */
export async function buildPlanRequest(today: string): Promise<PlanRequestPayload> {
  const userCtx = await loadUserContext();

  const dayOfWeek = new Date(today + 'T12:00:00Z').getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  const timeBlocks: PlanRequestPayload['timeBlocks'] = isWeekend
    ? [
        { start: '09:00', end: '12:00', category: 'flexible' as const },
        { start: '12:00', end: '13:00', category: 'physical' as const, label: 'midday activity' },
        { start: '13:00', end: '17:00', category: 'flexible' as const },
        { start: '17:00', end: '19:00', category: 'errand' as const },
      ]
    : [
        { start: '09:00', end: '12:00', category: 'focus' as const, label: 'morning coding' },
        { start: '12:00', end: '13:00', category: 'physical' as const, label: 'midday walk' },
        { start: '13:00', end: '17:00', category: 'focus' as const, label: 'afternoon coding' },
        { start: '17:00', end: '18:00', category: 'errand' as const },
        { start: '18:00', end: '19:00', category: 'afk' as const, label: 'evening wind-down' },
      ];

  const goals: Record<string, string[]> = {};
  for (const [domain, content] of Object.entries(userCtx.goals)) {
    goals[domain] = content
      .split('\n')
      .map(l => l.replace(/^[-*] /, '').trim())
      .filter(l => l && !l.startsWith('#'));
  }

  return {
    date: today,
    dayType: isWeekend ? 'weekend' : 'weekday',
    timeslots: { ...TIMESLOT_DEFAULTS },
    timeBlocks,
    fixedCommitments: [],
    goals,
    priorities: userCtx.constraints ? ['Check /user/constraints.md for health constraints'] : undefined,
    notes: userCtx.tools ?? undefined,
  };
}

/**
 * Extract world context (weather, calendar, pet, football) from context-provider contributions.
 */
export function extractWorldContext(
  contributions: PlanContributionPayload[],
): NonNullable<PlanRequestPayload['worldContext']> {
  const worldContext: NonNullable<PlanRequestPayload['worldContext']> = {};
  const contextContributions = contributions.filter(c => CONTEXT_DOMAINS.has(c.domain));

  for (const c of contextContributions) {
    if (c.domain === 'weather' && c.domainContext?.forecast) worldContext.weather = c.domainContext.forecast;
    if (c.domain === 'calendar' && c.domainContext?.fixedCommitments) worldContext.calendar = c.domainContext.fixedCommitments;
    if (c.domain === 'fi' && c.domainContext?.pet) worldContext.pet = c.domainContext.pet;
    if (c.domain === 'football' && c.domainContext?.matches) worldContext.football = c.domainContext.matches;
  }

  return worldContext;
}
