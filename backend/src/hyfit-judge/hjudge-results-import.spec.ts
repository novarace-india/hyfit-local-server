import {
  parseResults,
  parseTimeMs,
  normalizeStatus,
  collectPenalties,
  findRows,
  isTeamCategory,
} from './hjudge-results-import.util';

/* Parsed against the real feed.
 *
 * Every row below is verbatim from `/_386828/api/<key>` for a HYFIT event —
 * including the ones that look like mistakes. The two 22:16 doubles partners
 * with a 22:17 TeamTime, the "00:00" TeamTime on a solo entry, the blank
 * splits on bib 11901, the "0" penalties and the empty Age and Phone are all
 * what that endpoint actually returns, and each of them broke a plausible
 * implementation of this parser.
 */
const FEED = [
  {
    Rank: 1,
    AgeGroupRank: 1,
    Bib: 1144,
    Name: 'Ishita',
    ST0COG: '00:11',
    Run1: '00:52',
    ST1: '02:20',
    Run2: '00:35',
    ST2: '02:37',
    Run3: '01:36',
    ST3: '00:49',
    Run4: '02:01',
    ST4: '03:46',
    Run5: '01:07',
    ST5: '02:02',
    Run6: '01:05',
    ST6: '03:15',
    Total: '22:16',
    'COG Penalty': '',
    'COG Bonus': '',
    'S2 Penalty': '0',
    'S3 Penalty': '0',
    TeamTime: '22:17',
    Age: '',
    Status: '',
    Category: 'Female Doubles',
    Phone: '',
    Club: 'TeamTest',
  },
  {
    Rank: 1,
    AgeGroupRank: 1,
    Bib: 1177,
    Name: 'Shubham',
    ST0COG: '00:10',
    Run1: '01:15',
    ST1: '01:43',
    Run2: '01:39',
    ST2: '03:09',
    Run3: '01:42',
    ST3: '01:27',
    Run4: '00:59',
    ST4: '04:35',
    Run5: '02:10',
    ST5: '01:57',
    Run6: '01:04',
    ST6: '04:32',
    Total: '26:22',
    'COG Penalty': '',
    'COG Bonus': '',
    'S2 Penalty': '0',
    'S3 Penalty': '0',
    TeamTime: '00:00',
    Age: '',
    Status: '',
    Category: 'Male Open',
    Phone: '',
    Club: '',
  },
  {
    Rank: 1,
    AgeGroupRank: 1,
    Bib: 10131,
    Name: 'Luca Weber',
    ST0COG: '00:43',
    Run1: '00:35',
    ST1: '03:15',
    Run2: '01:18',
    ST2: '03:32',
    Run3: '00:48',
    ST3: '07:29',
    Run4: '00:45',
    ST4: '05:22',
    Run5: '00:35',
    ST5: '04:06',
    Run6: '00:42',
    ST6: '04:16',
    Total: '33:26',
    'COG Penalty': '',
    'COG Bonus': '',
    'S2 Penalty': '',
    'S3 Penalty': '',
    TeamTime: '1:31:21',
    Age: 10,
    Status: '',
    Category: 'NextGen Boys',
    Phone: '+919000000131',
    Club: '',
  },
  {
    Rank: 1,
    AgeGroupRank: 1,
    Bib: 11901,
    Name: 'Daniel Dubois',
    ST0COG: '00:40',
    Run1: '00:31',
    ST1: '',
    Run2: '',
    ST2: '',
    Run3: '01:14',
    ST3: '04:53',
    Run4: '00:42',
    ST4: '03:32',
    Run5: '00:06',
    ST5: '05:22',
    Run6: '00:34',
    ST6: '02:25',
    Total: '21:36',
    'COG Penalty': '',
    'COG Bonus': '',
    'S2 Penalty': '',
    'S3 Penalty': '',
    TeamTime: '1:31:03',
    Age: 22,
    Status: '',
    Category: 'Male Doubles',
    Phone: '+919000001901',
    Club: 'C10-TEAM-026',
  },
  {
    Rank: 2,
    AgeGroupRank: 2,
    Bib: 1155,
    Name: 'Hema',
    ST0COG: '00:13',
    Run1: '00:24',
    ST1: '02:48',
    Run2: '00:34',
    ST2: '02:37',
    Run3: '01:36',
    ST3: '00:50',
    Run4: '02:00',
    ST4: '03:47',
    Run5: '01:08',
    ST5: '02:02',
    Run6: '02:12',
    ST6: '02:05',
    Total: '22:16',
    'COG Penalty': '',
    'COG Bonus': '',
    'S2 Penalty': '0',
    'S3 Penalty': '0',
    TeamTime: '22:17',
    Age: '',
    Status: '',
    Category: 'Female Doubles',
    Phone: '',
    Club: 'TeamTest',
  },
];

const ms = (m: number, s: number) => (m * 60 + s) * 1000;

