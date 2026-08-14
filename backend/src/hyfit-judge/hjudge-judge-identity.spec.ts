import { judgeIdentity } from './hjudge-session.util';

/**
 * How a judge is named on an athlete's record.
 *
 * `judgedby` is the only thing saying who ran a race, and the only thing
 * stopping two tablets scoring the same athlete. A blank there loses the
 * attribution AND makes the athlete read as unclaimed to everybody else, so
 * these pin that it is never empty when the session identifies anyone at all.
 */
describe('judgeIdentity', () => {
  it('is the staff ID a judge signs in with', () => {
    expect(judgeIdentity({ staffId: 'JDG-07', name: 'Asha', id: 'u-1' })).toBe(
      'JDG-07',
    );
  });

  it('trims what the login stored', () => {
    expect(judgeIdentity({ staffId: '  JDG-07 ' })).toBe('JDG-07');
  });

  it('falls back to the name for a console operator with no staff ID', () => {
    // openLinkedSession mints a field session off an admin password login, and
    // that account may never have been issued a PIN or a staff ID.
    expect(judgeIdentity({ staffId: '', name: 'Race Admin', id: 'u-9' })).toBe(
      'Race Admin',
    );
    expect(judgeIdentity({ staffId: null, name: 'Race Admin' })).toBe(
      'Race Admin',
    );
  });

  it('falls back to the row id rather than writing nothing', () => {
    expect(judgeIdentity({ staffId: '', name: '', id: 'u-9' })).toBe('u-9');
  });

  it('is empty only when the session identifies nobody', () => {
    expect(judgeIdentity({})).toBe('');
  });
});
