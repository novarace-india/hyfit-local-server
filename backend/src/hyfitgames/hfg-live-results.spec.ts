import {
  parseTimeMs,
  normalizeRaceStatus,
  parseLiveResults,
} from './hfg-live-results.util';

/* Reading the RaceResult results feed.
 *
 * These tests exist because of the failure mode, not the complexity. Every
 * other mistake in this feature is visible — a wrong name, a missing row, a
 * placing in the wrong order. Misreading the TIME is not: "45:12" read as
 * seconds instead of minutes:seconds produces a leaderboard that renders
 * perfectly, sorts plausibly, and is wrong by a factor of sixty. Nobody
 * reviewing the screen would catch it.
 *
 * So each accepted time format is pinned here, along with the two judgement
 * calls the parser makes that a reader would otherwise have to guess at: what a
 * bare number means, and what an athlete with no time and no status is.
 */

describe('parseTimeMs', () => {
  it('reads h:mm:ss with a fraction', () => {
    expect(parseTimeMs('01:23:45.67')).toBe(5025670);
  });

  it('reads mm:ss.frac — the leading group is minutes, not hours', () => {
    // The regex is greedy from the left, so this is the case that would break
    // first if it were ever rewritten: 23:45 is 23 minutes, not 23 hours.
    expect(parseTimeMs('23:45.67')).toBe(1425670);
  });

  it('reads h:mm:ss with no fraction', () => {
    expect(parseTimeMs('1:23:45')).toBe(5025000);
  });

  it('reads bare seconds with a fraction', () => {
    expect(parseTimeMs('45.67')).toBe(45670);
  });

  it('pads a short fraction rather than reading it as milliseconds', () => {
    // ".5" is half a second, not five milliseconds.
    expect(parseTimeMs('45.5')).toBe(45500);
  });

  it('accepts a comma as the decimal separator', () => {
    expect(parseTimeMs('45,5')).toBe(45500);
  });

  it('allows a minutes field over 99', () => {
    expect(parseTimeMs('100:23')).toBe(6023000);
  });

  /* The ambiguous case, and the reason the boundary is where it is: a HYFIT
   * race lasts tens of minutes, so both readings land far from 100000.
   */
  it('reads a small bare number as seconds', () => {
    expect(parseTimeMs(2712)).toBe(2712000);
  });

  it('reads a large bare number as milliseconds', () => {
    expect(parseTimeMs(2712000)).toBe(2712000);
  });

  it('treats empty, zero and unparseable values as no time', () => {
    for (const v of ['', null, undefined, 0, -5, 'DNF', 'n/a', '--:--'])
      expect(parseTimeMs(v)).toBeNull();
  });
});

describe('normalizeRaceStatus', () => {
  it('reads the abbreviated spellings', () => {
    expect(normalizeRaceStatus('DNF', null)).toBe('DNF');
    expect(normalizeRaceStatus('DNS', null)).toBe('DNS');
    expect(normalizeRaceStatus('DSQ', null)).toBe('DQ');
    expect(normalizeRaceStatus('Finished', 100)).toBe('FIN');
  });

  /* Written out in full, which is how the provider emits them about half the
   * time, and the case that shipped broken: "Did not start" squashes to
   * DIDNOTSTART and matched no prefix, so a DNS was read as an athlete still
   * out on course.
   */
  it('reads the spelled-out forms', () => {
    expect(normalizeRaceStatus('Did not start', null)).toBe('DNS');
    expect(normalizeRaceStatus('Did not finish', null)).toBe('DNF');
    expect(normalizeRaceStatus('Not started', null)).toBe('DNS');
    expect(normalizeRaceStatus('No show', null)).toBe('DNS');
    expect(normalizeRaceStatus('Disqualified', null)).toBe('DQ');
  });

  /* A DNF that carries a partial time must stay a DNF: the time is real, but
   * the athlete did not finish, and inferring FIN from having a time would
   * place them in the standings.
   */
  it('does not let a time override an explicit non-finish', () => {
    expect(normalizeRaceStatus('DNF', 2712000)).toBe('DNF');
    expect(normalizeRaceStatus('Did not finish', 2712000)).toBe('DNF');
  });

  it('infers FIN from having a time', () => {
    expect(normalizeRaceStatus('', 2712000)).toBe('FIN');
  });

  /* The judgement call: mid-race, most of the field has no time yet. Calling
   * them DNS would be a claim the feed never made, and would drop them out of
   * the leaderboard entirely.
   */
  it('treats no time and no status as still racing, not DNS', () => {
    expect(normalizeRaceStatus('', null)).toBe('REG');
    expect(normalizeRaceStatus(null, null)).toBe('REG');
  });
});

describe('parseLiveResults', () => {
  it('finds the row list nested in the payload and matches columns by alias', () => {
    const payload = {
      Results: {
        List: [
          { Bib: '101', Name: 'Asha R', Contest: 'Female Pro', Time: '00:41:12.5', Place: '1' },
          { Bib: '102', Name: 'Meera K', Contest: 'Female Pro', Time: '00:43:02', Place: '2' },
        ],
      },
    };
    const { records, rejectedCount } = parseLiveResults(payload, {});

    expect(rejectedCount).toBe(0);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      bib: '101',
      full_name: 'Asha R',
      category: 'Female Pro',
      total_ms: 2472500,
      rank: 1,
      status: 'FIN',
    });
  });

  it('takes a bare array of rows', () => {
    const { records } = parseLiveResults([{ bib: '7', time: '30:00' }], {});
    expect(records[0]).toMatchObject({ bib: '7', total_ms: 1800000 });
  });

  it('honours an explicit mapping over the aliases', () => {
    const payload = [{ startno: '55', competitor: 'Ravi S', netto: '00:38:00' }];
    const { records } = parseLiveResults(payload, {
      bibField: 'startno',
      full_nameField: 'competitor',
      total_msField: 'netto',
    });
    expect(records[0]).toMatchObject({
      bib: '55',
      full_name: 'Ravi S',
      total_ms: 2280000,
    });
  });

  it('reaches into a nested field path', () => {
    const payload = [{ bib: '9', athlete: { name: 'Nested N' }, time: '20:00' }];
    const { records } = parseLiveResults(payload, { full_nameField: 'athlete.name' });
    expect(records[0].full_name).toBe('Nested N');
  });

  /* A row with no bib cannot find the athlete it belongs to, so it is dropped
   * and COUNTED — the count is what tells the operator their bib column is
   * mapped wrong, rather than leaving them with a short list and no reason.
   */
  it('rejects rows with no usable bib and reports how many', () => {
    const payload = [
      { bib: '1', time: '30:00' },
      { bib: '', time: '31:00' },
      { bib: 'ABC', time: '32:00' },
    ];
    const { records, rejectedCount } = parseLiveResults(payload, {});
    expect(records).toHaveLength(1);
    expect(rejectedCount).toBe(2);
  });

  it('keeps an athlete who has started but not finished', () => {
    const { records } = parseLiveResults([{ bib: '3', name: 'Still Out', time: '' }], {});
    expect(records[0]).toMatchObject({ bib: '3', total_ms: null, status: 'REG' });
  });

  it('returns nothing rather than throwing on a payload with no rows', () => {
    expect(parseLiveResults({ message: 'no data' }, {})).toEqual({
      records: [],
      rejectedCount: 0,
    });
  });
});
