import {
  REJECTION_DETAIL_CAP,
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

  it('drops the magnitude guess when the column declares milliseconds', () => {
    // An eleven-second cognitive segment stored as 11000 is under the boundary,
    // so the heuristic would read it as eleven thousand SECONDS. A column named
    // st0_ms is not ambiguous and must not be guessed at.
    expect(parseTimeMs(11_000, 'ms')).toBe(11_000);
    expect(parseTimeMs('11000', 'ms')).toBe(11_000);
    expect(parseTimeMs(1_336_000, 'ms')).toBe(1_336_000);
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
  /* A ZERO IS A STATEMENT, a blank is not.
   *
   * "S3 Penalty": "0" is the judge saying that station was clean; a missing or
   * empty column is the export saying nothing about it at all. Those used to
   * arrive here identically — both dropped — which left the console unable to
   * tell a clean station from an unjudged one on exactly the screen that exists
   * to check imports. The athlete-facing filter for this lives in
   * split-timeline.tsx, where a nought really is worth no chip. */
  it('keeps every column the feed scored, zeroes included', () => {
    expect(
      collectPenalties({
        'S2 Penalty': '5',
        'COG Bonus': '2',
        'S3 Penalty': '0',
      }),
    ).toEqual({ 'S2 Penalty': '5', 'COG Bonus': '2', 'S3 Penalty': '0' });
  });

  it('drops only the columns that said nothing', () => {
    expect(
      collectPenalties({ 'COG Penalty': '', 'S2 Penalty': '   ' }),
    ).toEqual({});
  });

  /* The 2026 export writes these two as JSON numbers and the station ones as
     strings, in the same row. Both are penalties; neither may be lost to its
     type. */
  it('reads a numeric penalty and a numeric zero bonus alike', () => {
    expect(
      collectPenalties({ 'COG Penalty': 30, 'COG Bonus': 0 }),
    ).toEqual({ 'COG Penalty': '30', 'COG Bonus': '0' });
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
    // Male Open with "00:00" — the feed's own "not applicable", and a zero is
    // not a time. This is the ONLY value the import declines to carry.
    expect(results[1].teamTimeMs).toBeNull();
    // Male Doubles.
    expect(results[3].teamTimeMs).toBe(((1 * 60 + 31) * 60 + 3) * 1000);
  });

  /* THE FEED DECIDES WHETHER THERE IS A TEAM, NOT THE CONTEST'S NAME.
   *
   * These two used to be gated on `isTeamCategory(category)`, so a row in a
   * contest called "Male Open" had its TeamRank and TeamTime discarded whatever
   * the feed said. That cost real results: 33 rows at HYFIT Bengaluru — bibs
   * 10001-10034 in Male Open and Female Open — are a pairs wave run inside the
   * open contests, partners sharing a TeamTime and a TeamRank, and every one of
   * them was stored as NULL.
   *
   * What the feed sends is what is stored. The reader decides what to show. */
  it('carries a team result in a contest whose NAME does not say team', () => {
    const luca = results[2];
    expect(luca.category).toBe('NextGen Boys');
    expect(isTeamCategory(luca.category)).toBe(false);
    expect(luca.raw.TeamTime).toBe('1:31:21');
    // Stored as sent, precisely because a name is a guess and the row is not.
    expect(luca.teamTimeMs).toBe(((1 * 60 + 31) * 60 + 21) * 1000);
  });

  /* Still a fair answer to "does this NAME describe a team contest?", and still
   * worth having for a label or a setup hint — but it no longer decides whether
   * stored data is real. See the test above. */
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

  /* WHICH rows were dropped, not just how many.
   *
   * "1647 stored · 7 rejected" is a number an operator can do nothing with:
   * the two reasons need opposite fixes — a row with no usable bib is a hole in
   * the export, a repeated entry is the export contradicting itself — and
   * neither can be chased without knowing which rows they were. */
  describe('rejection detail', () => {
    const MIXED = [
      { Bib: 101, Name: 'Runs Fine', Category: 'Male Open', Finished: true },
      { Bib: '', Name: 'No Number', Category: 'Male Open', Finished: true },
      { Bib: 'DNS', Name: 'Not A Bib', Category: 'Male Open', Finished: true },
      { Bib: 101, Name: 'Runs Fine', Category: 'Male Open', Finished: true },
      { Bib: 101, Name: 'Runs Fine', Category: 'Male Doubles', Finished: true },
    ];

    it('keeps the good rows and describes every dropped one', () => {
      const { results, rejectedCount, rejections } = parseResults(MIXED, {});

      // Two entries survive: one bib in two contests is two entries, not a
      // duplicate.
      expect(results).toHaveLength(2);
      expect(rejectedCount).toBe(3);
      expect(rejections).toEqual([
        { row: 2, bib: '', name: 'No Number', category: 'Male Open', reason: 'no-bib' },
        { row: 3, bib: 'DNS', name: 'Not A Bib', category: 'Male Open', reason: 'no-bib' },
        {
          row: 4,
          bib: '101',
          name: 'Runs Fine',
          category: 'Male Open',
          reason: 'duplicate-entry',
        },
      ]);
    });

    it('numbers the rows as the file does, from 1', () => {
      const { rejections } = parseResults(MIXED, {});
      // The second row of the file is the first rejection — the number has to
      // point at a line somebody can go and look at.
      expect(rejections[0].row).toBe(2);
    });

    it('keeps the bib column verbatim, because that is what is wrong with it', () => {
      const { rejections } = parseResults(MIXED, {});
      // "DNS" in a bib column is the whole diagnosis; the normalised form is
      // empty and says nothing.
      expect(rejections[1].bib).toBe('DNS');
    });

    it('counts every rejection even when it stops describing them', () => {
      const many = Array.from({ length: REJECTION_DETAIL_CAP + 25 }, (_, i) => ({
        Bib: '',
        Name: `Nobody ${i}`,
        Category: 'Male Open',
      }));
      // One usable row, so the parse is not the "no usable rows" error.
      const { rejectedCount, rejections } = parseResults(
        [{ Bib: 900, Name: 'Real', Category: 'Male Open', Finished: true }, ...many],
        {},
      );
      expect(rejectedCount).toBe(REJECTION_DETAIL_CAP + 25);
      expect(rejections).toHaveLength(REJECTION_DETAIL_CAP);
    });
  });

  it('answers empty rather than throwing on a payload with no list in it', () => {
    expect(parseResults({ error: 'api not found' }, {})).toEqual({
      results: [],
      rejectedCount: 0,
      rejections: [],
      sourceColumns: [],
    });
  });

  /* THE 2026 EXPORT. Same provider, three columns the 2025 one did not have:
     `Contest` beside `Category` (the contest and the age band, which used to be
     one column meaning the contest), `TeamRank` beside `TeamTime`, and a
     `Finished` boolean. Rows verbatim from the file an operator uploaded. */
  const EXPORT_2026 = [
    {
      Rank: 1,
      AgeGroupRank: 1,
      Bib: 1105,
      Name: 'Aarav Chivukula',
      ST0COG: '00:12',
      Run1: '00:33',
      ST1: '00:27',
      Run6: '00:40',
      ST6: '',
      COGRecall: '00:05:48',
      Total: '11:35',
      'COG Penalty': 30,
      'COG Bonus': 0,
      'S2 Penalty': '0',
      HyZone: '2:46',
      TeamRank: 0,
      TeamTime: '00:00',
      Age: 14,
      Status: '',
      Contest: 'NextGen Boys',
      Category: 'Next Gen Boys 12-15',
      Phone: '+919886131077',
      Club: '',
      Finished: true,
    },
    {
      Rank: 1,
      AgeGroupRank: 1,
      Bib: 10603,
      Name: 'Priya Ranjan  Sahu',
      ST0COG: '00:10',
      Total: '12:20',
      'COG Penalty': 0,
      'COG Bonus': 30,
      TeamRank: 1,
      TeamTime: '12:21',
      Age: 34,
      Status: '',
      Contest: 'Male Doubles',
      Category: 'Male Doubles',
      Phone: '+918886541632',
      // & in the file. JSON.parse resolves the escape before the parser
      // ever sees it, so what arrives here is the ampersand itself.
      Club: 'Priya & Rajesh',
      Finished: true,
    },
  ];

  it('keeps the contest and the age band apart when the export carries both', () => {
    const { results } = parseResults(EXPORT_2026, {});

    // The CONTEST is what an entry is keyed on — bib in a race — and it is the
    // narrower `Category` that must not win it, whichever order the columns
    // appear in.
    expect(results[0].category).toBe('NextGen Boys');
    expect(results[0].ageGroup).toBe('Next Gen Boys 12-15');
    expect(results[0].ageGroupRank).toBe(1);
  });

  it('leaves the age band empty when it only repeats the contest', () => {
    // The doubles rows write the same string in both columns. Storing it twice
    // would print "Male Doubles · Age group placing #1" under an entry whose
    // contest is already Male Doubles.
    const { results } = parseResults(EXPORT_2026, {});
    expect(results[1].category).toBe('Male Doubles');
    expect(results[1].ageGroup).toBe('');
  });

  /* The dedicated column the 2026 export gained mid-season.
   *
   * Until it existed the band could only be inferred from `Category`, which is
   * why it was null on four rows in five: an export whose Category repeats the
   * contest was saying nothing about bands at all. A real `AgeGroup` column
   * answers for every row, and the leaderboard's age filter is built from
   * whatever this field ends up holding.
   *
   * The parenthesised spelling is not hypothetical: a RaceResult Custom API
   * returns a field under the expression it was defined by, so a variable added
   * as `(AgeGroup)` arrives with the brackets still on it. `squash` strips
   * everything that is not a letter or a digit before matching, so it resolves
   * the same as `AgeGroup` and `Age Group` — locked here because the mapping is
   * invisible until an operator notices a filter with nothing in it. */
  describe('a dedicated AgeGroup column', () => {
    const withAgeGroup = (key: string) => [
      {
        Bib: 1105,
        Name: 'Aarav Chivukula',
        Contest: 'NextGen Boys',
        Category: 'Next Gen Boys 12-15',
        [key]: 'Boys 12-15',
        AgeGroupRank: 1,
        Finished: true,
      },
    ];

    it.each(['AgeGroup', '(AgeGroup)', 'Age Group', 'age_group'])(
      'reads it however the feed spells it: %s',
      (key) => {
        const { results } = parseResults(withAgeGroup(key), {});
        expect(results[0].category).toBe('NextGen Boys');
        expect(results[0].ageGroup).toBe('Boys 12-15');
      },
    );

    it('wins over Category, which is only the fallback', () => {
      const { results } = parseResults(withAgeGroup('AgeGroup'), {});
      // Category is left to nobody here: the contest took `Contest`, and the
      // band took `AgeGroup`, so the narrower Category column is simply unused
      // rather than overwriting the band it used to stand in for.
      expect(results[0].ageGroup).toBe('Boys 12-15');
    });

    it('is still dropped when it only repeats the contest', () => {
      const rows = [
        {
          Bib: 2001,
          Name: 'Priya R',
          Contest: 'Male Doubles',
          AgeGroup: 'Male Doubles',
          Finished: true,
        },
      ];
      const { results } = parseResults(rows, {});
      expect(results[0].ageGroup).toBe('');
    });
  });

  it('leaves the age band empty for the older export, where Category IS the contest', () => {
    const { results } = parseResults(FEED, {});
    expect(results[0].category).toBe('Female Doubles');
    expect(results[0].ageGroup).toBe('');
  });

  it('takes the team placing for a pair and refuses the zero on a solo row', () => {
    const { results } = parseResults(EXPORT_2026, {});
    // Solo: TeamRank 0 and TeamTime "00:00" both mean "no team".
    expect(results[0].teamRank).toBeNull();
    expect(results[0].teamTimeMs).toBeNull();
    // Doubles: both are the pair's.
    expect(results[1].teamRank).toBe(1);
    expect(results[1].teamTimeMs).toBe(ms(12, 21));
  });

  it('publishes the times the circuit has no column for, and only those', () => {
    const { results } = parseResults(EXPORT_2026, {});

    // HyZone and COGRecall are real times this feed carries and the thirteen
    // typed legs cannot hold. Kept as the organiser wrote them.
    expect(results[0].extraTimes).toEqual({
      COGRecall: '00:05:48',
      HyZone: '2:46',
    });

    // And nothing else. Every mapped column is already published as a parsed
    // number — publishing "11:35" again beside `totalMs` would be the same fact
    // twice, in two formats, disagreeing the moment a mapping changes.
    for (const claimed of ['Total', 'ST0COG', 'Run1', 'ST1', 'TeamTime'])
      expect(results[0].extraTimes).not.toHaveProperty(claimed);
    // Numbers are not times. `Age: 14` and `TeamRank: 1` would both read as
    // durations to anything that accepted a bare number here.
    expect(Object.keys(results[0].extraTimes)).not.toContain('Age');
    expect(Object.keys(results[0].extraTimes)).not.toContain('TeamRank');
    // Penalties keep their own home rather than appearing in both.
    expect(Object.keys(results[0].extraTimes)).not.toContain('COG Penalty');
  });

  it('carries a numeric bib, a numeric penalty and an escaped club name through', () => {
    const { results, rejectedCount } = parseResults(EXPORT_2026, {});
    expect(rejectedCount).toBe(0);
    // The bib is a JSON number in this export and a string in the last one.
    expect(results[0].bib).toBe('1105');
    /* A penalty of 30 written as a JSON number, a bonus of 0 written as one, and
       a station penalty of "0" written as a string — three types, one column
       family, all of them kept. The zeroes are what say those stations were
       judged and clean; dropping them here left the console unable to tell that
       from a station nobody judged. */
    expect(results[0].penalties).toEqual({
      'COG Penalty': '30',
      'COG Bonus': '0',
      'S2 Penalty': '0',
    });
    expect(results[1].penalties).toEqual({
      'COG Penalty': '0',
      'COG Bonus': '30',
    });
    expect(results[1].club).toBe('Priya & Rajesh');
    expect(results[1].mobile).toBe('+918886541632');
    // Age on race day. Parsed since 083 and stored on the RESULT since 089 —
    // the athlete row's copy is overwritten by the next event they enter.
    expect(results[0].age).toBe(14);
    expect(results[1].age).toBe(34);
  });

  /* A file exported from this platform's OWN tables — what an operator carrying
     an offline event's standings up to prod by hand is holding. The columns are
     the database's, and their times are already milliseconds. */
  it('reads a dump of our own results columns, milliseconds and all', () => {
    const { results } = parseResults(
      [
        {
          bib: '101',
          name: 'Ishita Sharma',
          category: 'Female Doubles',
          club: 'Koramangala',
          status: 'FIN',
          rank: 1,
          total_ms: 1_336_000,
          team_time_ms: 1_402_000,
          cog_ms: 11_000,
          run1_ms: 100_000,
          st1_ms: 125_000,
        },
      ],
      {},
    );

    expect(results[0]).toMatchObject({
      totalMs: 1_336_000,
      teamTimeMs: 1_402_000,
      // The one the magnitude heuristic would have ruined: 11 seconds, not
      // eleven thousand.
      cogMs: 11_000,
    });
    expect(results[0].runMs[0]).toBe(100_000);
    expect(results[0].stationMs[0]).toBe(125_000);
  });
});
