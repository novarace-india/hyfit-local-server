import { HjudgeRaceResultService } from './services/hjudge-raceresult.service';
import {
  assignmentFor,
  buildAssignmentTable,
  holderOfAsset,
  nextStageFor,
} from './hjudge-checkin-rr.util';

/**
 * The equipment mapping table, and everything the counter decides from it.
 *
 * It is the authority on equipment in both directions: what a BIB already holds
 * (which decides the stage that athlete is due) and who a scanned code belongs
 * to (which decides whether it can be handed over at all).
 *
 * It is fetched WHOLE. It takes no query parameter, which is why the row is
 * found here rather than asked for.
 */

const PARTICIPANT_URL = 'https://rr.example.com/_1/api/READKEY';
const MAP_URL = 'https://rr.example.com/_1/api/MAPKEY';
const EVENT = '11111111-1111-1111-1111-111111111111';

const config = (over: Record<string, unknown> = {}) =>
  ({
    participantApiUrl: PARTICIPANT_URL,
    updateApiUrl: 'https://rr.example.com/_1/api/WRITEKEY',
    mapLookupUrl: MAP_URL,
    participantMapping: {},
    updateMapping: {},
    declarationText: 'I confirm my details are correct.',
    declarationVersion: 1,
    checkinWindowEnabled: false,
    checkinOpensBeforeMinutes: 240,
    checkinClosesAfterMinutes: null,
    timeZone: 'Asia/Kolkata',
    eventDate: '2026-08-15',
    eventStartsAt: null,
    ...over,
  }) as any;

const athlete = (over: Record<string, unknown> = {}) => ({
  Bib: 11651,
  'First Name': 'Thomas',
  Lastname: 'Laurent',
  Contest: 'Bloodline Doubles',
  ContestID: 9,
  Gender: 'Male',
  Club: 'C09-TEAM-001',
  DateOfBirth: '1998-07-28',
  Wave: 'Wave 01',
  TimeSlot: '6:00 PM - 8:00 PM',
  ContestDate: '2026-08-15',
  Transponder1: '',
  wristbandid: 'A-11111',
  stage1checkin: true,
  stage1checkintime: '2026-08-15 17:42:11',
  stage2checkin: false,
  stage2checkintime: '',
  wristbandidAssignedBy: 'VOL-07',
  transponderAssignedBy: '',
  ...over,
});

/** Serves the two endpoints separately, so the hops can be told apart. */
function service(opts: { map?: unknown; participants?: unknown[] } = {}) {
  const calls: string[] = [];
  global.fetch = jest.fn(async (input: any) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith(MAP_URL))
      return { ok: true, json: async () => opts.map ?? [] } as any;
    const bib = new URL(url).searchParams.get('bib');
    const rows = opts.participants ?? [];
    return {
      ok: true,
      json: async () =>
        bib ? rows.filter((r: any) => String(r.Bib) === String(bib)) : rows,
    } as any;
  }) as any;

  const cache = { get: async () => null, set: async () => undefined } as any;
  const db = { q: jest.fn() } as any;
  return { rr: new HjudgeRaceResultService(db, cache), calls };
}

