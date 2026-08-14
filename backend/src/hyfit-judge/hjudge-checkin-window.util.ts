/**
 * The check-in window: when a given athlete may be checked in.
 *
 * An event configures it once — "the counter opens four hours before an
 * athlete's slot" — and every entry gets its own window from its own timeslot.
 * A 04:00 slot opens at 00:00; a 10:00 slot opens at 06:00; the volunteer at
 * the desk never has to work that out.
 *
 * Two rules shape everything below, and both exist so that a policy about
 * queue management can never become a reason an athlete misses their race:
 *
 *   * An entry whose slot cannot be determined is NEVER blocked. A timeslot is
 *     a free-text label (070) — "Slot 3", "Fri AM", blank — and a label that
 *     says nothing about the clock is not evidence that the athlete is early.
 *   * The window closes only if the organiser asks it to. A late athlete is a
 *     Help Desk matter; refusing them at the counter by default would be the
 *     software inventing a rule the event never set.
 */

export interface CheckinWindowPolicy {
  enabled: boolean;
  /** Minutes before the slot at which the counter opens. */
  opensBeforeMinutes: number;
  /** Minutes after the slot at which it closes; null = it never closes. */
  closesAfterMinutes: number | null;
}

export interface SlotSource {
  /** `category_entries.timeslot` — the organiser's label for the slot. */
  timeslot?: string | null;
  /** `category_entries.start_time` — an absolute instant, when the roster has one. */
  startTime?: Date | string | null;
  /** `category_entries.contest_date` (072) — the DAY this entry is on the
   *  floor. It outranks the event's own date, which is the same thing only at
   *  a single-day event. */
  contestDate?: string | Date | null;
  /** `events.event_date` as YYYY-MM-DD: the day a bare "04:00" belongs to when
   *  the entry names no contest date of its own. */
  eventDate?: string | null;
  /** `events.starts_at`, the fallback for an event with no event_date. */
  eventStartsAt?: Date | string | null;
  /** `events.timezone` — the zone the label's clock time is written in. */
  timeZone: string;
}

export type CheckinWindowState =
  /** No window configured: check in whenever. */
  | 'off'
  /** Configured, but this entry has no slot the clock can be read from. */
  | 'no_slot'
  | 'early'
  | 'open'
  | 'late';

export interface CheckinWindow {
  state: CheckinWindowState;
  /** True unless the window is the reason to refuse — the only field callers must consult. */
  allowed: boolean;
  slotAt: string | null;
  opensAt: string | null;
  closesAt: string | null;
  /** Ready to show at the counter; empty when there is nothing to say. */
  message: string;
}

export const defaultCheckinWindowPolicy: CheckinWindowPolicy = {
  enabled: false,
  opensBeforeMinutes: 240,
  closesAfterMinutes: null,
};

const MINUTE = 60_000;

/**
 * Minutes past midnight for a timeslot label, or null when it names no clock
 * time. The label is searched rather than matched whole: organisers write
 * "Wave 2 · 09:40" as readily as "09:40", and the wave name is not a reason to
 * lose the time sitting next to it.
 *
 * A bare number is deliberately NOT a time. "Slot 3" and "3" mean the third
 * slot far more often than they mean 03:00, and reading them as a clock time
 * would silently place an athlete's window nine hours off.
 */
export function parseSlotMinutes(label: string | null | undefined): number | null {
  const text = String(label ?? '').trim();
  if (!text) return null;

  // "09:40", "9.40 pm", "16:30:00"
  const clock = /(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?/i.exec(text);
  if (clock) {
    return toMinutes(Number(clock[1]), Number(clock[2]), clock[3]);
  }

  // "4 AM", "4pm" — a meridiem makes a bare hour unambiguous.
  const meridiem = /(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)/i.exec(text);
  if (meridiem) {
    return toMinutes(Number(meridiem[1]), 0, meridiem[2]);
  }

  // "0940" — four digits are a time in every roster export that omits the colon.
  const compact = /(?:^|\D)(\d{4})(?:\D|$)/.exec(text);
  if (compact) {
    const value = compact[1];
    return toMinutes(Number(value.slice(0, 2)), Number(value.slice(2)), null);
  }

  return null;
}

function toMinutes(hour: number, minute: number, meridiem: string | null | undefined) {
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (minute > 59) return null;
  let hours = hour;
  if (meridiem) {
    const isPm = /^p/i.test(meridiem);
    if (hours < 1 || hours > 12) return null;
    if (hours === 12) hours = 0;
    if (isPm) hours += 12;
  } else if (hours > 23) {
    return null;
  }
  return hours * 60 + minute;
}

/** What the given instant reads as on a clock in `timeZone`, as UTC parts. */
function zoneParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value ?? '0');
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
    second: part('second'),
  };
}

function zoneOffsetMs(date: Date, timeZone: string) {
  const p = zoneParts(date, timeZone);
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
    date.getTime()
  );
}

