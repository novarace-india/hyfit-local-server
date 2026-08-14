import {
  evaluateCheckinWindow,
  parseSlotMinutes,
  resolveSlotAt,
  zonedInstant,
  checkinWindowPolicy,
} from './hjudge-checkin-window.util';

const IST = 'Asia/Kolkata';

/** 2026-08-10 04:00 IST, the organiser's worked example, as an instant. */
const slotFourAm = new Date('2026-08-09T22:30:00.000Z');

const openWindow = {
  enabled: true,
  opensBeforeMinutes: 240,
  closesAfterMinutes: null,
};

describe('parseSlotMinutes', () => {
  it('reads the clock times a roster actually contains', () => {
    expect(parseSlotMinutes('04:00')).toBe(240);
    expect(parseSlotMinutes('9:40')).toBe(580);
    expect(parseSlotMinutes('16:30:00')).toBe(990);
    expect(parseSlotMinutes('9.40')).toBe(580);
    expect(parseSlotMinutes('0940')).toBe(580);
    expect(parseSlotMinutes('4 AM')).toBe(240);
    expect(parseSlotMinutes('4pm')).toBe(960);
    expect(parseSlotMinutes('12:15 am')).toBe(15);
    expect(parseSlotMinutes('12:15 pm')).toBe(735);
  });

  it('finds the time inside a label that says more than the time', () => {
    expect(parseSlotMinutes('Wave 2 · 09:40')).toBe(580);
    expect(parseSlotMinutes('Fri 06:30')).toBe(390);
  });

  // The whole safety property of this feature: a label that is not a clock
  // time must not be read as one, or an athlete gets a window nine hours off.
  it('refuses labels that name no clock time', () => {
    expect(parseSlotMinutes('Slot 3')).toBeNull();
    expect(parseSlotMinutes('3')).toBeNull();
    expect(parseSlotMinutes('Fri AM')).toBeNull();
    expect(parseSlotMinutes('')).toBeNull();
    expect(parseSlotMinutes(null)).toBeNull();
    expect(parseSlotMinutes('25:30')).toBeNull();
    expect(parseSlotMinutes('10:75')).toBeNull();
  });
});

describe('zonedInstant', () => {
  it('reads the label as the event clock, not the server clock', () => {
    expect(zonedInstant('2026-08-10', 240, IST)?.toISOString()).toBe(
      '2026-08-09T22:30:00.000Z',
    );
    expect(zonedInstant('2026-08-10', 240, 'UTC')?.toISOString()).toBe(
      '2026-08-10T04:00:00.000Z',
    );
  });

  it('lands on the right side of a daylight-saving change', () => {
    // 09:00 on the US spring-forward Sunday: EDT, not EST.
    expect(zonedInstant('2026-03-08', 540, 'America/New_York')?.toISOString()).toBe(
      '2026-03-08T13:00:00.000Z',
    );
  });
});

describe('resolveSlotAt', () => {
  it('prefers the entry start_time over the label', () => {
    const at = resolveSlotAt({
      timeslot: '09:40',
      startTime: '2026-08-10T02:00:00.000Z',
      eventDate: '2026-08-10',
      timeZone: IST,
    });
    expect(at?.toISOString()).toBe('2026-08-10T02:00:00.000Z');
  });

  it('hangs a bare clock label on the event date', () => {
    expect(
      resolveSlotAt({ timeslot: '04:00', eventDate: '2026-08-10', timeZone: IST })?.toISOString(),
    ).toBe(slotFourAm.toISOString());
  });

  it('falls back to the date of starts_at when the event has no event_date', () => {
    expect(
      resolveSlotAt({
        timeslot: '04:00',
        eventStartsAt: '2026-08-10T03:00:00.000Z', // 08:30 IST on the 10th
        timeZone: IST,
      })?.toISOString(),
    ).toBe(slotFourAm.toISOString());
  });

  // A weekend event: Saturday's 09:40 and Sunday's 09:40 are different slots,
  // and only the entry's own contest date tells them apart.
  it('puts the slot on the entry contest date, not the event date', () => {
    const at = resolveSlotAt({
      timeslot: '09:40',
      contestDate: '2026-08-11',
      eventDate: '2026-08-10',
      timeZone: IST,
    });
    expect(at?.toISOString()).toBe('2026-08-11T04:10:00.000Z');
  });

  it('reads a contest date handed over as a Date without losing a day', () => {
    // node-postgres builds a `date` column at LOCAL midnight; taking the ISO
    // form of that instant would say the 10th in any zone ahead of UTC.
    const at = resolveSlotAt({
      timeslot: '09:40',
      contestDate: new Date(2026, 7, 11, 0, 0, 0),
      timeZone: IST,
    });
    expect(at?.toISOString()).toBe('2026-08-11T04:10:00.000Z');
  });

  it('falls back to the event date when the entry names no contest date', () => {
    expect(
      resolveSlotAt({ timeslot: '04:00', eventDate: '2026-08-10', timeZone: IST })?.toISOString(),
    ).toBe(slotFourAm.toISOString());
  });

  it('gives up rather than guessing', () => {
    expect(resolveSlotAt({ timeslot: 'Slot 3', eventDate: '2026-08-10', timeZone: IST })).toBeNull();
    expect(resolveSlotAt({ timeslot: '04:00', timeZone: IST })).toBeNull();
  });
});

