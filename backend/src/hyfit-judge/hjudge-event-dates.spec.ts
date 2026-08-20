import {
  eventDateError,
  eventDayCount,
  isCalendarDay,
  normaliseEndDate,
} from './hjudge-event-dates.util';

describe('normaliseEndDate', () => {
  it('keeps the second day of a two-day edition', () => {
    expect(normaliseEndDate('2026-08-15', '2026-08-16')).toBe('2026-08-16');
  });

  it('stores a single-day event as one date, however the form spelled it', () => {
    // Blank, absent, and "the same day again" are one fact — the event runs on
    // one day — and they must not reach the database as three different rows,
    // or the list screens render "15 - 15 Aug" for some of them.
    expect(normaliseEndDate('2026-08-15', '')).toBeNull();
    expect(normaliseEndDate('2026-08-15', null)).toBeNull();
    expect(normaliseEndDate('2026-08-15', undefined)).toBeNull();
    expect(normaliseEndDate('2026-08-15', '2026-08-15')).toBeNull();
  });

  it('refuses to invent a span with no beginning', () => {
    expect(normaliseEndDate('', '2026-08-16')).toBeNull();
  });

  it('hands a backwards span through rather than swapping it', () => {
    // A typo the operator has to see. Silently reordering it would store dates
    // nobody typed.
    expect(normaliseEndDate('2026-08-16', '2026-08-15')).toBe('2026-08-15');
  });
});

describe('eventDateError', () => {
  it('accepts the shapes an event can actually be in', () => {
    expect(eventDateError(null, null)).toBeNull();
    expect(eventDateError('2026-08-15', null)).toBeNull();
    expect(eventDateError('2026-08-15', '2026-08-15')).toBeNull();
    expect(eventDateError('2026-08-15', '2026-08-16')).toBeNull();
  });

  it('names what is wrong in words an organiser can act on', () => {
    expect(eventDateError(null, '2026-08-16')).toMatch(/Day 1/);
    expect(eventDateError('2026-08-16', '2026-08-15')).toMatch(/before Day 1/);
    expect(eventDateError('15/08/2026', null)).toMatch(/YYYY-MM-DD/);
  });
});

describe('eventDayCount', () => {
  it('counts both ends of the span', () => {
    expect(eventDayCount('2026-08-15', '2026-08-16')).toBe(2);
    expect(eventDayCount('2026-08-15', '2026-08-17')).toBe(3);
  });

  it('counts a month and a year boundary as the days they are', () => {
    expect(eventDayCount('2026-08-31', '2026-09-01')).toBe(2);
    expect(eventDayCount('2026-12-31', '2027-01-01')).toBe(2);
  });

  it('is 1 for a single-day event and for an event with no dates', () => {
    expect(eventDayCount('2026-08-15', null)).toBe(1);
    expect(eventDayCount('2026-08-15', '2026-08-15')).toBe(1);
    expect(eventDayCount(null, null)).toBe(1);
    // Never 0 or negative: an event always happens on some number of days.
    expect(eventDayCount('2026-08-16', '2026-08-15')).toBe(1);
  });
});

describe('isCalendarDay', () => {
  it('is a day, not an instant', () => {
    expect(isCalendarDay('2026-08-15')).toBe(true);
    expect(isCalendarDay('2026-08-15T00:00:00.000Z')).toBe(false);
    expect(isCalendarDay(20260815)).toBe(false);
  });
});
