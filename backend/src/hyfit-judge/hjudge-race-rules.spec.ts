import {
  allowsBearCrawlPenalty,
  allowsIncompleteLapsPenalty,
  cognitiveAdjustment,
  chooseUniqueCognitiveSequence,
  finalSegmentTimings,
  generateCognitiveSequence,
  isValidCognitiveSequence,
  penaltySecondsForStationOutcome,
  scoreSequence,
  timingBackupValues,
  validateStationOutcome,
} from './hjudge-race-rules';

describe('HYFIT Judge race rules', () => {
  it('generates a valid per-race cognitive sequence', () => {
    let choice = 0;
    const sequence = generateCognitiveSequence((maximum) => choice++ % maximum);
    expect(sequence).toHaveLength(10);
    expect(new Set(sequence)).toEqual(new Set(['R', 'G', 'B', 'Y']));
    expect(isValidCognitiveSequence(sequence)).toBe(true);
    expect(scoreSequence([...sequence], sequence)).toEqual({
      correctCount: 10,
      percentage: 100,
    });
    expect(cognitiveAdjustment([...sequence], sequence)).toMatchObject({
      penaltySeconds: 0,
      bonusSeconds: 30,
    });
  });

  it('rejects malformed and predictable sequence shapes', () => {
    expect(isValidCognitiveSequence(['R'])).toBe(false);
    expect(isValidCognitiveSequence('RGBYRGBYRG')).toBe(false);
    expect(isValidCognitiveSequence('RRRGBYRGBY'.split(''))).toBe(false);
    expect(isValidCognitiveSequence('RGRGRGRGRG'.split(''))).toBe(false);
  });

  it('uses fresh secure randomness instead of one global answer key', () => {
    const generated = Array.from({ length: 50 }, () =>
      generateCognitiveSequence().join(''),
    );
    expect(new Set(generated).size).toBeGreaterThan(45);
  });

  it('retries collisions and fails closed when uniqueness cannot be obtained', () => {
    const first = 'RBGYRGBYGR'.split('');
    const second = 'RYGBRGBYGR'.split('');
    let calls = 0;
    expect(
      chooseUniqueCognitiveSequence(new Set([first.join('')]), () =>
        calls++ === 0 ? first : second,
      ),
    ).toEqual(second);
    expect(() =>
      chooseUniqueCognitiveSequence(new Set([first.join('')]), () => first),
    ).toThrow('Unable to assign a unique cognitive sequence');
  });

  it('accepts ICS with an omitted or populated note', () => {
    expect(validateStationOutcome(1, 'ics', 0, '')).toBe(true);
    expect(validateStationOutcome(6, 'ics', 0, 'Equipment issue')).toBe(true);
    expect(validateStationOutcome(2, 'ics', 10, '')).toBe(false);
  });

  // Station 2 (Farmer's Carry) Incomplete Laps and Station 3 (Bear Crawl) are
  // the two stations that can carry a real penalty. Must stay in step with
  // `_incompleteLapsPenaltyContests` / `_bearCrawlPenaltyExemptContests` in
  // `hyfit_judge/lib/models/race_format.dart` — the tablet is what shows the
  // control, this is what accepts the race it produces, and the two drifting
  // apart is what rejected every Station 2 penalty submitted after the
  // tablet added the control (the whole race, not just the field).
  describe('station penalties', () => {
    it('allows the Incomplete Laps penalty at station 2 in its contests', () => {
      for (const contestId of ['5', '6', '7', '8', '10', '11', '12', '13']) {
        expect(allowsIncompleteLapsPenalty(contestId)).toBe(true);
        expect(penaltySecondsForStationOutcome(2, contestId)).toBe(120);
        expect(validateStationOutcome(2, 'penalty', 120, '', contestId)).toBe(
          true,
        );
      }
    });

    it('refuses the Incomplete Laps penalty at station 2 outside its contests', () => {
      for (const contestId of ['1', '2', '3', '4', '9', '', 'unknown']) {
        expect(allowsIncompleteLapsPenalty(contestId)).toBe(false);
        expect(penaltySecondsForStationOutcome(2, contestId)).toBe(0);
        expect(validateStationOutcome(2, 'penalty', 120, '', contestId)).toBe(
          false,
        );
      }
    });

    it('refuses the Bear Crawl amount at station 2 and the Laps amount at station 3', () => {
      expect(validateStationOutcome(2, 'penalty', 10, '', '5')).toBe(false);
      expect(validateStationOutcome(3, 'penalty', 120, '', '5')).toBe(false);
    });

    it('still allows the Bear Crawl penalty at station 3 where the contest allows one', () => {
      expect(allowsBearCrawlPenalty('5')).toBe(true);
      expect(penaltySecondsForStationOutcome(3, '5')).toBe(10);
      expect(validateStationOutcome(3, 'penalty', 10, '', '5')).toBe(true);
    });

    it('still refuses the Bear Crawl penalty at station 3 in an exempt contest', () => {
      for (const contestId of ['1', '2', '3', '4', '9']) {
        expect(allowsBearCrawlPenalty(contestId)).toBe(false);
        expect(penaltySecondsForStationOutcome(3, contestId)).toBe(0);
        expect(validateStationOutcome(3, 'penalty', 10, '', contestId)).toBe(
          false,
        );
      }
    });

    it('offers no penalty at any other station regardless of contest', () => {
      for (const stationNumber of [1, 4, 5, 6]) {
        expect(penaltySecondsForStationOutcome(stationNumber, '5')).toBe(0);
        expect(
          validateStationOutcome(stationNumber, 'penalty', 10, '', '5'),
        ).toBe(false);
      }
    });
  });

  it('derives the two final timing segments from persisted boundaries', () => {
    expect(
      finalSegmentTimings([
        { stageId: 'run_6', boundaryAt: '2026-08-08T10:00:00.000Z' },
        { stageId: 'cognitive_recall', boundaryAt: '2026-08-08T10:01:15.000Z' },
        { stageId: 'finish_line', boundaryAt: '2026-08-08T10:01:27.500Z' },
      ]),
    ).toEqual({
      tyreFlipRecallMs: 75000,
      recallToFinishMs: 12500,
      recallCompletedAt: '2026-08-08T10:01:15.000Z',
    });
  });

  it('calculates all single timing backups from authoritative boundaries', () => {
    const splits = [
      ['race_start', 0],
      ['cognitive_memorise', 2000],
      ['run_1', 4000],
      ['station_1', 6000],
      ['run_2', 8000],
      ['station_2', 10000],
      ['run_3', 12000],
      ['station_3', 14000],
      ['run_4', 16000],
      ['station_4', 18000],
      ['run_5', 20000],
      ['station_5', 22000],
      ['run_6', 24000],
      ['station_6', 26000],
      ['cognitive_recall', 28000],
      ['finish_line', 30000],
    ].map(([stageId, milliseconds]) => ({
      stageId: String(stageId),
      boundaryAt: new Date(Number(milliseconds)),
    }));
    const values = timingBackupValues(splits, 'single');
    expect(Object.keys(values)).toHaveLength(17);
    expect(values.cognitivememorisetime).toBe(2000);
    expect(values.run1time).toBe(4000);
    expect(values.station6time).toBe(2000);
    expect(values.cognitiverecalltime).toBe(2000);
    expect(values.tyrefliprecalltime).toBe(4000);
    expect(values.recalltofinishtime).toBe(2000);
    expect(values.totalracetime).toBe(30000);

    const doubles = timingBackupValues(
      [...splits, { stageId: 'team_start', boundaryAt: new Date(3000) }],
      'doubles',
    );
    expect(doubles.cognitivememorisetime).toBe(2000);
    expect(doubles.run1time).toBe(1000);
    expect(doubles.totalracetime).toBe(27000);
  });

  it('leaves backups unavailable until both boundaries exist', () => {
    const values = timingBackupValues(
      [
        { stageId: 'race_start', boundaryAt: new Date(0) },
        { stageId: 'run_1', boundaryAt: new Date(4000) },
      ],
      'single',
    );
    expect(values.run1time).toBe(4000);
    expect(values.station1time).toBeNull();
    expect(values.totalracetime).toBeNull();
  });
});
