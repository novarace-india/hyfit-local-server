import {
  buildCheckinRoster,
  checkinFieldNames,
  findTeammates,
  readRecordField,
  stageWriteTargets,
  bibKey,
  assetKey,
  teamWarning,
} from './hjudge-checkin-rr.util';

// The shape this event's Custom API actually answers with, verified against
// http://raceresults.novarace.in/_386828 — separate first/last name columns, a
// capitalised `Club`, and a lower-case `wristbandid` where the write mapping
// says `wristbandID`.
const feedRow = (over: Record<string, unknown> = {}) => ({
  Bib: 11651,
  'First Name': 'Thomas',
  Lastname: 'Laurent',
  Contest: 'Bloodline Doubles',
  ContestID: 9,
  Age: 28,
  Gender: 'Male',
  Club: 'C09-TEAM-001',
  DateOfBirth: '1998-07-28',
  mobile: '+919000001651',
  Wave: 'Wave 01',
  TimeSlot: '6:00 PM - 8:00 PM',
  ContestDate: '2026-08-15',
  AgeGroup: '25-34',
  Transponder1: '7001651',
  wristbandid: '',
  ...over,
});

const participantMapping = {
  bib: 'bib',
  club: 'club',
  name: 'name',
  gender: 'Gender',
  listPath: '',
  contestId: 'ContestID',
  dateOfBirth: 'DateOfBirth',
};

const updateMapping = {
  wristband: 'wristbandID',
  transponder1: 'Transponder1',
  stage1checkin: 'stage1checkin',
  stage2checkin: 'stage2checkin',
  stage1checkintime: 'stage1checkintime',
  stage2checkintime: 'stage2checkintime',
};

const build = (rows: unknown[]) =>
  buildCheckinRoster(rows, participantMapping, updateMapping);

describe('readRecordField', () => {
  it('finds a field whose case differs from the mapping', () => {
    // The write mapping says wristbandID; the feed column is wristbandid.
    // Requiring these to agree would make every check-in look outstanding.
    expect(readRecordField(feedRow({ wristbandid: 'A-11111' }), 'wristbandID')).toBe(
      'A-11111',
    );
  });

  it('ignores punctuation when matching', () => {
    expect(readRecordField({ 'First Name': 'Thomas' }, 'firstname')).toBe('Thomas');
  });

  it('returns empty for a blank or missing field', () => {
    expect(readRecordField(feedRow(), 'wristbandID')).toBe('');
    expect(readRecordField(feedRow(), 'nosuchfield')).toBe('');
  });
});

describe('comparison keys', () => {
  it('treats leading zeros on a bib as presentation', () => {
    expect(bibKey('009900')).toBe(bibKey('9900'));
  });

  it('folds case and leading zeros on an asset code', () => {
    expect(assetKey('  A-11111 ')).toBe('a-11111');
    expect(assetKey('009900')).toBe(assetKey('9900'));
  });

  it('keeps an all-zero code rather than reducing it to nothing', () => {
    expect(bibKey('000')).toBe('000');
  });
});

