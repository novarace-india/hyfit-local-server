import { HfgRosterService } from './services/hfg-roster.service';

/* The roster import writes in batches, and the whole point of the batch is the
 * number of round trips it costs: a row at a time, a 2500-row start list is
 * ~18,000 sequential statements and takes minutes of pure waiting. These tests
 * pin the two things that would quietly undo that — the statement count, and
 * the identity rules the batch has to reproduce — plus the fallback that keeps
 * per-row error reporting when a batch cannot be written whole.
 *
 * The client is a stub rather than a database: what is being checked here is
 * which statements are issued and what is in them, not what Postgres does with
 * them. The SQL itself is exercised against the real schema by the import.
 */

type Call = { text: string; params: unknown[] };

const EVENT = '11111111-1111-1111-1111-111111111111';
const uuid = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

/** Reads the jsonb payload a batched statement carries. */
const payloadOf = (call: Call) =>
  JSON.parse(
    String(call.params.find((p) => typeof p === 'string' && p.startsWith('['))),
  ) as Record<string, any>[];

function makeClient(opts: { failEntries?: boolean } = {}) {
  const calls: Call[] = [];
  let seq = 0;
  const query = jest.fn(async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    const t = text.replace(/\s+/g, ' ').trim();

    if (/^(SAVEPOINT|RELEASE|ROLLBACK)/.test(t)) return { rows: [] };

    // ---- batched statements ----
    const batched = t.includes('jsonb_to_recordset');
    const last = () => payloadOf(calls[calls.length - 1]);

    if (t.startsWith('SELECT id, lower(name) AS key FROM categories'))
      return { rows: [] };
    if (t.startsWith('INSERT INTO categories') && batched)
      return {
        rows: last().map((c) => ({
          id: uuid(++seq),
          key: String(c.name).toLowerCase(),
        })),
      };
    if (t.startsWith('SELECT DISTINCT ON (x.k)')) return { rows: [] };
    if (t.startsWith('SELECT DISTINCT ON (a.person_source_id)'))
      return { rows: [] };
    if (t.startsWith('INSERT INTO athletes') && batched)
      return {
        rows: last().map((a) => ({
          id: uuid(++seq),
          person_source_id: a.person_source_id,
        })),
      };
    if (t.startsWith('UPDATE athletes a SET')) return { rows: [] };
    if (t.startsWith('INSERT INTO registrations') && batched)
      return {
        rows: last().map((r) => ({
          id: uuid(++seq),
          athlete_id: r.athlete_id,
        })),
      };
    if (t.startsWith('INSERT INTO category_entries')) {
      if (opts.failEntries && batched) {
        opts.failEntries = false; // the batch fails once; the retry is row by row
        throw Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'hyfit_category_entries_event_bib',
        });
      }
      return {
        rows: batched
          ? last().map(() => ({ inserted: true }))
          : [{ id: uuid(++seq), inserted: true }],
      };
    }

    // ---- the row-by-row fallback ----
    if (t.startsWith('SELECT id, mobile FROM athletes')) return { rows: [] };
    if (t.startsWith('SELECT id FROM categories')) return { rows: [] };
    return { rows: [{ id: uuid(++seq) }] };
  });

  return { client: { query } as any, calls, query };
}

const rowsFor = (
  n: number,
  over: (i: number) => Record<string, unknown> = () => ({}),
) =>
  Array.from({ length: n }, (_, i) => ({
    rowNo: i + 1,
    row: {
      full_name: `Athlete ${i}`,
      bib: String(100 + i),
      category: 'Open',
      ...over(i),
    },
  }));

const write = (
  svc: HfgRosterService,
  client: any,
  prepared: any[],
  errors: any[] = [],
) =>
  (svc as any).writeRows(
    client,
    EVENT,
    prepared,
    'roster',
    {
      athletesCreated: 0,
      athletesUpdated: 0,
      entriesCreated: 0,
      entriesUpdated: 0,
      categoriesCreated: new Set<string>(),
    },
    errors,
    new Map<string, string>(),
  );