describe('parseTimeMs', () => {
  it('reads a two-part clock as minutes and seconds, not hours and minutes', () => {
    // The whole feed is written this way, and reading "22:16" as 22 hours puts
    // every time three orders of magnitude out.
    expect(parseTimeMs('22:16')).toBe(ms(22, 16));
    expect(parseTimeMs('00:11')).toBe(11_000);
  });

  it('reads a three-part clock as hours, minutes and seconds', () => {
    expect(parseTimeMs('1:31:21')).toBe(((1 * 60 + 31) * 60 + 21) * 1000);
  });

  it('treats zero and blank alike as no time', () => {
    // "00:00" is how this feed spells "this athlete is not in a team". A zero
    // team time would sort ahead of every real pair.
    expect(parseTimeMs('00:00')).toBeNull();
    expect(parseTimeMs('')).toBeNull();
    expect(parseTimeMs(null)).toBeNull();
    expect(parseTimeMs(undefined)).toBeNull();
  });

  it('splits a bare number by magnitude', () => {
    expect(parseTimeMs(1336)).toBe(1_336_000);
    expect(parseTimeMs(1_336_000)).toBe(1_336_000);
  });

  it('refuses anything it does not recognise rather than guessing', () => {
    expect(parseTimeMs('DNF')).toBeNull();
    expect(parseTimeMs('--')).toBeNull();
  });
});

describe('normalizeStatus', () => {
  it('calls a blank status with a time a finish, and without one still racing', () => {
    // A mid-race pull is mostly people who have not finished yet. Calling them
    // DNS would be a claim the feed never made.
    expect(normalizeStatus('', 1_336_000)).toBe('FIN');
    expect(normalizeStatus('', null)).toBe('REG');
  });

  it('reads the spelled-out forms, not only the abbreviations', () => {
    expect(normalizeStatus('Did not start', null)).toBe('DNS');
    expect(normalizeStatus('Did Not Finish', null)).toBe('DNF');
    expect(normalizeStatus('Disqualified', 100)).toBe('DQ');
  });
});

describe('collectPenalties', () => {
  it('keeps a real penalty and drops the zeroes and blanks', () => {
    expect(collectPenalties(FEED[0] as any)).toEqual({});
    expect(
      collectPenalties({
        'S2 Penalty': '5',
        'COG Bonus': '2',
        'S3 Penalty': '0',
      }),
    ).toEqual({ 'S2 Penalty': '5', 'COG Bonus': '2' });
  });
});

describe('findRows', () => {
  it('takes a bare array', () => {
    expect(findRows(FEED)).toHaveLength(5);
  });

  it('finds the list inside the shapes RaceResult wraps it in', () => {
    expect(findRows({ data: FEED })).toHaveLength(5);
    expect(findRows({ Results: { List: FEED } })).toHaveLength(5);
  });

  it('takes the configured path when one is given', () => {
    expect(findRows({ a: { b: FEED } }, 'a.b')).toHaveLength(5);
  });
});

describe('parseResults on the reference feed', () => {
  const { results, rejectedCount, sourceColumns } = parseResults(FEED, {});

  it('reads every row with no mapping configured at all', () => {
    // The point of the aliases: an operator who has never opened the mapping
    // box still gets a usable pull off a normal HYFIT export.
    expect(results).toHaveLength(5);
    expect(rejectedCount).toBe(0);
    expect(sourceColumns).toContain('ST0COG');
  });

  it('carries the identity fields the athletes table is built from', () => {
    const ishita = results[0];
    expect(ishita.bib).toBe('1144');
    expect(ishita.name).toBe('Ishita');
    expect(ishita.category).toBe('Female Doubles');
    expect(ishita.club).toBe('TeamTest');
    expect(ishita.mobile).toBe('');
    expect(ishita.age).toBeNull();

    const luca = results[2];
    expect(luca.mobile).toBe('+919000000131');
    expect(luca.age).toBe(10);
  });

  it('reads the full circuit in course order', () => {
    const ishita = results[0];
    expect(ishita.cogMs).toBe(11_000);
    expect(ishita.runMs).toEqual([
      ms(0, 52),
      ms(0, 35),
      ms(1, 36),
      ms(2, 1),
      ms(1, 7),
      ms(1, 5),
    ]);
    expect(ishita.stationMs).toEqual([
      ms(2, 20),
      ms(2, 37),
      ms(0, 49),
      ms(3, 46),
      ms(2, 2),
      ms(3, 15),
    ]);
    expect(ishita.totalMs).toBe(ms(22, 16));
  });

  it('leaves a station the judge never recorded null instead of zero', () => {
    // Bib 11901 has a blank ST1, Run2 and ST2. A zero there would read as an
    // impossibly fast station on every scorecard.
    const daniel = results[3];
    expect(daniel.stationMs[0]).toBeNull();
    expect(daniel.runMs[1]).toBeNull();
    expect(daniel.stationMs[1]).toBeNull();
    expect(daniel.runMs[2]).toBe(ms(1, 14));
  });

  it('keeps a team time in a team contest and drops the placeholder one', () => {
    // Female Doubles, both partners on 22:17.
    expect(results[0].teamTimeMs).toBe(ms(22, 17));
    // Male Open with "00:00" — no team, and a zero is not a time.
    expect(results[1].teamTimeMs).toBeNull();
    // Male Doubles.
    expect(results[3].teamTimeMs).toBe(((1 * 60 + 31) * 60 + 3) * 1000);
  });

  /* The feed fills TeamTime for individual entrants too — 332 of 351 in Female
   * Open on this event — and it is not their team time, because they do not
   * have one. Taking it put "Team 1:31:21" on a solo athlete's result. */
  it('drops the team time for an individual contest, however the feed fills it', () => {
    const luca = results[2];
    expect(luca.category).toBe('NextGen Boys');
    expect(luca.raw.TeamTime).toBe('1:31:21');
    expect(luca.teamTimeMs).toBeNull();
  });

  it('recognises the contest formats by name', () => {
    for (const name of [
      'Female Doubles',
      'Male Doubles',
      'Mixed Doubles',
      'Corporate Relay',
      'Team Challenge',
      'Elite Pairs',
    ])
      expect(isTeamCategory(name)).toBe(true);

    for (const name of ['Male Open', 'Female Open', 'NextGen Boys', '', null])
      expect(isTeamCategory(name)).toBe(false);

    // "TeamTest" is a CLUB in this data, not a contest — and a word boundary is
    // what stops a club-ish name from turning a solo category into a team one.
    expect(isTeamCategory('Teamsters Open')).toBe(false);
  });

  it('takes both rankings the feed publishes', () => {
    expect(results[0].rank).toBe(1);
    expect(results[0].ageGroupRank).toBe(1);
    expect(results[4].rank).toBe(2);
  });

  it('calls everyone with a time a finisher when the feed says nothing', () => {
    expect(results.map((r) => r.status)).toEqual([
      'FIN',
      'FIN',
      'FIN',
      'FIN',
      'FIN',
    ]);
  });

  it('keeps the whole source row for later', () => {
    expect(results[0].raw['S2 Penalty']).toBe('0');
  });
});