describe('buildAssignmentTable', () => {
  it('indexes a row by its bib and by both of its codes', () => {
    const table = buildAssignmentTable(
      [{ Bib: 11651, wristbandid: 'A-11111', Transponder1: 'T-500' }],
      {},
    );
    expect(table.byBib.get('11651')?.wristband).toBe('A-11111');
    expect(table.byWristband.get('a-11111')?.bib).toBe('11651');
    expect(table.byTransponder.get('t-500')?.bib).toBe('11651');
  });

  it('leaves a code out of its index when nothing is issued yet', () => {
    const table = buildAssignmentTable(
      [{ Bib: 11651, wristbandid: '', Transponder1: '' }],
      {},
    );
    // The bib is still known — it just holds nothing.
    expect(table.byBib.get('11651')?.wristband).toBe('');
    expect(table.byWristband.size).toBe(0);
    expect(table.byTransponder.size).toBe(0);
  });

  it('reads a table wrapped in an envelope', () => {
    const table = buildAssignmentTable({ data: [{ Bib: 1, wristbandid: 'B-1' }] }, {});
    expect(table.byWristband.get('b-1')?.bib).toBe('1');
  });

  it('accepts the bib column under any of its usual names', () => {
    expect(
      buildAssignmentTable([{ BibNumber: 7, wristbandid: 'B-7' }], {}).byWristband.get('b-7')?.bib,
    ).toBe('7');
    expect(
      buildAssignmentTable([{ StartNumber: 8, wristbandid: 'B-8' }], {}).byWristband.get('b-8')?.bib,
    ).toBe('8');
  });

  it('honours renamed asset fields', () => {
    const table = buildAssignmentTable(
      [{ Bib: 11651, BandCode: 'A-11111', ChipCode: 'T-1' }],
      { wristband: 'BandCode', transponder1: 'ChipCode' },
    );
    expect(table.byWristband.get('a-11111')?.bib).toBe('11651');
    expect(table.byTransponder.get('t-1')?.bib).toBe('11651');
  });

  it('keeps the first of a duplicated code rather than the last', () => {
    // A band against two bibs is a broken mapping table. Taking the later row
    // would silently prefer whichever the endpoint happened to return last.
    const table = buildAssignmentTable(
      [{ Bib: 11651, wristbandid: 'A-1' }, { Bib: 11999, wristbandid: 'A-1' }],
      {},
    );
    expect(table.byWristband.get('a-1')?.bib).toBe('11651');
  });

  it('reports which asset columns the table actually carries', () => {
    const both = buildAssignmentTable(
      [{ Bib: 1, wristbandid: 'A-1', Transponder1: '' }],
      {},
    );
    expect(both.publishesWristband).toBe(true);
    expect(both.publishesTransponder).toBe(true);

    // A table with no transponder column at all. Every athlete would otherwise
    // read as "no transponder issued", and the same chip could go to all of them.
    const bandOnly = buildAssignmentTable([{ Bib: 1, wristbandid: 'A-1' }], {});
    expect(bandOnly.publishesWristband).toBe(true);
    expect(bandOnly.publishesTransponder).toBe(false);
  });
});

describe('the stage an athlete is due', () => {
  const table = buildAssignmentTable(
    [
      { Bib: 1, wristbandid: '', Transponder1: '' },
      { Bib: 2, wristbandid: 'A-2', Transponder1: '' },
      { Bib: 3, wristbandid: 'A-3', Transponder1: 'T-3' },
    ],
    {},
  );

  it('is Stage 1 for an athlete holding nothing', () => {
    expect(nextStageFor(assignmentFor(table, '1'))).toBe('STAGE_1_WRISTBAND');
  });

  it('is Stage 2 once they have a band but no chip', () => {
    expect(nextStageFor(assignmentFor(table, '2'))).toBe('STAGE_2_TRANSPONDER');
  });

  it('is nothing at all once they hold both', () => {
    expect(nextStageFor(assignmentFor(table, '3'))).toBeNull();
  });

  it('is Stage 1 for a bib the table has never heard of', () => {
    // Not an error: it is the morning of the event and nobody has been issued
    // anything, so the table has no row for them yet.
    expect(nextStageFor(assignmentFor(table, '9999'))).toBe('STAGE_1_WRISTBAND');
  });

  it('ignores leading zeros on the bib, as everything else does', () => {
    expect(nextStageFor(assignmentFor(table, '002'))).toBe('STAGE_2_TRANSPONDER');
  });
});

