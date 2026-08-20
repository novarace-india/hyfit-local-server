import { HjudgeResultsService } from './services/hjudge-results.service';

/* Importing a feed from a FILE instead of an endpoint.
 *
 * The whole claim this door makes is that it is the same door: same parser,
 * same mapping, same tables, same cache key — only the JSON arrives by hand.
 * So what is worth testing is exactly the places the two paths could diverge:
 *
 *   1. nothing is fetched (an offline venue has nothing to fetch, and an event
 *      with no endpoint configured must still be importable)
 *   2. the file's own shape is found, whichever wrapper it is in
 *   3. the provenance recorded is the file, not an invented URL
 *   4. a start list carried in still REPLACES the roster, because that is what a
 *      start list means on the fetched path too
 */

const EVENT = '11111111-1111-1111-1111-111111111111';

type Call = { sql: string; params: unknown[] };

function harness(config: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const cache = new Map<string, unknown>();
  let athleteSeq = 0;

  /* The fake athletes table keys a row the way `hyfit_v2_athletes_entry` does
     (085): the EVENT, the phone, the name and the CONTEST — and not the bib.
     Handing back a fresh id per call instead, as this used to, made every
     upsert look like a new person and hid the one thing the real index does:
     collapse the same person in the same contest onto one row, whatever bib
     each mention of them carried. */
  const athleteIds = new Map<string, string>();
  const resultAthletes = new Set<string>();
  const athleteKey = (params: unknown[]) =>
    [params[1], params[2], params[6]]
      .map((v) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase())
      .join('|');

  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/INSERT INTO athletes/i.test(sql)) {
        const key = athleteKey(params);
        const existing = athleteIds.get(key);
        const id =
          existing ??
          `aaaaaaaa-0000-0000-0000-${String(++athleteSeq).padStart(12, '0')}`;
        if (!existing) athleteIds.set(key, id);
        return { rows: [{ id, inserted: !existing }], rowCount: 1 };
      }
      /* `hyfit_v2_results_athlete` is UNIQUE (athlete_id) — one result per
         entry — and it is what turned a duplicated row into a 500 that took the
         whole import with it. Enforced here so the tests below reproduce the
         real failure rather than merely counting inserts. */
      if (/INSERT INTO results/i.test(sql)) {
        const athleteId = String(params[1]);
        if (resultAthletes.has(athleteId)) {
          const err: any = new Error(
            'duplicate key value violates unique constraint "hyfit_v2_results_athlete"',
          );
          err.code = '23505';
          throw err;
        }
        resultAthletes.add(athleteId);
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM results/i.test(sql)) {
        resultAthletes.clear();
        return { rows: [], rowCount: 0 };
      }
      if (/UPDATE events SET results_stored_at/i.test(sql))
        return { rows: [{ at: '2026-08-16T09:00:00.000Z' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };

  const db = {
    q: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM events e WHERE e\.id/i.test(sql))
        return {
          rows: [
            {
              id: EVENT,
              name: 'HYFIT Bengaluru',
              results_mode: 'off',
              results_stored_at: null,
              name_shared: false,
            },
          ],
        };
      return { rows: [{ results: 0, athletes: 0 }] };
    },
    tx: async (fn: (c: typeof client) => Promise<unknown>) => fn(client),
  };

  const cacheService = {
    set: async (key: string, value: unknown) => void cache.set(key, value),
    get: async (key: string) => cache.get(key) ?? null,
    delete: async (key: string) => void cache.delete(key),
    invalidateEvent: async () => undefined,
  };

  const raceResult = {
    loadConfig: async () => ({
      // The event this feature exists for: no endpoints at all.
      resultsUrl: '',
      participantApiUrl: '',
      resultsMapping: {},
      participantMapping: {},
      ...config,
    }),
    requireFeed: () => {
      throw new Error('requireFeed must not be reached by an upload');
    },
  };

  const service = new HjudgeResultsService(
    db as any,
    cacheService as any,
    raceResult as any,
  );
  return { service, calls, cache };
}

/** Two finishers, as a plain array — the commonest thing an operator has. */
const STANDINGS = [
  {
    Bib: '101',
    Name: 'Ishita Sharma',
    Contest: 'Female Open',
    Club: 'Koramangala',
    Total: '22:16',
    Run1: '01:40',
    ST1: '02:05',
    Rank: '1',
  },
  {
    Bib: '102',
    Name: 'Arjun Rao',
    Contest: 'Male Open',
    Club: 'Indiranagar',
    Total: '21:02',
    Rank: '1',
  },
];

const START_LIST = [
  {
    bib: '101',
    name: 'Ishita Sharma',
    category: 'Female Open',
    mobile: '9000000131',
  },
  {
    bib: '102',
    name: 'Arjun Rao',
    category: 'Male Open',
    mobile: '9000000132',
  },
];

/* Every test in this file would pass just as well against a service that
   quietly fetched the endpoint instead of reading the file, so the fetch is
   removed outright rather than mocked to return something. */
