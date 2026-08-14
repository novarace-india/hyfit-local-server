import { HjudgeRaceSubmitService } from './services/hjudge-race-submit.service';
import { readRecordFlag } from './hjudge-checkin-rr.util';

/* POST /hyfit-judge/judge/results — a finished race, scored and pushed.
 *
 * The tablet owns the race while it runs and sends what it observed. What turns
 * those observations into an official time stays here, so these tests are the
 * contract for that: which fields go out, with which values, for whom. */

const EVENT = '11111111-1111-1111-1111-111111111111';
const UPDATE_URL = 'https://rr.example.com/_1/api/WRITEKEY';

const at = (seconds: number) =>
  new Date(Date.UTC(2026, 7, 16, 9, 0, seconds)).toISOString();

/** A clean solo race: start, memorise, six run/station pairs, recall, finish. */
const soloBoundaries = () => [
  { stageId: 'race_start', boundaryAt: at(0) },
  { stageId: 'cognitive_memorise', boundaryAt: at(5) },
  { stageId: 'run_1', boundaryAt: at(10) },
  { stageId: 'station_1', boundaryAt: at(30) },
  { stageId: 'run_2', boundaryAt: at(40) },
  { stageId: 'station_2', boundaryAt: at(60) },
  { stageId: 'run_3', boundaryAt: at(70) },
  { stageId: 'station_3', boundaryAt: at(90) },
  { stageId: 'run_4', boundaryAt: at(100) },
  { stageId: 'station_4', boundaryAt: at(120) },
  { stageId: 'run_5', boundaryAt: at(130) },
  { stageId: 'station_5', boundaryAt: at(150) },
  { stageId: 'run_6', boundaryAt: at(160) },
  { stageId: 'station_6', boundaryAt: at(180) },
  { stageId: 'cognitive_recall', boundaryAt: at(190) },
  { stageId: 'finish_line', boundaryAt: at(200) },
];

