import { parseParticipantImport } from './hjudge-participant-import.util';

/* Which column of a start list is the CONTEST.
 *
 * It matters because an athlete is keyed on (event, phone, name, contest): the
 * roster importer and the results importer have to choose the same column, or
 * a finisher fails to match their own start-list row and gets a second athlete
 * created from the standings. The 2026 export is the first one where the choice
 * is visible, because it carries both columns with different meanings.
 */

const ROW_2026 = {
  Bib: 1105,
  Name: 'Aarav Chivukula',
  Contest: 'NextGen Boys',
  Category: 'Next Gen Boys 12-15',
  Phone: '+919886131077',
};

const ROW_2025 = {
  Bib: 1144,
  Name: 'Ishita',
  Category: 'Female Doubles',
  Phone: '',
};

describe('the contest column of a start list', () => {
  it('prefers Contest over Category when the export has both', () => {
    const { participants } = parseParticipantImport([ROW_2026], {});
    expect(participants[0].category).toBe('NextGen Boys');
  });

  it('still reads Category as the contest when that is the only one', () => {
    const { participants } = parseParticipantImport([ROW_2025], {});
    expect(participants[0].category).toBe('Female Doubles');
  });

  it('lets a configured mapping override the preference', () => {
    // An operator who has told Operations that Category is the contest for this
    // event means it — the alias order is only the default.
    const { participants } = parseParticipantImport([ROW_2026], {
      categoryField: 'Category',
    });
    expect(participants[0].category).toBe('Next Gen Boys 12-15');
  });

  it('falls back to the aliases when the configured column is not in the file', () => {
    const { participants } = parseParticipantImport([ROW_2026], {
      categoryField: 'RaceClass',
    });
    expect(participants[0].category).toBe('NextGen Boys');
  });
});

/* The age band on a START LIST, which is new: RaceResult gained an `AgeGroup`
 * variable mid-season and the roster had nowhere to put it until migration 091.
 *
 * The rule that matters is the collision one. `Category` means the contest on
 * the older export and the band on the newer one, and the contest chooses
 * first — so a file where the contest had to fall back to `Category` must leave
 * the band unset rather than filing every athlete under a band named after
 * their own race.
 */
describe('the age band of a start list', () => {
  it('reads a dedicated AgeGroup column', () => {
    const { participants } = parseParticipantImport(
      [{ ...ROW_2026, AgeGroup: 'Boys 12-15' }],
      {},
    );
    expect(participants[0].category).toBe('NextGen Boys');
    expect(participants[0].ageGroup).toBe('Boys 12-15');
  });

  it('reads it however the feed spells it, brackets included', () => {
    // A RaceResult Custom API returns a field under the expression it was
    // defined by, so a variable added as (AgeGroup) arrives with the brackets.
    const { participants } = parseParticipantImport(
      [{ ...ROW_2026, '(AgeGroup)': 'Boys 12-15' }],
      {},
    );
    expect(participants[0].ageGroup).toBe('Boys 12-15');
  });

  it('leaves the band empty when the export has no column for it', () => {
    const { participants } = parseParticipantImport([ROW_2026], {});
    expect(participants[0].ageGroup).toBe('');
  });

  it('never takes the column the contest already took', () => {
    // ROW_2025 has only `Category`, which IS the contest there. Reading it as a
    // band as well would put Ishita in an age group called "Female Doubles".
    const { participants } = parseParticipantImport([ROW_2025], {});
    expect(participants[0].category).toBe('Female Doubles');
    expect(participants[0].ageGroup).toBe('');
  });

  it('lets a configured mapping name the column', () => {
    const { participants } = parseParticipantImport(
      [{ ...ROW_2026, Band: 'Boys 12-15' }],
      { ageGroupField: 'Band' },
    );
    expect(participants[0].ageGroup).toBe('Boys 12-15');
  });
});

