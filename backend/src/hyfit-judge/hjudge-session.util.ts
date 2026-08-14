import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

export type AppRole =
  | 'super_admin'
  | 'event_admin'
  | 'checkin'
  | 'judge'
  | 'readonly';

// Runtime counterpart to AppRole, for validating role values coming off the
// wire. Kept in the same order as the users.role CHECK constraint in
// 040_create_hyfit_judge_schema.sql.
export const HJUDGE_APP_ROLES: string[] = [
  'super_admin',
  'event_admin',
  'checkin',
  'judge',
  'readonly',
];

// The roles the admin console hands out. Field ops has exactly two jobs — judge
// a station, or staff a check-in counter — and those are the only two the Team
// screen creates. `super_admin`, `event_admin` and `readonly` remain valid on
// rows that already hold them (console operators, seeded admins), so an
// existing account stays editable; they are simply not roles you can hire into.
export const HJUDGE_STAFF_ROLES: string[] = ['judge', 'checkin'];

// The two stages of a check-in. Not a property of a volunteer or of a desk any
// more — a counter runs whichever stage the athlete in front of it is due — so
// this names the two hand-overs and nothing about who performs them.
export type CheckinStage = 'STAGE_1_WRISTBAND' | 'STAGE_2_TRANSPONDER';

// A PIN must be 4–8 digits. Enforced identically at login and at every point
// a PIN is set, so an account can never be saved with a PIN login will refuse.
export const HJUDGE_PIN_PATTERN = /^\d{4,8}$/;

export function hashPin(pin: string, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(pin, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPin(pin: string, encoded: string) {
  const [algorithm, salt, expectedHex] = encoded.split(':');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
  const actual = scryptSync(pin, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function newSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

// Native clients (iOS/Android) can't rely on the HttpOnly session cookie, so
// they send the same session token as a bearer credential instead. The token
// itself is identical either way — only the transport differs — so the
// sessions lookup in HjudgeAuthGuard is unchanged.
export function bearerToken(authorizationHeader: string | null) {
  const [scheme, ...rest] = (authorizationHeader ?? '').trim().split(/\s+/);
  if (scheme.toLowerCase() !== 'bearer') return '';
  return rest.join(' ').trim();
}

export function parseCookies(cookieHeader: string | null) {
  const result = new Map<string, string>();
  for (const part of (cookieHeader ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    result.set(
      part.slice(0, separator).trim(),
      decodeURIComponent(part.slice(separator + 1).trim()),
    );
  }
  return result;
}

/**
 * How a judge is identified on an athlete's record.
 *
 * The staff ID they sign in with, which is what "judge ID" means to everyone
 * working an event and what another judge will recognise on a claim they cannot
 * take over.
 *
 * It falls back because it can legitimately be absent: a console operator who
 * reached the field through their admin login holds a session with no staff
 * credential at all. Writing a blank there would lose the attribution entirely
 * and, worse, make the athlete read as unclaimed to every other tablet.
 */
export function judgeIdentity(user: {
  staffId?: string | null;
  name?: string | null;
  id?: string | null;
}): string {
  return (
    user.staffId?.trim() ||
    user.name?.trim() ||
    user.id?.trim() ||
    ''
  );
}