const realFetch = global.fetch;
beforeAll(() => {
  global.fetch = (() => {
    throw new Error('an upload must not fetch anything');
  }) as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = realFetch;
});

describe('standings uploaded as a file', () => {
  it('caches the rows for an event with no results endpoint configured', async () => {
    const { service, cache } = harness();

    const payload = await service.pullUpload(EVENT, STANDINGS, 'day1.json');

    expect(payload.rows).toHaveLength(2);
    expect(payload.rows[0]).toMatchObject({
      bib: '101',
      total_ms: 22 * 60_000 + 16_000,
    });
    // The key is the event's, exactly as a fetched pull would have written it.
    expect([...cache.keys()]).toEqual(['hyfitgames:results:hyfit-bengaluru']);
    // No URL is invented for a file: the field is a credential elsewhere.
    expect(payload.url).toBeNull();
  });

  it('finds the rows inside whatever wrapper the export saved them in', async () => {
    const { service } = harness();

    const wrapped = await service.pullUpload(
      EVENT,
      { data: STANDINGS },
      'wrapped.json',
    );
    expect(wrapped.rows).toHaveLength(2);

    const nested = await service.pullUpload(
      EVENT,
      { Results: { List: STANDINGS } },
      'nested.json',
    );
    expect(nested.rows).toHaveLength(2);
  });

  it('honours a configured listPath without looking for it twice', async () => {
    // The mapping names a path, and the rows are extracted once on the way in.
    // A second lookup inside the extracted array finds nothing, which is the
    // bug `withoutListPath` exists to prevent.
    const { service } = harness({
      resultsMapping: { listPath: 'payload.rows' },
    });

    const payload = await service.pullUpload(
      EVENT,
      { payload: { rows: STANDINGS } },
      'mapped.json',
    );
    expect(payload.rows).toHaveLength(2);
  });

  it('records the file as the provenance when the standings are stored', async () => {
    const { service, calls } = harness();

    const outcome = await service.storeUpload(EVENT, STANDINGS, 'final.json');

    expect(outcome).toMatchObject({ imported: 2, rejected: 0 });
    const inserts = calls.filter((c) => /INSERT INTO results/i.test(c.sql));
    expect(inserts).toHaveLength(2);
    // $27 is source_url. Read by position rather than as "the last parameter",
    // which is a moving target every time a column is added to this insert.
    expect(inserts[0].params[26]).toBe('upload:final.json');
  });

  it('lands a doubles row from the 2026 export with its team placing and band', async () => {
    // One row of the real file, uploaded and stored: what reaches the INSERT is
    // the whole point, since every earlier assertion stops at the parser.
    const { service, calls } = harness();
    await service.storeUpload(
      EVENT,
      [
        {
          Rank: 1,
          AgeGroupRank: 1,
          Bib: 10603,
          Name: 'Priya Ranjan  Sahu',
          Total: '12:20',
          TeamRank: 1,
          TeamTime: '12:21',
          Age: 34,
          Contest: 'Male Doubles',
          Category: 'Male Doubles',
          Phone: '+918886541632',
          Club: 'Priya & Rajesh',
          Finished: true,
        },
        {
          Rank: 1,
          AgeGroupRank: 1,
          Bib: 1105,
          Name: 'Aarav Chivukula',
          Total: '11:35',
          TeamRank: 0,
          TeamTime: '00:00',
          Age: 14,
          Contest: 'NextGen Boys',
          Category: 'Next Gen Boys 12-15',
          Phone: '+919886131077',
          Club: '',
          Finished: true,
        },
      ],
      'day1.json',
    );

    const [pair, solo] = calls.filter((c) =>
      /INSERT INTO results/i.test(c.sql),
    );
    // $5 category, $9 age_group_rank, $11 team_time_ms, $28 age_group,
    // $29 team_rank, $31 age
    expect(pair.params[4]).toBe('Male Doubles');
    expect(pair.params[27]).toBe(''); // the band only repeated the contest
    expect(pair.params[28]).toBe(1);
    expect(pair.params[10]).toBe(741_000);
    expect(pair.params[5]).toBe('Priya & Rajesh');

    expect(solo.params[4]).toBe('NextGen Boys');
    expect(solo.params[27]).toBe('Next Gen Boys 12-15');
    // A solo entry has neither half of a team result, whatever the feed wrote.
    expect(solo.params[28]).toBeNull();
    expect(solo.params[10]).toBeNull();

    /* The age lands on the RESULT, not only on the athlete.
     *
     * It used to go to the athlete row alone, where the next event this person
     * enters overwrites it — so a 14-year-old's NextGen Boys placing would read
     * as a 15-year-old's a season later, in the band it was won in. Migration
     * 089 gave the result its own column; this is the parameter that fills it. */
    expect(solo.params[30]).toBe(14);
    expect(pair.params[30]).toBe(34);
  });

  /* THE FAILURE THIS GUARDS: a 500 that threw away a whole import.
   *
   * The parser keeps one row per bib-in-a-contest; the athletes table keys an
   * entry on (event, phone, name, contest). A feed carrying the same person in
   * the same contest under two bibs — or, far more often, two rows with no
   * phone and the same name, which mobile_key('') collapses — satisfies the
   * first and violates the second. Both rows resolved to ONE athlete row and
   * the second INSERT hit `hyfit_v2_results_athlete` (one result per athlete),
   * aborting the transaction: 512 good rows discarded because of one duplicate,
   * with nothing in the error naming the row responsible.
   */
  it('keeps the first of two rows that are the same entry, and counts the rest', async () => {
    const { service, calls } = harness();

    const outcome = await service.storeUpload(
      EVENT,
      [
        {
          Rank: 1,
          Bib: 1105,
          Name: 'Aarav Chivukula',
          Total: '11:35',
          Contest: 'NextGen Boys',
          Phone: '+919886131077',
        },
        // The same person, the same contest, a different bib. Whatever the
        // export meant by it, this platform has one entry for them.
        {
          Rank: 9,
          Bib: 1180,
          Name: 'Aarav  Chivukula',
          Total: '13:02',
          Contest: 'NextGen Boys',
          Phone: '+919886131077',
        },
        // A third athlete, to prove the file is not abandoned at the collision.
        {
          Rank: 2,
          Bib: 1106,
          Name: 'Ishita Sharma',
          Total: '11:52',
          Contest: 'NextGen Girls',
          Phone: '+919886131078',
        },
      ],
      'day1.json',
    );

    const inserts = calls.filter((c) => /INSERT INTO results/i.test(c.sql));
    expect(inserts).toHaveLength(2);
    // The FIRST mention wins. Taking the last would make the stored standings
    // depend on the order the rows happened to appear in the file.
    expect(inserts[0].params[2]).toBe('1105');
    expect(inserts[1].params[2]).toBe('1106');

    // And the count says so, rather than reporting three rows imported.
    expect(outcome.imported).toBe(2);
    expect(outcome.rejected).toBe(1);
  });

  /* Two bibs in DIFFERENT contests are two entries, not a collision — the case
     the entry key exists for. One athlete racing solo and doubles at the same
     event has two results, and a fix for the duplicate above that also
     collapsed these would silently delete somebody's second race. */
  it('still stores both races of an athlete entered in two contests', async () => {
    const { service, calls } = harness();

    const outcome = await service.storeUpload(
      EVENT,
      [
        {
          Bib: 10622,
          Name: 'Manoj Bhandari',
          Total: '12:45',
          Contest: 'Male Doubles',
          TeamRank: 1,
          TeamTime: '12:45',
          Phone: '+917899428036',
        },
        {
          Bib: 10622,
          Name: 'Manoj Bhandari',
          Total: '12:10',
          Contest: 'Male Open',
          Phone: '+917899428036',
        },
      ],
      'day1.json',
    );

    expect(calls.filter((c) => /INSERT INTO results/i.test(c.sql))).toHaveLength(2);
    expect(outcome.imported).toBe(2);
    expect(outcome.rejected).toBe(0);
  });

  it('names the file when it holds nothing importable', async () => {
    const { service } = harness();

    await expect(service.pullUpload(EVENT, [], 'empty.json')).rejects.toThrow(
      /“empty\.json” holds no rows/,
    );
    // Rows, but none with a bib: the parser's own complaint, about the file.
    await expect(
      service.pullUpload(EVENT, [{ Athlete: 'Ishita' }], 'nobib.json'),
    ).rejects.toThrow(/“nobib\.json” returned no usable rows/);
  });
});

