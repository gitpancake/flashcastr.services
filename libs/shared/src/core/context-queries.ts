import { eq, and, gte, lte, asc } from 'drizzle-orm';
import { calendarEvents, weatherForecasts } from '../db/schema.js';
import { getDayBoundsUTC } from '../config/timezone.js';
import { isHomeLocation } from '../config/locations.js';

interface CalendarEvent {
  title: string;
  startTime: string;
  endTime: string;
}

interface HomeWeather {
  tempMax: number;
  weatherCode: number;
  precipitation: number;
}

/** Fetch today's calendar events formatted with timezone-correct times. */
export async function getTodaysCalendarEvents(
  db: any,
  today: string,
  timezone: string,
  limit = 10,
): Promise<CalendarEvent[]> {
  try {
    const { dayStart, dayEnd } = getDayBoundsUTC(today, timezone);
    const events = await db
      .select({
        title: calendarEvents.title,
        startTime: calendarEvents.startTime,
        endTime: calendarEvents.endTime,
      })
      .from(calendarEvents)
      .where(and(gte(calendarEvents.startTime, dayStart), lte(calendarEvents.startTime, dayEnd)))
      .orderBy(asc(calendarEvents.startTime))
      .limit(limit);

    return events.map((e: any) => ({
      title: e.title,
      startTime: e.startTime.toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }),
      endTime: e.endTime.toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }),
    }));
  } catch {
    return [];
  }
}

/** Fetch today's home-location weather forecast. */
export async function getHomeWeather(
  db: any,
  today: string,
): Promise<HomeWeather | null> {
  try {
    const forecasts = await db
      .select({
        tempMax: weatherForecasts.tempMax,
        weatherCode: weatherForecasts.weatherCode,
        precipitation: weatherForecasts.precipitation,
        location: weatherForecasts.location,
      })
      .from(weatherForecasts)
      .where(eq(weatherForecasts.forecastDate, today))
      .limit(10);
    const home = forecasts.find((f: any) => isHomeLocation(f.location));
    if (!home) return null;
    return { tempMax: home.tempMax, weatherCode: home.weatherCode, precipitation: home.precipitation };
  } catch {
    return null;
  }
}
