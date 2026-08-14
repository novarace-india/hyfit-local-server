import { HfgSetupService } from './services/hfg-setup.service';

/**
 * Creating an event from the console.
 *
 * One test that matters here, and it is about routing rather than SQL: an event
 * created for the public must ALSO get its operational row in hyfit_v2. This is
 * the only place an event is created from the console, so it is the only place
 * that can hold that invariant — and everything downstream assumes it. Without
 * the second row the event exists publicly and nowhere else: Operations refuses
 * to attach RaceResult endpoints to it, no counter can be opened for it, and no
 * judge tablet ever sees it. None of which fails loudly at creation time.
 */

const valid = {
  name: 'HYFIT Bengaluru',
  city: 'Bengaluru',
  edition: 3,
  event_date: '2026-08-15',
  venue: 'KTPO',
  timezone: 'Asia/Kolkata',
  stations: ['Sled', 'Row', 'Ski', 'Carry', 'Burpee', 'Tyre'],
  categories: ["Men's Open"],
};

function service() {
  const queries: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      // Only the listing insert is read back, for its id.
      if (/INSERT INTO events/i.test(sql))
        return { rows: [{ id: 'platform-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  const db = { tx: async (fn: any) => fn(client) } as any;
  const cache = { invalidateEvent: async () => undefined } as any;
  const roster = {} as any;
  return {
    setup: new HfgSetupService(db, cache, roster),
    queries,
    find: (pattern: RegExp) => queries.find((q) => pattern.test(q.sql)),
  };
}

describe('createEvent', () => {
  it('creates the operational event alongside the public listing', async () => {
    const { setup, find } = service();

    await setup.createEvent({ ...valid });

    const listing = find(/INSERT INTO events/i);
    const operational = find(/INSERT INTO hyfit_v2\.events/i);
    expect(listing).toBeDefined();
    expect(operational).toBeDefined();
  });

  it('points the operational event back at the listing it was made for', async () => {
    const { setup, find } = service();

    await setup.createEvent({ ...valid });

    const operational = find(/INSERT INTO hyfit_v2\.events/i)!;
    // The pairing is the whole point: platform_event_id is the only thing
    // joining the two rows, and the events list, the roster importer and
    // Operations all read through it.
    expect(operational.params).toContain('platform-1');
    expect(operational.sql).toContain('platform_event_id');
  });

  it('carries the event date onto the operational row', async () => {
    const { setup, find } = service();

    await setup.createEvent({ ...valid });

    // The check-in window anchors an athlete's timeslot to a calendar day, and
    // takes this as the fallback for anyone whose ContestDate is blank — which
    // on a single-day event is everyone.
    expect(find(/INSERT INTO hyfit_v2\.events/i)!.params).toContain('2026-08-15');
  });

  it('creates neither row when the listing is rejected', async () => {
    const { setup, queries } = service();

    // Same transaction, so a validation failure leaves nothing behind — not a
    // listing without operations, and not the reverse.
    await expect(
      setup.createEvent({ ...valid, city: '' }),
    ).rejects.toThrow(/City is required/);
    expect(queries).toHaveLength(0);
  });
});