describe('parseResults mapping and rejection', () => {
  it('follows a configured column name over the aliases', () => {
    const rows = [{ StartNo: 7, Athlete: 'Named', RaceTime: '10:00' }];
    const { results } = parseResults(rows, {
      bib: 'StartNo',
      name: 'Athlete',
      total: 'RaceTime',
    });
    expect(results[0]).toMatchObject({
      bib: '7',
      name: 'Named',
      totalMs: ms(10, 0),
    });
  });

  it('falls back to the aliases when a configured name is not in the payload', () => {
    // A mapping left over from last year's event should degrade to the
    // defaults, not blank the column.
    const { results } = parseResults(FEED, { bib: 'StartNumberFromLastYear' });
    expect(results).toHaveLength(5);
    expect(results[0].bib).toBe('1144');
  });

  it('rejects a row with no usable bib, and counts it', () => {
    const { results, rejectedCount } = parseResults(
      [...FEED, { Bib: '', Name: 'Nobody', Total: '20:00' }],
      {},
    );
    expect(results).toHaveLength(5);
    expect(rejectedCount).toBe(1);
  });

  it('keeps the first of a repeated bib IN THE SAME contest, so row order cannot decide the result', () => {
    const { results, rejectedCount } = parseResults(
      [FEED[0], { ...FEED[0], Total: '99:00' }],
      {},
    );
    expect(results).toHaveLength(1);
    expect(results[0].totalMs).toBe(ms(22, 16));
    expect(rejectedCount).toBe(1);
  });

  /* The entry is the row. An athlete can race two contests at one event under
   * one number, and each is its own result with its own time and placing. This
   * was the case the parser used to throw away as a duplicate bib. */
  it('keeps both races when one bib appears in two categories', () => {
    const { results, rejectedCount } = parseResults(
      [
        FEED[0],
        { ...FEED[0], Category: 'Female Open', Total: '24:02', Rank: 4 },
      ],
      {},
    );
    expect(rejectedCount).toBe(0);
    expect(results).toHaveLength(2);
    expect(results.map((r) => [r.category, r.totalMs, r.rank])).toEqual([
      ['Female Doubles', ms(22, 16), 1],
      ['Female Open', ms(24, 2), 4],
    ]);
    // Same person, same number — two entries, not one athlete overwritten.
    expect(new Set(results.map((r) => r.bib)).size).toBe(1);
  });

  it('treats a category that differs only in case or spacing as the same contest', () => {
    // Otherwise a feed that writes "Male Open" one pull and "male  open" the
    // next would double every entry in it.
    const { results, rejectedCount } = parseResults(
      [FEED[1], { ...FEED[1], Category: '  MALE   OPEN ' }],
      {},
    );
    expect(results).toHaveLength(1);
    expect(rejectedCount).toBe(1);
  });

  it('answers empty rather than throwing on a payload with no list in it', () => {
    expect(parseResults({ error: 'api not found' }, {})).toEqual({
      results: [],
      rejectedCount: 0,
      sourceColumns: [],
    });
  });
});
