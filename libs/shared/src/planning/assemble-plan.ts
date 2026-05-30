import type { PlanRequestPayload, PlanContributionPayload, PlanAssembledPayload, PlanTask, AssembledTask, Timeslot } from '../events/types.js';
import { TIMESLOT_ORDER, TIMESLOT_DEFAULTS } from '../events/types.js';
import type { AIClient } from '../core/ai-client.js';

const VALID_TIMESLOTS = new Set<string>(TIMESLOT_ORDER);
const TIME_RE = /^\d{2}:\d{2}$/;

/** Parse "HH:MM" into total minutes since midnight. */
function parseMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** Determine which timeslot a given "HH:MM" time falls into. */
function timeslotForTime(time: string, timeslots: Record<Timeslot, { start: string; end: string }>): Timeslot {
  const totalMin = parseMinutes(time);
  for (const slot of TIMESLOT_ORDER) {
    const { start, end } = timeslots[slot];
    if (totalMin >= parseMinutes(start) && totalMin < parseMinutes(end)) return slot;
  }
  // Falls outside all defined slots — assign to the last slot
  return TIMESLOT_ORDER[TIMESLOT_ORDER.length - 1];
}

/** Format total minutes since midnight back to "HH:MM", capping at 23:59. */
function formatMinutes(totalMinutes: number): string {
  const capped = Math.min(totalMinutes, 23 * 60 + 59);
  const h = Math.floor(capped / 60).toString().padStart(2, '0');
  const m = (capped % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Walk tasks within each timeslot and offset any item whose startTime equals
 * (or is earlier than) the end of the previous item. This ensures the AI can
 * never produce two tasks with an identical startTime.
 *
 * Calendar tasks (domain === 'calendar') are treated as pinned anchors — they
 * are never moved, but their time window advances `prevEndMinutes` so any
 * following generated task is pushed past the meeting end.
 *
 * Pure function — does not mutate the input array.
 */
function spreadStartTimeCollisions<T extends { timeslot: Timeslot; startTime: string; estimatedMinutes: number; domain?: string }>(
  tasks: T[],
): T[] {
  // Group by slot, preserving order within each slot
  const bySlot = new Map<Timeslot, T[]>();
  for (const task of tasks) {
    const bucket = bySlot.get(task.timeslot) ?? [];
    bucket.push(task);
    bySlot.set(task.timeslot, bucket);
  }

  const result: T[] = [];

  for (const slot of TIMESLOT_ORDER as Timeslot[]) {
    const slotTasks = bySlot.get(slot);
    if (!slotTasks || slotTasks.length === 0) continue;

    // Sort ascending so earliest task anchors the cascade
    const sorted = [...slotTasks].sort((a, b) => parseMinutes(a.startTime) - parseMinutes(b.startTime));

    // Walk forward: if item N+1 starts at or before item N ends, push it out.
    // Calendar tasks are pinned — always emit at their original startTime, but
    // their end time still advances prevEndMinutes so generated tasks yield.
    let prevEndMinutes = -Infinity;
    for (const task of sorted) {
      const isCalendar = task.domain === 'calendar';
      const start = isCalendar
        ? parseMinutes(task.startTime)
        : Math.max(parseMinutes(task.startTime), prevEndMinutes);
      prevEndMinutes = Math.max(prevEndMinutes, start + task.estimatedMinutes);
      result.push(start === parseMinutes(task.startTime) ? task : { ...task, startTime: formatMinutes(start) });
    }
  }

  return result;
}

interface FlatTask extends PlanTask {
  domain: string;
}

/**
 * Assemble a daily plan using AI to schedule tasks into structured timeslots
 * based on world context (weather, calendar, pet, football) and agent contributions.
 */
export async function assemblePlan(
  request: PlanRequestPayload,
  contributions: PlanContributionPayload[],
  ai: AIClient,
): Promise<PlanAssembledPayload> {
  // Flatten all tasks with domain attribution, expanding repeats
  const allTasks: FlatTask[] = [];
  for (const contribution of contributions) {
    for (const task of contribution.tasks) {
      const count = task.repeatCount ?? 1;
      for (let i = 0; i < count; i++) {
        allTasks.push({
          ...task,
          domain: contribution.domain,
          title: count > 1 ? `${task.title} (${i + 1}/${count})` : task.title,
          repeatCount: undefined,
        });
      }
    }
  }

  const briefings = contributions
    .filter(c => c.briefing)
    .map(c => `**${c.domain}**: ${c.briefing}`)
    .join('\n');

  if (allTasks.length === 0) {
    return {
      date: request.date,
      tasks: [],
      totalEstimatedMinutes: 0,
      domainCount: 0,
      summary: 'No agent contributions received.',
      overview: 'Quiet day — no tasks from any agents.',
    };
  }

  const slotDescriptions = TIMESLOT_ORDER
    .map(slot => {
      const bounds = request.timeslots[slot];
      return `- ${slot}: ${bounds.start} → ${bounds.end}`;
    })
    .join('\n');

  const calendarEvents = request.worldContext?.calendar ?? [];

  // All-day events (durationMinutes === 0 or >= 720) have no meaningful time window and would
  // produce NaN or misleading slot blocks — exclude them from all planning arithmetic.
  const timedEvents = calendarEvents.filter(e => e.durationMinutes > 0 && e.durationMinutes < 720);

  // Build explicit blocked-time list for the AI prompt so it never schedules
  // into a slot that has a meeting running through it.
  const calendarBlock = timedEvents.length
    ? timedEvents.map(e => {
        const timePart = e.time.slice(0, 5); // guard against ISO timestamps like "2026-04-22T09:00:00Z"
        const endTime = formatMinutes(parseMinutes(timePart) + e.durationMinutes);
        return `  ${timePart}–${endTime} ${e.title} (${e.category}) — DO NOT schedule any task during this window`;
      }).join('\n')
    : '  No events';

  const weatherBlock = request.worldContext?.weather
    ? `${request.worldContext.weather.tempMax}°C, ${request.worldContext.weather.description}, ${request.worldContext.weather.precipitation}mm rain`
    : 'unknown';

  const petBlock = request.worldContext?.pet
    ? `${request.worldContext.pet.name}: ${request.worldContext.pet.steps}/${request.worldContext.pet.stepGoal} steps, ${request.worldContext.pet.walkCount} walks so far`
    : null;

  const footballBlock = request.worldContext?.football?.length
    ? request.worldContext.football.map(m => `${m.homeTeam} vs ${m.awayTeam} at ${m.kickoff}`).join(', ')
    : null;

  const result = await ai.completeJsonSafe<{
    tasks: Array<{
      title: string;
      domain: string;
      timeslot: Timeslot;
      startTime: string;
      estimatedMinutes: number;
      priority: string;
      category: string;
      context: string;
    }>;
    summary: string;
    overview: string;
  }>({
    task: 'generate',
    taskName: 'assemble_daily_plan',
    maxTokens: 2048,
    messages: [{
      role: 'user',
      content: `Assemble a daily plan for ${request.date} (${request.dayType}).

## Timeslots
${slotDescriptions}

## Calendar (hard blocks — schedule around these)
${calendarBlock}

## World Context
Weather: ${weatherBlock}
${petBlock ? `Pet: ${petBlock}` : ''}
${footballBlock ? `Football: ${footballBlock}` : ''}

## Goals
${Object.entries(request.goals).map(([d, g]) => `${d}: ${g.join(', ')}`).join('\n')}
${request.profileContext ? `\n## About the User (from their profile)\n${request.profileContext}\n` : ''}
## Agent Briefings
${briefings}

## Available Tasks (from domain agents)
${JSON.stringify(allTasks.map(t => ({
  title: t.title, domain: t.domain, minutes: t.estimatedMinutes,
  priority: t.priority, category: t.category, context: t.context,
  timePreference: t.timePreference,
})), null, 2)}

## Instructions
Schedule tasks into the timeslots defined above. Each task gets a timeslot and a specific startTime (HH:MM).

Rules:
- Calendar events listed above are ABSOLUTE HARD BLOCKS. Every event has an exact time window (start–end). You MUST NOT place any generated task at a startTime that overlaps with any of those windows. Treat each window as completely unavailable.
- timePreference is a HARD slot constraint: if a task has timePreference 'breakfast', 'morning', 'midday', 'afternoon', or 'evening' and that slot has available capacity (calendar events do not fill it completely), you MUST place the task in that slot — never move it to a different slot. Only move a task out of its preferred slot if calendar blocks make the entire preferred slot unavailable.
- If a slot is full of meetings, shift flexible tasks to the next available slot
- Pet walks are must-do — place them when the dog needs steps
- Weather affects outdoor activities (rain → indoor alternatives)
- Football matches — free up time before/during
- Must-do tasks first, then should-do, drop nice-to-have if the day is packed
- Order tasks chronologically within each slot
- Do NOT include calendar events in your JSON response — they are injected separately

Also generate:
- summary: 1 sentence factual summary (e.g. "8 tasks across 5 domains, 4h estimated")
- overview: 2-4 sentence casual briefing as if from a personal assistant. Mention key meetings, weather, what's for dinner, any notable activities. Tone: practical, warm, not formal.

Respond with ONLY valid JSON, no markdown:
{
  "tasks": [
    { "title": "Task", "domain": "engine", "timeslot": "morning", "startTime": "08:30", "estimatedMinutes": 30, "priority": "must-do", "category": "physical", "context": "Brief context" }
  ],
  "summary": "...",
  "overview": "..."
}`,
    }],
  }, { tasks: [], summary: '', overview: '' });

  // Build a lookup from title→timePreference so we can enforce slot corrections post-assembly.
  // Title is unique enough here since we only use it to recover the hard constraint.
  const taskPreferenceByTitle = new Map<string, Timeslot>();
  for (const task of allTasks) {
    if (task.timePreference && VALID_TIMESLOTS.has(task.timePreference)) {
      taskPreferenceByTitle.set(task.title, task.timePreference as Timeslot);
    }
  }

  // Determine which timeslots are blocked by calendar events (any event in the slot counts as partial;
  // a slot is "completely blocked" only when calendar minutes >= slot duration).
  const blockedSlots = new Set<Timeslot>();
  if (timedEvents.length > 0) {
    const slotMinutes: Record<string, number> = {};
    for (const slot of TIMESLOT_ORDER) {
      const bounds = request.timeslots[slot];
      const [sh, sm] = bounds.start.split(':').map(Number);
      const [eh, em] = bounds.end.split(':').map(Number);
      slotMinutes[slot] = (eh * 60 + em) - (sh * 60 + sm);
    }
    const calMinutesPerSlot: Record<string, number> = {};
    for (const event of timedEvents) {
      // Use overlap minutes per slot so cross-slot events (e.g. a 4-hour meeting
      // starting in breakfast) correctly consume capacity in every slot they span.
      const timePart = event.time.slice(0, 5); // guard against ISO timestamps
      const [evH, evM] = timePart.split(':').map(Number);
      if (!Number.isFinite(evH) || !Number.isFinite(evM)) continue; // skip malformed times
      const evStart = evH * 60 + evM;
      const evEnd = evStart + event.durationMinutes;
      for (const slot of TIMESLOT_ORDER) {
        const bounds = request.timeslots[slot];
        const [sh, sm] = bounds.start.split(':').map(Number);
        const [eh, em] = bounds.end.split(':').map(Number);
        const slotStart = sh * 60 + sm;
        const slotEnd = eh * 60 + em;
        const overlap = Math.min(evEnd, slotEnd) - Math.max(evStart, slotStart);
        if (overlap > 0) {
          calMinutesPerSlot[slot] = (calMinutesPerSlot[slot] ?? 0) + overlap;
        }
      }
    }
    for (const slot of TIMESLOT_ORDER) {
      if ((calMinutesPerSlot[slot] ?? 0) >= slotMinutes[slot]) {
        blockedSlots.add(slot as Timeslot);
      }
    }
  }

  // Validate AI output — timeslot must be a known value, startTime must be HH:MM
  const assembledTasks: AssembledTask[] = (result.tasks ?? [])
    .filter(t => {
      if (!VALID_TIMESLOTS.has(t.timeslot)) {
        console.warn(`[planning] Dropping task "${t.title}" — invalid timeslot "${t.timeslot}"`);
        return false;
      }
      return true;
    })
    .map(t => {
      const preferredSlot = taskPreferenceByTitle.get(t.title);
      // Enforce timePreference: if the AI ignored it and the preferred slot isn't fully blocked, correct it.
      const correctedSlot = (
        preferredSlot &&
        t.timeslot !== preferredSlot &&
        !blockedSlots.has(preferredSlot)
      ) ? preferredSlot : (t.timeslot as Timeslot);

      if (correctedSlot !== t.timeslot) {
        console.warn(`[planning] Correcting task "${t.title}" from slot "${t.timeslot}" → "${correctedSlot}" (timePreference enforcement)`);
      }

      const slotDefaults = TIMESLOT_DEFAULTS[correctedSlot];
      return {
        title: t.title,
        domain: t.domain,
        timeslot: correctedSlot,
        startTime: TIME_RE.test(t.startTime) && correctedSlot === t.timeslot
          ? t.startTime
          : slotDefaults.start,
        estimatedMinutes: t.estimatedMinutes,
        priority: t.priority as PlanTask['priority'],
        category: t.category as PlanTask['category'],
        context: t.context,
      };
    });

  // Inject timed calendar events as fixed AssembledTask entries so they appear in
  // the plan output (and flow through to display-sync / Notion) at their
  // exact scheduled times. All-day events were excluded from timedEvents above.
  // These are never displaced or reordered.
  const calendarTasks: AssembledTask[] = timedEvents.map(e => ({
    title: e.title,
    domain: 'calendar',
    timeslot: timeslotForTime(e.time.slice(0, 5), request.timeslots),
    startTime: e.time.slice(0, 5),
    estimatedMinutes: e.durationMinutes,
    priority: 'must-do',
    category: 'meeting',
    context: e.category,
  }));

  if (calendarTasks.length > 0) {
    console.log(`[planning] Injected ${calendarTasks.length} calendar event(s) as fixed tasks: ${calendarTasks.map(t => t.title).join(', ')}`);
  }

  // Deterministic collision fix: the AI may assign identical startTimes to
  // multiple tasks (e.g., both gym and activity landing at "16:00"). Sort
  // within each slot and cascade offsets so no two tasks share a startTime.
  const spreadTasks = spreadStartTimeCollisions([...calendarTasks, ...assembledTasks]);

  if (spreadTasks.length === 0 && allTasks.length > 0) {
    console.warn(`[planning] Plan assembly returned 0 tasks despite ${allTasks.length} contributed tasks — AI may have failed`);
  }

  // assembledTasks only contains AI-generated tasks; calendar tasks are always valid.
  const droppedCount = (result.tasks?.length ?? 0) - assembledTasks.length;
  if (droppedCount > 0) {
    console.warn(`[planning] Dropped ${droppedCount} AI tasks with invalid timeslots`);
  }

  const uniqueDomains = new Set(spreadTasks.map(t => t.domain));

  if (!result.overview) {
    console.warn('[planning] AI did not return an overview paragraph');
  }

  return {
    date: request.date,
    tasks: spreadTasks,
    totalEstimatedMinutes: spreadTasks.reduce((sum, t) => sum + t.estimatedMinutes, 0),
    domainCount: uniqueDomains.size,
    summary: result.summary || `${spreadTasks.length} tasks across ${uniqueDomains.size} domains.`,
    overview: result.overview || `${spreadTasks.length} tasks planned for the day.`,
  };
}