/** The instant at which `minutes` past midnight on `isoDate` occurs in `timeZone`. */
export function zonedInstant(isoDate: string, minutes: number, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return null;
  const [, year, month, day] = match;
  const naive = Date.UTC(Number(year), Number(month) - 1, Number(day), 0, minutes);
  // Two passes: the first offset is read at the wrong instant when the zone
  // changes offset that day, and correcting once lands inside the new offset.
  let instant = new Date(naive - zoneOffsetMs(new Date(naive), timeZone));
  instant = new Date(naive - zoneOffsetMs(instant, timeZone));
  return instant;
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * When this entry is on the floor, as an instant — or null when nothing on the
 * row says. `start_time` wins: it is an actual timestamp the results spine
 * already trusts, where the timeslot is a label someone typed.
 */
export function resolveSlotAt(source: SlotSource): Date | null {
  const explicit = asDate(source.startTime);
  if (explicit) return explicit;

  const minutes = parseSlotMinutes(source.timeslot);
  if (minutes === null) return null;

  // Most specific day first. On a weekend event the entry's own contest date is
  // the only one of these that distinguishes Saturday's 09:40 from Sunday's,
  // and getting it wrong moves the whole window by a day.
  const timeZone = source.timeZone || 'Asia/Kolkata';
  const isoDate =
    normalizedDate(source.contestDate) ??
    normalizedDate(source.eventDate) ??
    localDate(asDate(source.eventStartsAt), timeZone);
  if (!isoDate) return null;

  return zonedInstant(isoDate, minutes, timeZone);
}

function normalizedDate(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // Local parts, not toISOString(): node-postgres turns a `date` column into
    // a Date at LOCAL midnight, and in any zone ahead of UTC the ISO form of
    // that instant is the DAY BEFORE — which would open every window 24 hours
    // early. Callers that select the column as text skip this path entirely.
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value).trim());
  return match ? match[1] : null;
}

function localDate(date: Date | null, timeZone: string): string | null {
  if (!date) return null;
  const p = zoneParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** "12:00 AM, Mon 10 Aug" in the event's own zone — the clock the desk reads. */
export function formatInZone(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

export function evaluateCheckinWindow(
  policy: CheckinWindowPolicy,
  source: SlotSource,
  now: Date = new Date(),
): CheckinWindow {
  const idle: CheckinWindow = {
    state: 'off',
    allowed: true,
    slotAt: null,
    opensAt: null,
    closesAt: null,
    message: '',
  };
  if (!policy.enabled) return idle;

  const timeZone = source.timeZone || 'Asia/Kolkata';
  const slotAt = resolveSlotAt(source);
  if (!slotAt) {
    return {
      ...idle,
      state: 'no_slot',
      message:
        'No timeslot on this entry, so no check-in window applies. Check the athlete in as normal.',
    };
  }

  const opensAt = new Date(slotAt.getTime() - policy.opensBeforeMinutes * MINUTE);
  const closesAt =
    policy.closesAfterMinutes === null
      ? null
      : new Date(slotAt.getTime() + policy.closesAfterMinutes * MINUTE);

  const window = {
    slotAt: slotAt.toISOString(),
    opensAt: opensAt.toISOString(),
    closesAt: closesAt ? closesAt.toISOString() : null,
  };

  if (now.getTime() < opensAt.getTime()) {
    return {
      ...window,
      state: 'early',
      allowed: false,
      message: `Too early: this athlete's slot is ${formatInZone(slotAt, timeZone)} and check-in opens ${formatInZone(opensAt, timeZone)}.`,
    };
  }
  if (closesAt && now.getTime() > closesAt.getTime()) {
    return {
      ...window,
      state: 'late',
      allowed: false,
      message: `Check-in for this athlete closed ${formatInZone(closesAt, timeZone)}. Send them to the Help Desk.`,
    };
  }
  return {
    ...window,
    state: 'open',
    allowed: true,
    message: closesAt
      ? `Check-in is open until ${formatInZone(closesAt, timeZone)} · slot ${formatInZone(slotAt, timeZone)}.`
      : `Check-in is open · slot ${formatInZone(slotAt, timeZone)}.`,
  };
}

/** Reads the window policy off a published `event_configs` row. */
export function checkinWindowPolicy(config: Record<string, any> | null | undefined): CheckinWindowPolicy {
  if (!config) return defaultCheckinWindowPolicy;
  const opens = Number(config.checkinOpensBeforeMinutes);
  const closes = config.checkinClosesAfterMinutes;
  return {
    enabled: Boolean(config.checkinWindowEnabled),
    opensBeforeMinutes: Number.isFinite(opens) && opens >= 0 ? opens : 240,
    closesAfterMinutes:
      closes === null || closes === undefined || closes === ''
        ? null
        : Number(closes),
  };
}