describe('a start list uploaded as a file', () => {
  it('replaces the roster and marks the rows as uploaded', async () => {
    const { service, calls } = harness();

    const outcome = await service.importAthletesUpload(
      EVENT,
      START_LIST,
      'startlist.json',
    );

    expect(outcome).toMatchObject({ imported: 2, created: 2, updated: 0 });

    const upserts = calls.filter((c) => /INSERT INTO athletes/i.test(c.sql));
    expect(upserts).toHaveLength(2);
    // $14 is `source`, and it says where this roster came from.
    expect(upserts[0].params[13]).toBe('upload');
    // …and the update branch has to agree, or a re-upload of the same file
    // would relabel every row 'raceresult'.
    expect(upserts[0].sql).toContain(
      'source        = CASE WHEN $17 THEN excluded.source',
    );

    // The prune that makes the file the roster, scoped to this event.
    const prune = calls.find((c) => /DELETE FROM athletes/i.test(c.sql));
    expect(prune?.params[0]).toBe(EVENT);
    expect((prune?.params[1] as string[]).length).toBe(2);
  });

  it('reads a start list nested in an export wrapper', async () => {
    const { service } = harness();
    const outcome = await service.importAthletesUpload(
      EVENT,
      { data: START_LIST },
      'wrapped.json',
    );
    expect(outcome.imported).toBe(2);
  });
});
