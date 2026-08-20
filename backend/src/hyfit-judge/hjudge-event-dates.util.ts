/**
 * The two calendar days an operational event runs on.
 *
 * `hyfit_v2.events` carries the span as `event_date` (Day 1) and
 * `event_end_date` (the last day, NULL when there is only one). Both are plain
 * `YYYY-MM-DD` strings everywhere they cross a wire — a `date` is a day, not an
 * instant, and putting one through a Date constructor is what turns a Saturday
 * event into a Friday one for every reader east of UTC.
 *
 * Two writers set them (create and update, both in HjudgeAdminService) and both
 * must agree on what a one-day event looks like in the database, or the list
 * screens end up rendering "15 Aug – 15 Aug".
 */

/** A calendar day as the database and every API here spell it. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDay(value: unknown): value is string {
  return typeof value === 'string' && DAY.test(value.trim());
}

/**
 * The value to store in `event_end_date`.
 *
 * NULL for a single-day event, and that includes a form that sent the same day
 * twice — a date picker left on its default, or an organiser filling both
 * fields because both were on screen. "Ends on the day it starts" and "has no
 * second day" are the same fact, and storing it two ways means every reader has
 * to know both. One shape: NULL.
 *
 * An end BEFORE the start is not silently swapped or dropped — it is a typo the
 * operator must see, so it is returned as given and left to
 * `hyfit_v2_events_date_span_check` and the caller's own validation.
 */
export function normaliseEndDate(
  start: string | null | undefined,
  end: string | null | undefined,
): string | null {
  const from = typeof start === 'string' ? start.trim() : '';
  const to = typeof end === 'string' ? end.trim() : '';
  if (!to) return null;
  if (!from) return null;
  return to === from ? null : to;
}

/**
 * Why this pair of dates cannot be stored, or `null` if it can.
 *
 * Said as a sentence an organiser can act on. The CHECK constraint says the
 * same thing in the shape of a constraint name, which is not a message anybody
 * should be shown.
 */
export function eventDateError(
  start: string | null | undefined,
  end: string | null | undefined,
): string | null {
  const from = typeof start === 'string' ? start.trim() : '';
  const to = typeof end === 'string' ? end.trim() : '';
  if (from && !isCalendarDay(from)) return 'Day 1 must be a date (YYYY-MM-DD)';
  if (to && !isCalendarDay(to))
    return 'The last day must be a date (YYYY-MM-DD)';
  if (to && !from) return 'An event with a last day needs a Day 1 as well';
  if (from && to && to < from) return 'The last day cannot be before Day 1';
  return null;
}

/**
 * How many days the event runs. 1 when there is no second day, and 1 for an
 * event with no dates at all — an event always happens on some number of days,
 * and 0 would read as "cancelled".
 */
export function eventDayCount(
  start: string | null | undefined,
  end: string | null | undefined,
): number {
  if (!isCalendarDay(start) || !isCalendarDay(end)) return 1;
  const from = Date.UTC(
    +start.slice(0, 4),
    +start.slice(5, 7) - 1,
    +start.slice(8, 10),
  );
  const to = Date.UTC(
    +end.slice(0, 4),
    +end.slice(5, 7) - 1,
    +end.slice(8, 10),
  );
  // UTC on both sides on purpose: local arithmetic across a DST boundary is off
  // by an hour, and an off-by-an-hour day count is off by a day.
  const days = Math.round((to - from) / 86_400_000) + 1;
  return days > 0 ? days : 1;
}