describe('roster batch write', () => {
  const svc = () => new HfgRosterService({} as any);

  it('costs the same number of statements for 500 rows as for 5', async () => {
    const small = makeClient();
    const large = makeClient();
    await write(svc(), small.client, rowsFor(5));
    await write(svc(), large.client, rowsFor(500));
    expect(large.calls.length).toBe(small.calls.length);
    // Savepoint, categories, two lookups, athletes, registrations, entries,
    // release — a fixed handful, whatever the row count.
    expect(large.calls.length).toBeLessThan(12);
  });

  it('counts every row against exactly one athlete counter', async () => {
    const { client } = makeClient();
    const counts = {
      athletesCreated: 0,
      athletesUpdated: 0,
      entriesCreated: 0,
      entriesUpdated: 0,
      categoriesCreated: new Set<string>(),
    };
    await (svc() as any).writeRows(
      client,
      EVENT,
      rowsFor(40),
      'roster',
      counts,
      [],
      new Map(),
    );
    expect(counts.athletesCreated + counts.athletesUpdated).toBe(40);
    expect(counts.entriesCreated + counts.entriesUpdated).toBe(40);
  });

  it('makes one athlete of two rows for the same number and name', async () => {
    const { client, calls } = makeClient();
    // Two entries, two bibs, one person — row by row the second row would have
    // found what the first one wrote.
    const prepared = [
      {
        rowNo: 1,
        row: {
          full_name: 'Asha R',
          mobile: '919000000001',
          bib: '1',
          category: 'Open',
        },
      },
      {
        rowNo: 2,
        row: {
          full_name: ' asha r ',
          mobile: '919000000001',
          bib: '2',
          category: 'Doubles',
        },
      },
    ];
    await write(svc(), client, prepared);

    const inserted = payloadOf(
      calls.find((c) => c.text.includes('INSERT INTO athletes'))!,
    );
    expect(inserted).toHaveLength(1);
    const regs = payloadOf(
      calls.find((c) => c.text.includes('INSERT INTO registrations'))!,
    );
    expect(regs).toHaveLength(1);
    // Two categories, so two entries under the one registration.
    const entries = payloadOf(
      calls.find((c) => c.text.includes('INSERT INTO category_entries'))!,
    );
    expect(entries).toHaveLength(2);
    expect(entries[0].registration_id).toBe(entries[1].registration_id);
  });

  it('keeps different people on one phone apart', async () => {
    const { client, calls } = makeClient();
    await write(svc(), client, [
      {
        rowNo: 1,
        row: {
          full_name: 'Asha R',
          mobile: '919000000001',
          bib: '1',
          category: 'Open',
        },
      },
      {
        rowNo: 2,
        row: {
          full_name: 'Dev R',
          mobile: '919000000001',
          bib: '2',
          category: 'Open',
        },
      },
    ]);
    expect(
      payloadOf(calls.find((c) => c.text.includes('INSERT INTO athletes'))!),
    ).toHaveLength(2);
  });

  it('carries the first non-null value of every profile column', async () => {
    const { client, calls } = makeClient();
    await write(svc(), client, [
      {
        rowNo: 1,
        row: {
          full_name: 'Asha R',
          mobile: '919000000001',
          bib: '1',
          category: 'Open',
          city: null,
          email: 'a@b.com',
        },
      },
      {
        rowNo: 2,
        row: {
          full_name: 'Asha R',
          mobile: '919000000001',
          bib: '2',
          category: 'Open',
          city: 'Kochi',
          email: 'later@b.com',
        },
      },
    ]);
    const [athlete] = payloadOf(
      calls.find((c) => c.text.includes('INSERT INTO athletes'))!,
    );
    expect(athlete.email).toBe('a@b.com'); // the first row's, as COALESCE would leave it
    expect(athlete.city).toBe('Kochi'); // the first row had none
  });

  it('rewrites the batch row by row when it cannot be written whole', async () => {
    const { client, calls } = makeClient({ failEntries: true });
    const errors: { row: number; reason: string }[] = [];
    await write(svc(), client, rowsFor(3), errors);

    expect(
      calls.some((c) =>
        c.text.startsWith('ROLLBACK TO SAVEPOINT roster_batch'),
      ),
    ).toBe(true);
    // Three rows, each in its own savepoint, written the old way.
    expect(calls.filter((c) => c.text === 'SAVEPOINT roster_row')).toHaveLength(
      3,
    );
    expect(errors).toHaveLength(0); // the row-by-row rewrite succeeds
  });

  it('reports the row that fails during the rewrite', async () => {
    const { client, query } = makeClient({ failEntries: true });
    const errors: { row: number; reason: string }[] = [];
    let seenRowInserts = 0;
    const inner = query.getMockImplementation()!;
    query.mockImplementation(async (text: string, params: unknown[] = []) => {
      if (
        text.includes('INSERT INTO category_entries') &&
        text.includes('VALUES')
      ) {
        seenRowInserts++;
        if (seenRowInserts === 2)
          throw Object.assign(new Error('duplicate key'), {
            code: '23505',
            constraint: 'hyfit_category_entries_event_bib',
          });
      }
      return inner(text, params);
    });

    await write(svc(), client, rowsFor(3), errors);
    expect(errors).toEqual([
      {
        row: 2,
        reason: 'Bib 101 already belongs to a different athlete at this event',
      },
    ]);
  });
});