describe('evaluateCheckinWindow', () => {
  const source = { timeslot: '04:00', eventDate: '2026-08-10', timeZone: IST };
  const at = (istClock: string) => new Date(`2026-08-${istClock}+05:30`);

  it('does nothing at all while the window is off', () => {
    const window = evaluateCheckinWindow(
      { ...openWindow, enabled: false },
      source,
      at('09T18:00'),
    );
    expect(window.state).toBe('off');
    expect(window.allowed).toBe(true);
    expect(window.slotAt).toBeNull();
  });

  // The organiser's example: four hours before a 04:00 slot is midnight.
  it('opens the counter the configured time before the slot', () => {
    expect(evaluateCheckinWindow(openWindow, source, at('09T23:59')).state).toBe('early');
    expect(evaluateCheckinWindow(openWindow, source, at('10T00:00')).state).toBe('open');
    expect(evaluateCheckinWindow(openWindow, source, at('10T03:30')).state).toBe('open');
  });

  it('names the time to come back at', () => {
    const window = evaluateCheckinWindow(openWindow, source, at('09T20:00'));
    expect(window.allowed).toBe(false);
    expect(window.opensAt).toBe('2026-08-09T18:30:00.000Z'); // 00:00 IST
    expect(window.message).toMatch(/12:00 am/i);
  });

  it('stays open forever unless the organiser sets a close', () => {
    expect(evaluateCheckinWindow(openWindow, source, at('10T23:00')).state).toBe('open');
    const closing = { ...openWindow, closesAfterMinutes: 30 };
    expect(evaluateCheckinWindow(closing, source, at('10T04:29')).state).toBe('open');
    const late = evaluateCheckinWindow(closing, source, at('10T04:31'));
    expect(late.state).toBe('late');
    expect(late.allowed).toBe(false);
  });

  it('opens day two on day two', () => {
    const sunday = { ...source, timeslot: '09:40', contestDate: '2026-08-11' };
    // 05:40 on the 11th is four hours before 09:40 on the 11th; the same clock
    // time on the 10th is a day early, and used to look open.
    expect(evaluateCheckinWindow(openWindow, sunday, at('10T06:00')).state).toBe('early');
    expect(evaluateCheckinWindow(openWindow, sunday, at('11T05:39')).state).toBe('early');
    expect(evaluateCheckinWindow(openWindow, sunday, at('11T05:41')).state).toBe('open');
  });

  it('never blocks an entry whose slot it cannot read', () => {
    const window = evaluateCheckinWindow(
      openWindow,
      { ...source, timeslot: 'Slot 3' },
      at('09T06:00'),
    );
    expect(window.state).toBe('no_slot');
    expect(window.allowed).toBe(true);
  });
});

describe('checkinWindowPolicy', () => {
  it('reads a published config row', () => {
    expect(
      checkinWindowPolicy({
        checkinWindowEnabled: true,
        checkinOpensBeforeMinutes: 90,
        checkinClosesAfterMinutes: 15,
      }),
    ).toEqual({ enabled: true, opensBeforeMinutes: 90, closesAfterMinutes: 15 });
  });

  it('treats an event with no configuration as unrestricted', () => {
    expect(checkinWindowPolicy(null).enabled).toBe(false);
    expect(checkinWindowPolicy({}).enabled).toBe(false);
    expect(
      checkinWindowPolicy({ checkinWindowEnabled: true, checkinClosesAfterMinutes: null })
        .closesAfterMinutes,
    ).toBeNull();
  });
});
