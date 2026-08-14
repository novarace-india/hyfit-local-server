import {
  resolveClientUpdateField,
  resolveClientUpdateFields,
  resolveUpdateField,
  resolveUpdateFields,
  stationUpdateFieldKey,
  updateFieldKeys,
  updateMappingProblems,
} from './hjudge-update-mapping.util';

/* The write-back vocabulary.
 *
 * These names are the only thing RaceResult sees of a race, and an event that
 * has never opened the mapping screen has to keep writing what it wrote before
 * the mapping existed — so the defaults are as much a part of the contract as
 * the configured values. */

describe('resolveUpdateField', () => {
  it('falls back to the historical field name when nothing is configured', () => {
    for (const mapping of [{}, null, undefined, [], 'nonsense']) {
      expect(resolveUpdateField(mapping, 'station1penalty')).toBe(
        'station1penalty',
      );
      expect(resolveUpdateField(mapping, 'wristband')).toBe('wristbandID');
      expect(resolveUpdateField(mapping, 'status')).toBe('Status');
      expect(resolveUpdateField(mapping, 'athletenotes')).toBe('athletenotes');
    }
  });

  it('uses the configured RaceResult name verbatim', () => {
    const mapping = { athletenotes: 'JudgeNotes', status: 'OOC' };
    expect(resolveUpdateField(mapping, 'athletenotes')).toBe('JudgeNotes');
    expect(resolveUpdateField(mapping, 'status')).toBe('OOC');
  });

  it('matches our key however the organiser punctuated it', () => {
    expect(
      resolveUpdateField({ Station_3_Penalty: 'S3P' }, 'station3penalty'),
    ).toBe('S3P');
  });

  it('ignores blank and non-string values instead of writing to ""', () => {
    expect(resolveUpdateField({ station4ics: '  ' }, 'station4ics')).toBe(
      'station4ics',
    );
    expect(resolveUpdateField({ station4ics: 7 }, 'station4ics')).toBe(
      'station4ics',
    );
  });

  it('covers every station field the judge app completes', () => {
    for (const number of [1, 2, 3, 4, 5, 6]) {
      for (const kind of ['penalty', 'ics'] as const) {
        expect(updateFieldKeys).toContain(stationUpdateFieldKey(number, kind));
      }
    }
    expect(() => stationUpdateFieldKey(7, 'penalty')).toThrow();
  });

  // The clock times, added alongside the durations they share boundaries with.
  // One per boundary the tablet reports, and the tablet already reported them
  // all — which is why nothing had to be reinstalled to start filling them in.
  it('covers every time-of-day field', () => {
    expect(updateFieldKeys).toEqual(
      expect.arrayContaining([
        'starttod',
        'run1tod',
        'station1tod',
        'run6tod',
        'station6tod',
        'cognitiverecalltod',
        'finishtod',
      ]),
    );
    for (const number of [1, 2, 3, 4, 5, 6]) {
      expect(updateFieldKeys).toContain(`run${number}tod`);
      expect(updateFieldKeys).toContain(`station${number}tod`);
    }
  });

  it('covers every RR14 timing backup field', () => {
    expect(updateFieldKeys).toEqual(
      expect.arrayContaining([
        'cognitivememorisetime',
        'run1time',
        'station1time',
        'run6time',
        'station6time',
        'cognitiverecalltime',
        'tyrefliprecalltime',
        'recalltofinishtime',
        'totalracetime',
      ]),
    );
  });
});

/* One value in two columns.
 *
 * An event whose timing side reads a column of its own has to have the
 * transponder in both. Repeating the JSON key cannot express that — a parser
 * keeps the last one — so the value may be a list instead. */

describe('resolveUpdateFields', () => {
  it('writes every field in a list, in the order given', () => {
    expect(
      resolveUpdateFields(
        { transponder1: ['Transponder1', 'chipused'] },
        'transponder1',
      ),
    ).toEqual(['Transponder1', 'chipused']);
  });

  it('reads back from the first of them', () => {
    expect(
      resolveUpdateField(
        { transponder1: ['Transponder1', 'chipused'] },
        'transponder1',
      ),
    ).toBe('Transponder1');
  });

  it('gives a plain string and a default the same shape', () => {
    expect(resolveUpdateFields({ wristband: 'Band' }, 'wristband')).toEqual([
      'Band',
    ]);
    expect(resolveUpdateFields({}, 'wristband')).toEqual(['wristbandID']);
  });

  it('drops entries it cannot write, and falls back when none are left', () => {
    expect(
      resolveUpdateFields({ transponder1: ['T1', '  ', 7] }, 'transponder1'),
    ).toEqual(['T1']);
    expect(resolveUpdateFields({ transponder1: [] }, 'transponder1')).toEqual([
      'Transponder1',
    ]);
    expect(
      resolveUpdateFields({ transponder1: ['', null] }, 'transponder1'),
    ).toEqual(['Transponder1']);
  });

  it('writes the same column once however it was spelled twice', () => {
    expect(
      resolveUpdateFields(
        { transponder1: ['Transponder1', 'transponder_1', 'chipused'] },
        'transponder1',
      ),
    ).toEqual(['Transponder1', 'chipused']);
  });
});

describe('resolveClientUpdateField', () => {
  it('maps a penalty the tablet queued under our name', () => {
    expect(
      resolveClientUpdateField(
        { cognitiveskillpenalty: 'CogPenalty' },
        'cognitiveskillpenalty',
      ),
    ).toBe('CogPenalty');
  });

  it('passes an unrecognised field through so a stale queue still delivers', () => {
    expect(resolveClientUpdateField({}, 'somethingelse')).toBe('somethingelse');
    expect(resolveClientUpdateFields({}, 'somethingelse')).toEqual([
      'somethingelse',
    ]);
  });

  it('fans a queued penalty out the same way a live one goes', () => {
    expect(
      resolveClientUpdateFields(
        { cognitiveskillpenalty: ['CogPenalty', 'cog_pen_backup'] },
        'Cognitive_Skill_Penalty',
      ),
    ).toEqual(['CogPenalty', 'cog_pen_backup']);
  });
});

describe('updateMappingProblems', () => {
  it('accepts an empty or absent mapping', () => {
    expect(updateMappingProblems({})).toEqual([]);
    expect(updateMappingProblems(null)).toEqual([]);
  });

  it('names a key we would otherwise ignore in silence', () => {
    const problems = updateMappingProblems({ athletenotess: 'JudgeNotes' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('athletenotess');
  });

  it('rejects a key with no field name behind it', () => {
    expect(updateMappingProblems({ wristband: '' })).toHaveLength(1);
    expect(updateMappingProblems({ wristband: 12 })).toHaveLength(1);
  });

  it('accepts a list of field names', () => {
    expect(
      updateMappingProblems({ transponder1: ['Transponder1', 'chipused'] }),
    ).toEqual([]);
  });

  it('reports a blank entry rather than quietly writing one column of two', () => {
    expect(
      updateMappingProblems({ transponder1: ['Transponder1', '  '] }),
    ).toHaveLength(1);
    expect(updateMappingProblems({ transponder1: [] })).toHaveLength(1);
  });
});