describe('buildCheckinRoster', () => {
  it('reads identity through the shared importer, including split names', () => {
    const roster = build([feedRow()]);
    const entry = roster.byBib.get('11651')!;
    expect(entry.person.name).toBe('Thomas Laurent');
    expect(entry.person.category).toBe('Bloodline Doubles');
    expect(entry.person.contestId).toBe('9');
    expect(entry.person.club).toBe('C09-TEAM-001');
    expect(entry.person.timeslot).toBe('6:00 PM - 8:00 PM');
    expect(entry.person.contestDate).toBe('2026-08-15');
  });

  it('carries the wristband and transponder off the record', () => {
    const roster = build([feedRow({ wristbandid: 'A-11111' })]);
    const entry = roster.byBib.get('11651')!;
    expect(entry.person.wristbandCode).toBe('A-11111');
    expect(entry.person.transponderCode).toBe('7001651');
  });

  // The feed returns these as JSON booleans. Read as text, `false` becomes the
  // truthy string "false" and every athlete on the start list looks checked in.
  describe('boolean status fields', () => {
    it('reads a false flag as not checked in', () => {
      const roster = build([
        feedRow({ stage1checkin: false, stage2checkin: false }),
      ]);
      const entry = roster.byBib.get('11651')!;
      expect(roster.publishesStageStatus).toBe(true);
      expect(entry.stages.STAGE_1_WRISTBAND).toBeUndefined();
      expect(entry.stages.STAGE_2_TRANSPONDER).toBeUndefined();
    });

    it('reads a true flag as checked in', () => {
      const roster = build([
        feedRow({
          stage1checkin: true,
          stage1checkintime: '2026-08-15 09:14:02',
          wristbandid: 'A-11111',
        }),
      ]);
      const stage = roster.byBib.get('11651')!.stages.STAGE_1_WRISTBAND!;
      expect(stage.assetCode).toBe('A-11111');
      expect(stage.completedAt).toBe('2026-08-15 09:14:02');
    });

    it.each([
      [1, true],
      [0, false],
      ['1', true],
      ['0', false],
      ['true', true],
      ['false', false],
      ['COMPLETED', true],
      ['', false],
      [null, false],
    ])('reads %p as %p', (value, expected) => {
      const roster = build([feedRow({ stage1checkin: value })]);
      expect(Boolean(roster.byBib.get('11651')!.stages.STAGE_1_WRISTBAND)).toBe(
        expected,
      );
    });

    it('lets a cleared flag override a wristband still in the row', () => {
      // An organiser who clears stage1checkin to undo a check-in means it. The
      // band left behind in the row must not out-vote them.
      const roster = build([
        feedRow({ stage1checkin: false, wristbandid: 'A-11111' }),
      ]);
      expect(roster.byBib.get('11651')!.stages.STAGE_1_WRISTBAND).toBeUndefined();
    });
  });

  it('reports stage 1 complete when the feed publishes the status', () => {
    const roster = build([
      feedRow({
        stage1checkin: 'COMPLETED',
        stage1checkintime: '2026-08-15 09:14:02',
        wristbandid: 'A-11111',
      }),
    ]);
    const stage = roster.byBib.get('11651')!.stages.STAGE_1_WRISTBAND!;
    expect(stage.state).toBe('completed');
    expect(stage.completedAt).toBe('2026-08-15 09:14:02');
    expect(stage.assetCode).toBe('A-11111');
    expect(roster.publishesStageStatus).toBe(true);
  });

  it('falls back to a recorded wristband when the feed omits the status field', () => {
    // This event's read API publishes no stage1checkin column, but a wristband
    // against a bib only gets there one way.
    const roster = build([feedRow({ wristbandid: 'A-11111' })]);
    expect(roster.byBib.get('11651')!.stages.STAGE_1_WRISTBAND?.state).toBe(
      'completed',
    );
    expect(roster.publishesStageStatus).toBe(false);
  });

  it('never infers stage 2 from a pre-populated transponder', () => {
    // Transponder1 is filled in for the whole field before the event opens.
    // Reading it as a hand-over would mark all 3 000 athletes checked in.
    const roster = build([feedRow({ Transponder1: '7001651' })]);
    expect(roster.byBib.get('11651')!.stages.STAGE_2_TRANSPONDER).toBeUndefined();
  });

  it('reports stage 2 complete only from its status field', () => {
    const roster = build([
      feedRow({ stage2checkin: 'COMPLETED', stage2checkintime: '2026-08-15 10:00:00' }),
    ]);
    const stage = roster.byBib.get('11651')!.stages.STAGE_2_TRANSPONDER!;
    expect(stage.assetCode).toBe('7001651');
    expect(stage.completedAt).toBe('2026-08-15 10:00:00');
  });
});