describe('who already holds a code', () => {
  const table = buildAssignmentTable(
    [{ Bib: 11651, wristbandid: 'A-11111', Transponder1: 'T-500' }],
    {},
  );

  it('names the holder of an issued wristband', () => {
    expect(holderOfAsset(table, 'A-11111', 'STAGE_1_WRISTBAND')?.bib).toBe('11651');
  });

  it('names the holder of an issued transponder', () => {
    expect(holderOfAsset(table, 'T-500', 'STAGE_2_TRANSPONDER')?.bib).toBe('11651');
  });

  it('tolerates case and leading zeros, as a scanner would produce them', () => {
    expect(holderOfAsset(table, 'a-11111', 'STAGE_1_WRISTBAND')?.bib).toBe('11651');
  });

  it('does not confuse the two kinds of code with each other', () => {
    // A wristband code looked up as a transponder is free, and vice versa —
    // they are separate pools and an event may legitimately reuse the numbers.
    expect(holderOfAsset(table, 'A-11111', 'STAGE_2_TRANSPONDER')).toBeNull();
    expect(holderOfAsset(table, 'T-500', 'STAGE_1_WRISTBAND')).toBeNull();
  });

  it('says nobody for a code that has not been issued', () => {
    expect(holderOfAsset(table, 'A-99999', 'STAGE_1_WRISTBAND')).toBeNull();
    expect(holderOfAsset(table, '', 'STAGE_1_WRISTBAND')).toBeNull();
  });
});

describe('finding an athlete by the equipment they are carrying', () => {
  it('fetches the mapping table whole, with no query parameter', async () => {
    const { rr, calls } = service({
      map: [{ Bib: 11651, wristbandid: 'A-11111' }],
      participants: [athlete()],
    });

    await rr.fetchAthleteByAssetCode(config(), EVENT, 'A-11111');

    const mapCall = calls.find((u) => u.startsWith(MAP_URL))!;
    expect(mapCall).toBe(MAP_URL);
    expect(new URL(mapCall).search).toBe('');
  });

  it('then asks the participant endpoint for that bib', async () => {
    const { rr, calls } = service({
      map: [{ Bib: 11651, wristbandid: 'A-11111' }],
      participants: [athlete()],
    });

    const found = await rr.fetchAthleteByAssetCode(config(), EVENT, 'A-11111');

    expect(found?.person.bib).toBe('11651');
    // The details come from the participant feed, not the mapping table, so a
    // Stage 2 counter sees exactly what Stage 1 saw.
    expect(found?.person.name).toBe('Thomas Laurent');
    expect(found?.person.club).toBe('C09-TEAM-001');
    expect(found?.stages.STAGE_1_WRISTBAND?.state).toBe('completed');

    const participantCall = calls.find((u) => u.startsWith(PARTICIPANT_URL))!;
    expect(new URL(participantCall).searchParams.get('bib')).toBe('11651');
  });

  it('tolerates case and leading zeros on the scanned band', async () => {
    const { rr } = service({
      map: [{ Bib: 11651, wristbandid: 'A-11111' }],
      participants: [athlete()],
    });
    expect(
      (await rr.fetchAthleteByAssetCode(config(), EVENT, 'a-11111'))?.person.bib,
    ).toBe('11651');
  });

  it('resolves a transponder as readily as a wristband', async () => {
    const { rr } = service({
      map: [{ Bib: 11651, wristbandid: 'A-11111', Transponder1: 'Z-99999' }],
      participants: [athlete()],
    });
    expect(
      (await rr.fetchAthleteByAssetCode(config(), EVENT, 'Z-99999'))?.person.bib,
    ).toBe('11651');
  });

  it('returns nothing for a code the table carries in neither column', async () => {
    const { rr, calls } = service({
      map: [{ Bib: 11651, wristbandid: 'A-11111' }],
      participants: [athlete()],
    });

    expect(
      await rr.fetchAthleteByAssetCode(config(), EVENT, 'A-99999'),
    ).toBeNull();
    // No second hop: there is no bib to ask about.
    expect(calls.filter((u) => u.startsWith(PARTICIPANT_URL))).toHaveLength(0);
  });

  it('refuses when the event has no mapping endpoint', async () => {
    const { rr, calls } = service({ participants: [athlete()] });

    await expect(
      rr.fetchAthleteByAssetCode(config({ mapLookupUrl: '' }), EVENT, 'A-11111'),
    ).rejects.toThrow(/equipment mapping endpoint/i);
    expect(calls).toHaveLength(0);
  });
});
