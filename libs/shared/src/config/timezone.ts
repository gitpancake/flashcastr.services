import { userSettings } from '../db/schema.js';

/** Default timezone — must match the seed value in scripts/startup.ts */
export const DEFAULT_TIMEZONE = 'America/Vancouver';

export function getUserToday(timezone: string): string {
  return formatUserDate(new Date(), timezone);
}

/** Format an arbitrary Date as a YYYY-MM-DD string in the user's timezone.
 *  Use this instead of ad-hoc toLocaleDateString('en-CA', ...) calls. */
export function formatUserDate(date: Date, timezone: string): string {
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
}

export function getUserHour(timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hourCycle: 'h23',
  });
  return parseInt(formatter.format(new Date()), 10);
}

/** Returns UTC Date objects representing start and end of a day in the given timezone.
 *  Useful for querying timestamp-with-timezone columns by local day boundaries. */
export function getDayBoundsUTC(
  dateStr: string,
  timezone: string
): { dayStart: Date; dayEnd: Date } {
  // Use noon UTC as reference to avoid DST boundary edge cases
  const noonUTC = new Date(`${dateStr}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = fmt.formatToParts(noonUTC);
  const get = (type: string) =>
    parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);

  // Calculate offset: what time is it locally when it's noon UTC?
  let offsetMin = (get('hour') % 24) * 60 + get('minute') - 720;

  // Adjust for day boundary (handles month/year rollovers)
  const localDateNum = get('year') * 10000 + get('month') * 100 + get('day');
  const utcDateNum =
    noonUTC.getUTCFullYear() * 10000 +
    (noonUTC.getUTCMonth() + 1) * 100 +
    noonUTC.getUTCDate();
  if (localDateNum > utcDateNum) offsetMin += 1440;
  else if (localDateNum < utcDateNum) offsetMin -= 1440;

  // Midnight local in UTC = midnight UTC minus the timezone offset
  const dayStart = new Date(
    new Date(`${dateStr}T00:00:00Z`).getTime() - offsetMin * 60_000
  );
  const dayEnd = new Date(dayStart.getTime() + 86_400_000 - 1);
  return { dayStart, dayEnd };
}

/** Known user setting keys with their expected values */
export interface UserSettingsMap {
  timezone: string;
  address: string;
  location_label: string;
  latitude: string;
  longitude: string;
  name: string;
  dinner_time: string;
  sleep_time: string;
  wake_time: string;
  recipe_notify_hours: string;
  email_relevance_threshold: string;
  units: string;
  [key: string]: string; // allow additional dynamic keys
}

export async function loadUserSettings(db: any): Promise<UserSettingsMap> {
  const rows = await db.select().from(userSettings);
  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings as UserSettingsMap;
}
