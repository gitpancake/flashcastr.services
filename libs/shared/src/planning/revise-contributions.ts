import type { AIClient } from '../core/ai-client.js';
import type {
  PlanAssembledPayload,
  PlanContributionPayload,
  PlanRequestPayload,
  Timeslot,
} from '../events/types.js';
import { TIMESLOT_DEFAULTS } from '../events/types.js';

export interface RevisionIssue {
  domain: string;
  feedback: string;
  slotConstraints?: {
    timeslot: Timeslot;
    availableMinutes: number;
    blockedBy: string[];
  };
}

/**
 * Ask AI to identify contributions that don't fit the assembled plan.
 * Returns a list of domains that need revision with targeted feedback.
 */
export async function identifyRevisionNeeds(
  assembled: PlanAssembledPayload,
  contributions: PlanContributionPayload[],
  request: PlanRequestPayload,
  ai: AIClient,
): Promise<RevisionIssue[]> {
  // Skip if the plan looks clean (all tasks scheduled, no obvious conflicts)
  const contributedDomains = new Set(contributions.map(c => c.domain));
  const scheduledDomains = new Set(assembled.tasks.map(t => t.domain));
  const droppedDomains = [...contributedDomains].filter(d => !scheduledDomains.has(d));

  // No dropped domains = plan fits, no revision needed
  if (droppedDomains.length === 0 && assembled.tasks.length > 0) return [];

  const slotUsage: Record<string, number> = {};
  for (const task of assembled.tasks) {
    slotUsage[task.timeslot] = (slotUsage[task.timeslot] ?? 0) + task.estimatedMinutes;
  }

  const result = await ai.completeJsonSafe<{
    issues: Array<{
      domain: string;
      feedback: string;
      timeslot?: string;
      availableMinutes?: number;
    }>;
  }>({
    task: 'classify',
    taskName: 'identify_revision_needs',
    maxTokens: 512,
    messages: [{
      role: 'user',
      content: `Review this daily plan assembly for fit issues.

## Assembled Plan
${JSON.stringify(assembled.tasks.map(t => ({
  title: t.title, domain: t.domain, timeslot: t.timeslot,
  startTime: t.startTime, minutes: t.estimatedMinutes,
})), null, 2)}

## Slot Usage (minutes used)
${Object.entries(slotUsage).map(([s, m]) => `${s}: ${m}min`).join('\n')}

## Slot Capacity
${Object.entries(TIMESLOT_DEFAULTS).map(([s, b]) => {
  const start = parseInt(b.start.split(':')[0]!) * 60 + parseInt(b.start.split(':')[1]!);
  const end = parseInt(b.end.split(':')[0]!) * 60 + parseInt(b.end.split(':')[1]!);
  return `${s}: ${end - start}min`;
}).join('\n')}

## Dropped Domains (contributed but no tasks scheduled)
${droppedDomains.length > 0 ? droppedDomains.join(', ') : 'none'}

## Original Contributions
${contributions.map(c => `${c.domain}: ${c.tasks.map(t => `"${t.title}" (${t.estimatedMinutes}min, ${t.priority})`).join(', ')}`).join('\n')}

Identify contributions that don't fit. Only flag REAL issues:
- Task too long for its target slot
- Task dropped entirely because of conflicts
- Must-do task displaced by lower priority items
- Timing conflict with calendar hard blocks

Respond with ONLY valid JSON, no markdown:
{
  "issues": [
    { "domain": "activity", "feedback": "3-hour hike doesn't fit the evening slot (only 2h available). Suggest a shorter activity under 2 hours.", "timeslot": "evening", "availableMinutes": 120 }
  ]
}

Return {"issues": []} if the plan looks good. Only flag must-do or should-do tasks. Dropping nice-to-have is fine.`,
    }],
  }, { issues: [] }, { wrapKey: 'issues' });

  return (result.issues ?? [])
    .filter(i => contributions.some(c => c.domain === i.domain))
    .map(i => ({
      domain: i.domain,
      feedback: i.feedback,
      slotConstraints: i.timeslot ? {
        timeslot: i.timeslot as Timeslot,
        availableMinutes: i.availableMinutes ?? 60,
        blockedBy: assembled.tasks
          .filter(t => t.timeslot === i.timeslot && t.domain !== i.domain)
          .map(t => t.title),
      } : undefined,
    }));
}