describe('HjudgeRaceSubmitService', () => {
  let service: HjudgeRaceSubmitService;
  let rr: any;
  let writes: Array<{ bib: string; field: string; value: string }>;

  beforeEach(() => {
    writes = [];
    rr = {
      loadConfig: jest.fn(async () => ({
        updateApiUrl: UPDATE_URL,
        updateMapping: {},
        // The event's zone, which the times of day are printed in. Fixed here
        // so these assertions do not read differently on a laptop in another
        // one.
        timeZone: 'Asia/Kolkata',
      })),
      canWrite: jest.fn(() => true),
      writeField: jest.fn(async (_c: any, bib: string, field: string, value: string) => {
        writes.push({ bib, field, value });
      }),
    };
    service = new HjudgeRaceSubmitService(rr);
  });

  const valueOf = (field: string, bib = '101') =>
    writes.find((w) => w.field === field && w.bib === bib)?.value;

  it('writes every timing field in seconds to three decimals', async () => {
    await service.submit(EVENT, {
      bibs: ['101'],
      raceMode: 'single',
      boundaries: soloBoundaries(),
    });

    expect(valueOf('run1time')).toBe('10.000');
    expect(valueOf('station1time')).toBe('20.000');
    expect(valueOf('run2time')).toBe('10.000');
    expect(valueOf('totalracetime')).toBe('200.000');
  });

  it('writes a blank for a leg the race never reached', async () => {
    // A blank is how RaceResult is told "no time here". Leaving the field
    // unwritten would let a previous attempt's value stand.
    await service.submit(EVENT, {
      bibs: ['101'],
      raceMode: 'single',
      boundaries: [
        { stageId: 'race_start', boundaryAt: at(0) },
        { stageId: 'run_1', boundaryAt: at(10) },
      ],
    });
    expect(valueOf('run1time')).toBe('10.000');
    expect(valueOf('station6time')).toBe('');
    expect(valueOf('totalracetime')).toBe('');
  });

  /* Times of day.
   *
   * The same taps the durations come from, written as clock times. Nothing new
   * is measured for them — every boundary has always arrived as an absolute
   * instant — so they are derived here rather than on the tablet, and no tablet
   * needs reinstalling to start filling them in. */

  describe('times of day', () => {
    it('writes every boundary as a clock time in the event zone', async () => {
      await service.submit(EVENT, {
        bibs: ['101'],
        raceMode: 'single',
        boundaries: soloBoundaries(),
      });

      // 09:00:00Z is 14:30 in Kolkata, and the race runs 200 seconds from there.
      expect(valueOf('starttod')).toBe('14:30:00.000');
      expect(valueOf('run1tod')).toBe('14:30:10.000');
      expect(valueOf('station1tod')).toBe('14:30:30.000');
      expect(valueOf('station6tod')).toBe('14:33:00.000');
      expect(valueOf('cognitiverecalltod')).toBe('14:33:10.000');
      expect(valueOf('finishtod')).toBe('14:33:20.000');
    });

    it('prints the zone the athlete ran in, not the one the server sits in', async () => {
      rr.loadConfig = jest.fn(() =>
        Promise.resolve({
          updateApiUrl: UPDATE_URL,
          updateMapping: {},
          timeZone: 'Europe/London',
        }),
      );

      await service.submit(EVENT, {
        bibs: ['101'],
        raceMode: 'single',
        boundaries: soloBoundaries(),
      });

      // 10:00, not 09:00: August is BST, so the offset is the one in force on
      // the day rather than the zone's standard one.
      expect(valueOf('starttod')).toBe('10:00:00.000');
    });

    it('keeps the milliseconds a tap was recorded with', async () => {
      await service.submit(EVENT, {
        bibs: ['101'],
        raceMode: 'single',
        boundaries: [
          { stageId: 'race_start', boundaryAt: '2026-08-16T09:00:00.000Z' },
          { stageId: 'run_1', boundaryAt: '2026-08-16T09:00:12.480Z' },
        ],
      });

      expect(valueOf('run1tod')).toBe('14:30:12.480');
    });

    it('takes a doubles start from the team line, as the durations do', async () => {
      await service.submit(EVENT, {
        bibs: ['201', '202'],
        raceMode: 'doubles',
        boundaries: [
          { stageId: 'race_start', boundaryAt: at(0) },
          { stageId: 'team_start', boundaryAt: at(5) },
          { stageId: 'run_1', boundaryAt: at(20) },
        ],
      });

      // Not 14:30:00 — a doubles race starts when the team crosses. This has to
      // agree with totalracetime, which is measured from the same boundary.
      expect(valueOf('starttod', '201')).toBe('14:30:05.000');
      expect(valueOf('starttod', '202')).toBe('14:30:05.000');
    });

    it('blanks a boundary the race never reached', async () => {
      await service.submit(EVENT, {
        bibs: ['101'],
        raceMode: 'single',
        boundaries: [
          { stageId: 'race_start', boundaryAt: at(0) },
          { stageId: 'run_1', boundaryAt: at(10) },
        ],
      });

      expect(valueOf('run1tod')).toBe('14:30:10.000');
      // Blank clears it, so re-submitting a corrected race can take a value
      // away rather than only overwrite it.
      expect(valueOf('station6tod')).toBe('');
      expect(valueOf('finishtod')).toBe('');
    });

    it('goes out under the name the event maps it to', async () => {
      rr.loadConfig = jest.fn(() =>
        Promise.resolve({
          updateApiUrl: UPDATE_URL,
          updateMapping: { finishtod: 'FinishClock' },
          timeZone: 'Asia/Kolkata',
        }),
      );

      await service.submit(EVENT, {
        bibs: ['101'],
        raceMode: 'single',
        boundaries: soloBoundaries(),
      });

      expect(valueOf('FinishClock')).toBe('14:33:20.000');
      expect(valueOf('finishtod')).toBeUndefined();
    });
  });

  it('writes the same race to both partners of a doubles team', async () => {
    await service.submit(EVENT, {
      bibs: ['201', '202'],
      raceMode: 'doubles',
      boundaries: [
        { stageId: 'race_start', boundaryAt: at(0) },
        { stageId: 'team_start', boundaryAt: at(5) },
        { stageId: 'run_1', boundaryAt: at(20) },
      ],
    });

    // A doubles run is measured from team_start, not from race_start.
    expect(valueOf('run1time', '201')).toBe('15.000');
    expect(valueOf('run1time', '202')).toBe('15.000');
    expect(new Set(writes.map((w) => w.bib))).toEqual(new Set(['201', '202']));
  });

  describe('station outcomes', () => {
    const submit = (outcome: any, contestId = '5') =>
      service.submit(EVENT, {
        bibs: ['101'],
        raceMode: 'single',
        contestId,
        boundaries: soloBoundaries(),
        stationOutcomes: [outcome],
      });

    it('writes a Bear Crawl penalty where the contest allows one', async () => {
      await submit({ stationNumber: 3, outcome: 'penalty', penaltySeconds: 10 });
      expect(valueOf('station3penalty')).toBe('10');
      // 0, not blank: these are summed on the RaceResult side.
      expect(valueOf('station3ics')).toBe('0');
    });

    it('writes an ICS as a flag, and its penalty as a real zero', async () => {
      // An ICS carries no seconds by rule, so the penalty is 0 rather than
      // empty — an empty cell reads as "not judged", which is a different
      // thing from "judged, nothing to report".
      await submit({ stationNumber: 4, outcome: 'ics', penaltySeconds: 0 });
      expect(valueOf('station4ics')).toBe('1');
      expect(valueOf('station4penalty')).toBe('0');
    });

    it('zeroes both fields for a clean station', async () => {
      await submit({ stationNumber: 2, outcome: 'none', penaltySeconds: 0 });
      expect(valueOf('station2penalty')).toBe('0');
      expect(valueOf('station2ics')).toBe('0');
    });

    it('overwrites a previous attempt rather than leaving it standing', async () => {
      // The reason every judged station is written even when clean: a re-run
      // that skipped the field would leave the earlier penalty in place.
      await submit({ stationNumber: 3, outcome: 'none', penaltySeconds: 0 });
      expect(valueOf('station3penalty')).toBe('0');
    });

    it('refuses a penalty at a station that has no penalty', async () => {
      await expect(
        submit({ stationNumber: 1, outcome: 'penalty', penaltySeconds: 10 }),
      ).rejects.toThrow(/cannot be recorded/);
      expect(writes).toHaveLength(0);
    });

    it('refuses a Bear Crawl penalty in a contest exempt from it', async () => {
      await expect(
        submit({ stationNumber: 3, outcome: 'penalty', penaltySeconds: 10 }, '1'),
      ).rejects.toThrow(/cannot be recorded/);
    });

    // Station 2 (Farmer's Carry) Incomplete Laps: the app added this control
    // (commit 4e8515e) for contests 5, 6, 7, 8, 10, 11, 12, 13 without a
    // matching backend change, so a judge using it got the WHOLE race
    // rejected at the finish line — every split, every other station, gone
    // with it, and no way to recover without a code fix.
    it.each(['5', '6', '7', '8', '10', '11', '12', '13'])(
      'writes an Incomplete Laps penalty at station 2 for contest %s',
      async (contestId) => {
        await submit(
          { stationNumber: 2, outcome: 'penalty', penaltySeconds: 120 },
          contestId,
        );
        expect(valueOf('station2penalty')).toBe('120');
        expect(valueOf('station2ics')).toBe('0');
      },
    );

    it('refuses an Incomplete Laps penalty at station 2 outside its contests', async () => {
      await expect(
        submit({ stationNumber: 2, outcome: 'penalty', penaltySeconds: 120 }, '1'),
      ).rejects.toThrow(/cannot be recorded/);
      expect(writes).toHaveLength(0);
    });

    it('refuses the Bear Crawl amount at station 2, even in an allowed contest', async () => {
      // The two controls are not interchangeable: 120s belongs to station 2,
      // 10s to station 3, and a mix-up must not slip through as "some number".
      await expect(
        submit({ stationNumber: 2, outcome: 'penalty', penaltySeconds: 10 }, '5'),
      ).rejects.toThrow(/cannot be recorded/);
    });

    it('refuses an ICS carrying seconds', async () => {
      await expect(
        submit({ stationNumber: 3, outcome: 'ics', penaltySeconds: 10 }),
      ).rejects.toThrow(/cannot be recorded/);
    });
  });

  describe('cognitive scoring', () => {
    const sequence = ['R', 'G', 'B', 'Y', 'R', 'G', 'B', 'Y', 'R', 'G'];
    const withResponse = (response: string[]) =>
      service.submit(EVENT, {
        bibs: ['101'],
        raceMode: 'single',
        boundaries: soloBoundaries(),
        cognitive: { sequence, response },
      });

    it('awards the bonus for a perfect recall', async () => {
      await withResponse([...sequence]);
      expect(valueOf('cognitiveskillbonus')).toBe('30');
      expect(valueOf('cognitiveskillpenalty')).toBe('0');
    });

    it('applies the penalty at or below 60 percent', async () => {
      await withResponse(['R', 'G', 'B', 'Y', 'R', 'X', 'X', 'X', 'X', 'X']);
      expect(valueOf('cognitiveskillpenalty')).toBe('30');
      expect(valueOf('cognitiveskillbonus')).toBe('0');
    });

    it('does neither in between', async () => {
      await withResponse(['R', 'G', 'B', 'Y', 'R', 'G', 'B', 'X', 'X', 'X']);
      expect(valueOf('cognitiveskillpenalty')).toBe('0');
      expect(valueOf('cognitiveskillbonus')).toBe('0');
    });

    it('writes the sequence shown and the response recalled, raw', async () => {
      await withResponse(['R', 'G', 'B', 'Y', 'R', 'X', 'X', 'X', 'X', 'X']);
      expect(valueOf('cognitivepattershown')).toBe('RGBYRGBYRG');
      expect(valueOf('cognitiverecalled')).toBe('RGBYRXXXXX');
    });

    it('refuses a sequence that is not a real one', async () => {
      await expect(
        service.submit(EVENT, {
          bibs: ['101'],
          raceMode: 'single',
          boundaries: soloBoundaries(),
          cognitive: { sequence: ['R', 'PURPLE'], response: [] },
        }),
      ).rejects.toThrow(/cognitive sequence is invalid/);
    });
  });

  describe('refusals before anything is written', () => {
    const base = { raceMode: 'single' as const, boundaries: soloBoundaries() };

    it('refuses a race with no bib', async () => {
      await expect(service.submit(EVENT, { ...base, bibs: [] })).rejects.toThrow(
        /At least one BIB/,
      );
    });

    it('refuses a non-numeric bib', async () => {
      await expect(
        service.submit(EVENT, { ...base, bibs: ['A1'] }),
      ).rejects.toThrow(/must be numeric/);
    });

    it('refuses a doubles race that is not two athletes', async () => {
      await expect(
        service.submit(EVENT, { ...base, raceMode: 'doubles', bibs: ['1'] }),
      ).rejects.toThrow(/doubles race is two athletes/);
    });

    it('refuses a race with no timings at all', async () => {
      await expect(
        service.submit(EVENT, { bibs: ['101'], raceMode: 'single', boundaries: [] }),
      ).rejects.toThrow(/no timings/);
    });

    it('refuses a boundary with an unreadable time', async () => {
      await expect(
        service.submit(EVENT, {
          bibs: ['101'],
          raceMode: 'single',
          boundaries: [{ stageId: 'race_start', boundaryAt: 'nonsense' }],
        }),
      ).rejects.toThrow(/no readable boundary time/);
    });

    it('refuses when the event has no RaceResult update endpoint', async () => {
      rr.canWrite.mockReturnValue(false);
      await expect(
        service.submit(EVENT, { ...base, bibs: ['101'] }),
      ).rejects.toThrow(/no RaceResult update endpoint/);
      expect(writes).toHaveLength(0);
    });
  });

  it('honours an event that renamed a field', async () => {
    rr.loadConfig.mockResolvedValue({
      updateApiUrl: UPDATE_URL,
      updateMapping: { totalracetime: 'FinalTime' },
    });
    await service.submit(EVENT, {
      bibs: ['101'],
      raceMode: 'single',
      boundaries: soloBoundaries(),
    });
    expect(valueOf('FinalTime')).toBe('200.000');
    expect(valueOf('totalracetime')).toBeUndefined();
  });

  it('writes the note and the status when they are given', async () => {
    await service.submit(EVENT, {
      bibs: ['101'],
      raceMode: 'single',
      boundaries: soloBoundaries(),
      athleteNote: 'Slipped at station 4',
      status: 'FIN',
    });
    expect(valueOf('athletenotes')).toBe('Slipped at station 4');
    expect(valueOf('Status')).toBe('FIN');
  });

  describe('station notes', () => {
    const withNote = (note: string) => ({
      bibs: ['101'],
      raceMode: 'single' as const,
      boundaries: [
        { stageId: 'race_start', boundaryAt: '2026-08-15T10:00:00.000Z' },
        { stageId: 'finish_line', boundaryAt: '2026-08-15T10:03:20.000Z' },
      ],
      stationOutcomes: [
        { stationNumber: 1, outcome: 'none' as const, penaltySeconds: 0, note },
        { stationNumber: 2, outcome: 'none' as const, penaltySeconds: 0, note: '' },
      ],
    });

    it('writes the judge’s note against its station', async () => {
      await service.submit(EVENT, withNote('Slipped on the mat'));
      expect(valueOf('station1note')).toBe('Slipped on the mat');
    });

    it('clears the other stations when any note is present', async () => {
      // Otherwise a note removed on a re-submission would stand.
      await service.submit(EVENT, withNote('Slipped on the mat'));
      expect(valueOf('station2note')).toBe('');
    });

    it('writes an empty note for a station with nothing to report', async () => {
      // Blank, not skipped: an unwritten field leaves a previous attempt's note
      // standing, and clearing a note has to actually clear it.
      await service.submit(EVENT, withNote(''));
      expect(valueOf('station1note')).toBe('');
      expect(valueOf('station2note')).toBe('');
    });
  });

  describe('completion status', () => {
    // RaceResult's BUILT-IN `Status` vocabulary — the same one every live
    // results and statistics view reads via `getParticipantStatus` in
    // `publicRoutes/utils/live-helpers.ts`: 0 = Completed, 1 = OOC, 2 = DSQ,
    // 3 = DNF, 4 = DNS. A clean finish must never collide with OOC — that
    // collision is what made every finisher indistinguishable from an athlete
    // who never completed the course.
    const race = {
      bibs: ['101'],
      raceMode: 'single' as const,
      boundaries: soloBoundaries(),
    };

    it('marks a clean finish Completed, not OOC', async () => {
      // Handing the race in IS the completion — it does not wait to be asked.
      await service.submit(EVENT, race);
      expect(valueOf('Status')).toBe('0');
    });

    it('marks both athletes of a clean pair Completed', async () => {
      await service.submit(EVENT, {
        ...race,
        bibs: ['201', '202'],
        raceMode: 'doubles',
      });
      expect(valueOf('Status', '201')).toBe('0');
      expect(valueOf('Status', '202')).toBe('0');
    });

    it('marks the athlete OOC when any station was recorded ICS', async () => {
      await service.submit(EVENT, {
        ...race,
        stationOutcomes: [
          { stationNumber: 4, outcome: 'ics', penaltySeconds: 0 },
        ],
      });
      expect(valueOf('Status')).toBe('1');
    });

    it('marks both athletes of a pair OOC when any station was ICS', async () => {
      await service.submit(EVENT, {
        ...race,
        bibs: ['201', '202'],
        raceMode: 'doubles',
        stationOutcomes: [
          { stationNumber: 2, outcome: 'ics', penaltySeconds: 0 },
        ],
      });
      expect(valueOf('Status', '201')).toBe('1');
      expect(valueOf('Status', '202')).toBe('1');
    });

    it('is not thrown off OOC by a clean station judged alongside an ICS one', async () => {
      await service.submit(EVENT, {
        ...race,
        stationOutcomes: [
          { stationNumber: 3, outcome: 'none', penaltySeconds: 0 },
          { stationNumber: 4, outcome: 'ics', penaltySeconds: 0 },
        ],
      });
      expect(valueOf('Status')).toBe('1');
    });

    it('stays Completed when every judged station is clean', async () => {
      await service.submit(EVENT, {
        ...race,
        stationOutcomes: [
          { stationNumber: 3, outcome: 'penalty', penaltySeconds: 10 },
        ],
        contestId: '5',
      });
      expect(valueOf('Status')).toBe('0');
    });

    it('lets an explicit status override the derivation', async () => {
      await service.submit(EVENT, { ...race, status: '4' });
      expect(valueOf('Status')).toBe('4');
    });

    it('lets an explicit status override even an ICS-derived OOC', async () => {
      await service.submit(EVENT, {
        ...race,
        status: '3',
        stationOutcomes: [
          { stationNumber: 4, outcome: 'ics', penaltySeconds: 0 },
        ],
      });
      expect(valueOf('Status')).toBe('3');
    });

    it('honours a renamed field', async () => {
      rr.loadConfig = jest.fn(async () => ({
        updateApiUrl: UPDATE_URL,
        updateMapping: { status: 'RaceStatus' },
      }));
      await service.submit(EVENT, race);
      expect(valueOf('RaceStatus')).toBe('0');
      expect(valueOf('Status')).toBeUndefined();
    });
  });

  describe('statusofathelet — the "has raced" flag', () => {
    // A DIFFERENT vocabulary from `Status` above, on purpose. This one is a
    // custom field and a plain yes/no flag, and `buildCheckinRoster` reads it
    // back through `readRecordFlag` to decide whether an athlete may be claimed
    // again. Writing a `Status` code into it inverted that read: once
    // RACE_COMPLETED_STATUS was corrected to '0', every clean finisher was
    // stamped 0, read back as NOT completed, and handed to the roster as Ready
    // for a second judge to re-run over the top of the real result.
    //
    // So these assert the ROUND TRIP, not just the value: what is written here
    // has to satisfy the reader that consumes it.
    const race = {
      bibs: ['101'],
      raceMode: 'single' as const,
      boundaries: soloBoundaries(),
    };

    /** The flag as the roster reads it back off the participant feed. */
    const readsAsCompleted = (bib = '101') =>
      readRecordFlag({ statusofathelet: valueOf('statusofathelet', bib) }, 'statusofathelet');

    it('marks a clean finisher as having raced', async () => {
      await service.submit(EVENT, race);
      expect(valueOf('statusofathelet')).toBe('1');
      expect(readsAsCompleted()).toBe(true);
    });

    it('is not a copy of Status — the two disagree on a clean finish', async () => {
      await service.submit(EVENT, race);
      expect(valueOf('Status')).toBe('0');
      expect(valueOf('statusofathelet')).toBe('1');
    });

    it('marks an OOC athlete as having raced too', async () => {
      // An ICS ends the race. The athlete did not finish the course, but they
      // are done, and re-running them would overwrite the real record.
      await service.submit(EVENT, {
        ...race,
        stationOutcomes: [
          { stationNumber: 4, outcome: 'ics', penaltySeconds: 0 },
        ],
      });
      expect(valueOf('Status')).toBe('1');
      expect(valueOf('statusofathelet')).toBe('1');
      expect(readsAsCompleted()).toBe(true);
    });

    it('is set regardless of ICS and penalties, together on one race', async () => {
      // The worst race the format allows: a station abandoned, and seconds
      // added at both stations that can carry them. This field answers ONE
      // question — did the athlete finish their race — and none of that
      // changes the answer. Anything that reads it (the roster, the claim
      // gate) must see the same `1` a clean finisher gets.
      await service.submit(EVENT, {
        ...race,
        contestId: '10',
        stationOutcomes: [
          { stationNumber: 2, outcome: 'penalty', penaltySeconds: 120 },
          { stationNumber: 3, outcome: 'penalty', penaltySeconds: 10 },
          { stationNumber: 5, outcome: 'ics', penaltySeconds: 0 },
        ],
      });
      expect(valueOf('statusofathelet')).toBe('1');
      expect(readsAsCompleted()).toBe(true);
      // The penalties and the OOC status still land on their own fields —
      // the flag says "done", the other fields say how it went.
      expect(valueOf('station2penalty')).toBe('120');
      expect(valueOf('station3penalty')).toBe('10');
      expect(valueOf('station5ics')).toBe('1');
      expect(valueOf('Status')).toBe('1');
    });

    it('marks both athletes of a pair', async () => {
      await service.submit(EVENT, {
        ...race,
        bibs: ['201', '202'],
        raceMode: 'doubles',
      });
      expect(readsAsCompleted('201')).toBe(true);
      expect(readsAsCompleted('202')).toBe(true);
    });

    it('stays set when an explicit status overrides the derivation', async () => {
      // '3' is DNF on the built-in vocabulary. The race was still handed in.
      await service.submit(EVENT, { ...race, status: '3' });
      expect(valueOf('Status')).toBe('3');
      expect(valueOf('statusofathelet')).toBe('1');
      expect(readsAsCompleted()).toBe(true);
    });

    it('honours a renamed field', async () => {
      rr.loadConfig = jest.fn(async () => ({
        updateApiUrl: UPDATE_URL,
        updateMapping: { statusofathelet: 'AthleteDone' },
      }));
      await service.submit(EVENT, race);
      expect(valueOf('AthleteDone')).toBe('1');
      expect(valueOf('statusofathelet')).toBeUndefined();
    });
  });

  describe('judgedby', () => {
    const race = {
      bibs: ['101'],
      raceMode: 'single' as const,
      boundaries: soloBoundaries(),
    };

    it('stamps the judge who handed the race in', async () => {
      await service.submit(EVENT, race, 'JDG-04');
      expect(valueOf('jugedby')).toBe('JDG-04');
    });

    it('takes it from the session, not the payload', async () => {
      // Attribution a client can set is not attribution.
      await service.submit(
        EVENT,
        { ...race, judgedBy: 'SOMEONE-ELSE' } as any,
        'JDG-04',
      );
      expect(valueOf('jugedby')).toBe('JDG-04');
    });

    it('writes both athletes on a doubles submission', async () => {
      await service.submit(
        EVENT,
        { ...race, bibs: ['201', '202'], raceMode: 'doubles' },
        'JDG-04',
      );
      expect(valueOf('jugedby', '201')).toBe('JDG-04');
      expect(valueOf('jugedby', '202')).toBe('JDG-04');
    });

    it('leaves the claim-time value alone when no judge is known', async () => {
      await service.submit(EVENT, race);
      expect(valueOf('jugedby')).toBeUndefined();
    });
  });

  describe('a race with no recall', () => {
    // The failure this pins: the app sent an EMPTY cognitive block, the whole
    // submission was rejected before a single write, and every split and
    // station went with it. A race without a recall must still deliver its
    // timings — those are what the athlete's result is made of.
    const noRecall = {
      bibs: ['101'],
      raceMode: 'single' as const,
      boundaries: soloBoundaries(),
    };

    it('writes every timing field when the cognitive block is omitted', async () => {
      await service.submit(EVENT, noRecall);
      expect(valueOf('totalracetime')).toBe('200.000');
      expect(valueOf('run1time')).toBe('10.000');
    });

    it('writes no cognitive fields for it', async () => {
      await service.submit(EVENT, noRecall);
      expect(valueOf('cognitiveskillpenalty')).toBeUndefined();
      expect(valueOf('cognitiveskillbonus')).toBeUndefined();
      expect(valueOf('cognitivepattershown')).toBeUndefined();
      expect(valueOf('cognitiverecalled')).toBeUndefined();
    });

    it('rejects an EMPTY block rather than treating it as absent', async () => {
      // Present-but-malformed is a client bug and says so, naming what it got.
      await expect(
        service.submit(EVENT, {
          ...noRecall,
          cognitive: { sequence: [], response: [] },
        }),
      ).rejects.toThrow(/0 colours: none/);
    });

    it('rejects lower-case colours, naming what it received', async () => {
      // Dart's enum `.name` is lower-case where `.key` is upper — the exact
      // slip that made every race unsubmittable.
      await expect(
        service.submit(EVENT, {
          ...noRecall,
          cognitive: {
            sequence: ['r', 'b', 'g', 'y', 'r', 'g', 'b', 'y', 'g', 'r'],
            response: ['r', 'b', 'g', 'y', 'r', 'g', 'b', 'y', 'g', 'r'],
          },
        }),
      ).rejects.toThrow(/10 colours: rbgyrgbygr/);
    });
  });
});
