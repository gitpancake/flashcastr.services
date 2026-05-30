export type DayPhase = 'pre-morning' | 'morning' | 'midday' | 'afternoon' | 'evening' | 'night';

/** Parse "HH:MM" to hour number. Returns fallback on invalid input. */
export function parseTimeHour(time: string | undefined, fallback: number): number {
  if (!time) return fallback;
  const hour = parseInt(time.split(':')[0], 10);
  return isNaN(hour) ? fallback : hour;
}

export interface RoutineAnchors {
  wakeTime?: string;       // "HH:MM", default "07:00"
  lunchTime?: string;      // "HH:MM", default "12:00"
  dinnerTime?: string;     // "HH:MM", default "18:00"
}

/**
 * Map the current hour to a day phase based on the user's routine.
 * All agents use this instead of configurable hour settings.
 */
export function getDayPhase(anchors: RoutineAnchors, currentHour: number): DayPhase {
  const wake = parseTimeHour(anchors.wakeTime, 7);
  const lunch = parseTimeHour(anchors.lunchTime, 12);
  const dinner = parseTimeHour(anchors.dinnerTime, 18);

  if (currentHour < wake) return 'pre-morning';
  if (currentHour < lunch) return 'morning';
  if (currentHour < lunch + 2) return 'midday';
  if (currentHour < dinner) return 'afternoon';
  if (currentHour < dinner + 3) return 'evening';
  return 'night';
}

/** Build RoutineAnchors from agent settings map. */
export function anchorsFromSettings(settings: Record<string, string>): RoutineAnchors {
  return {
    wakeTime: settings.wake_time,
    lunchTime: settings.lunch_time,
    dinnerTime: settings.dinner_time,
  };
}
