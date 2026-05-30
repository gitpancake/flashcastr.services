import { describe, it, expect } from 'vitest';
import { getDayPhase, parseTimeHour } from './day-phase.js';

describe('parseTimeHour', () => {
  it('parses HH:MM format', () => {
    expect(parseTimeHour('07:30', 0)).toBe(7);
    expect(parseTimeHour('18:00', 0)).toBe(18);
    expect(parseTimeHour('00:00', 7)).toBe(0);
  });

  it('returns fallback for invalid input', () => {
    expect(parseTimeHour(undefined, 7)).toBe(7);
    expect(parseTimeHour('', 7)).toBe(7);
    expect(parseTimeHour('abc', 7)).toBe(7);
  });
});

describe('getDayPhase', () => {
  const defaults = {};

  it('returns pre-morning before wake time', () => {
    expect(getDayPhase(defaults, 5)).toBe('pre-morning');
    expect(getDayPhase(defaults, 6)).toBe('pre-morning');
  });

  it('returns morning from wake to lunch', () => {
    expect(getDayPhase(defaults, 7)).toBe('morning');
    expect(getDayPhase(defaults, 9)).toBe('morning');
    expect(getDayPhase(defaults, 11)).toBe('morning');
  });

  it('returns midday around lunch', () => {
    expect(getDayPhase(defaults, 12)).toBe('midday');
    expect(getDayPhase(defaults, 13)).toBe('midday');
  });

  it('returns afternoon between lunch+2 and dinner', () => {
    expect(getDayPhase(defaults, 14)).toBe('afternoon');
    expect(getDayPhase(defaults, 16)).toBe('afternoon');
    expect(getDayPhase(defaults, 17)).toBe('afternoon');
  });

  it('returns evening around dinner', () => {
    expect(getDayPhase(defaults, 18)).toBe('evening');
    expect(getDayPhase(defaults, 19)).toBe('evening');
    expect(getDayPhase(defaults, 20)).toBe('evening');
  });

  it('returns night late at night', () => {
    expect(getDayPhase(defaults, 21)).toBe('night');
    expect(getDayPhase(defaults, 23)).toBe('night');
  });

  it('uses custom anchors', () => {
    const earlyBird = { wakeTime: '05:00', lunchTime: '11:00', dinnerTime: '17:00' };
    expect(getDayPhase(earlyBird, 4)).toBe('pre-morning');
    expect(getDayPhase(earlyBird, 5)).toBe('morning');
    expect(getDayPhase(earlyBird, 11)).toBe('midday');
    expect(getDayPhase(earlyBird, 17)).toBe('evening');
  });

  it('handles settings-style input', () => {
    const fromSettings = { wakeTime: '06:00', dinnerTime: '19:00' };
    expect(getDayPhase(fromSettings, 5)).toBe('pre-morning');
    expect(getDayPhase(fromSettings, 6)).toBe('morning');
    expect(getDayPhase(fromSettings, 19)).toBe('evening');
  });
});