describe('checkinFieldNames', () => {
  it('falls back to the built-in defaults for an empty mapping', () => {
    expect(checkinFieldNames({})).toEqual({
      judgedBy: 'jugedby',
      statusOfAthlete: 'statusofathelet',
      stage1Status: 'stage1checkin',
      stage1Time: 'stage1checkintime',
      wristband: 'wristbandID',
      wristbandAssignedBy: 'wristbandidAssignedBy',
      stage2Status: 'stage2checkin',
      stage2Time: 'stage2checkintime',
      transponder: 'Transponder1',
      transponderAssignedBy: 'transponderAssignedBy',
    });
  });

  it('honours an event that renamed a field', () => {
    expect(checkinFieldNames({ wristband: 'BandNo' }).wristband).toBe('BandNo');
  });

  it('reads a mirrored field from the first column only', () => {
    expect(
      checkinFieldNames({ transponder1: ['Transponder1', 'chipused'] })
        .transponder,
    ).toBe('Transponder1');
  });
});

describe('stageWriteTargets', () => {
  it('hands a stage every column its four steps write', () => {
    expect(stageWriteTargets({}, 'STAGE_2_TRANSPONDER')).toEqual({
      status: ['stage2checkin'],
      time: ['stage2checkintime'],
      asset: ['Transponder1'],
      assignedBy: ['transponderAssignedBy'],
    });
    expect(stageWriteTargets({}, 'STAGE_1_WRISTBAND').asset).toEqual([
      'wristbandID',
    ]);
  });

  it('mirrors a transponder into every column the event asked for', () => {
    expect(
      stageWriteTargets(
        { transponder1: ['Transponder1', 'chipused'] },
        'STAGE_2_TRANSPONDER',
      ).asset,
    ).toEqual(['Transponder1', 'chipused']);
  });

  it('leaves the other stage alone', () => {
    expect(
      stageWriteTargets(
        { transponder1: ['Transponder1', 'chipused'] },
        'STAGE_1_WRISTBAND',
      ).asset,
    ).toEqual(['wristbandID']);
  });
});

describe('findTeammates', () => {
  it('pairs a doubles entry with the other athlete sharing its club', () => {
    const roster = build([
      feedRow({ Bib: 11651, Club: 'C09-TEAM-001' }),
      feedRow({ Bib: 11652, Club: 'C09-TEAM-001', 'First Name': 'Nikolai' }),
      feedRow({ Bib: 11653, Club: 'C09-TEAM-002', 'First Name': 'Alexander' }),
    ]);
    const entry = roster.byBib.get('11651')!;
    const mates = findTeammates(roster, entry);
    expect(mates.map((m) => m.person.bib)).toEqual(['11652']);
    expect(teamWarning(entry, mates)).toBeNull();
  });

  it('does not join two clubs across different contests', () => {
    const roster = build([
      feedRow({ Bib: 11651, Club: 'SHARED', ContestID: 9 }),
      feedRow({ Bib: 11999, Club: 'SHARED', ContestID: 10 }),
    ]);
    expect(findTeammates(roster, roster.byBib.get('11651')!)).toHaveLength(0);
  });

  it('makes no team out of a blank club', () => {
    const roster = build([
      feedRow({ Bib: 11651, Club: '' }),
      feedRow({ Bib: 11652, Club: '' }),
    ]);
    const entry = roster.byBib.get('11651')!;
    expect(findTeammates(roster, entry)).toHaveLength(0);
    expect(teamWarning(entry, [])).toBe('Doubles team has no club identifier');
  });

  it('leaves a solo contest alone', () => {
    const roster = build([
      feedRow({ Bib: 20001, Contest: 'Male Pro', ContestID: 7, Club: 'Gym A' }),
      feedRow({ Bib: 20002, Contest: 'Male Pro', ContestID: 7, Club: 'Gym A' }),
    ]);
    const entry = roster.byBib.get('20001')!;
    expect(findTeammates(roster, entry)).toHaveLength(0);
    expect(teamWarning(entry, [])).toBeNull();
  });

  it('flags a doubles club with more than two athletes in it', () => {
    const roster = build([
      feedRow({ Bib: 11651, Club: 'C09-TEAM-001' }),
      feedRow({ Bib: 11652, Club: 'C09-TEAM-001' }),
      feedRow({ Bib: 11653, Club: 'C09-TEAM-001' }),
    ]);
    const entry = roster.byBib.get('11651')!;
    expect(teamWarning(entry, findTeammates(roster, entry))).toBe(
      'More than two athletes share this Doubles club',
    );
  });
});
