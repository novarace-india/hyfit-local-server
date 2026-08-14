/**
 * Offline-event sync: what this server is, and the numbers both halves share.
 *
 * WHY THE ROLE IS AN ENVIRONMENT VARIABLE AND NOT A SETTING.
 *
 * Every deployment of this app runs the same code against the same schema —
 * that is what makes a laptop at a venue a usable stand-in for prod. So
 * something has to say which one a given process is, and the tempting answer is
 * a row in `events` or a toggle on an admin screen. Both are wrong for the same
 * reason: an operator who can pick "this is the local server" on the prod
 * console has an afternoon in which prod believes it should be pushing its own
 * results somewhere, and the first symptom is the public site going quiet.
 *
 * A server's identity is a deployment fact. It belongs beside the database
 * credentials, in the environment, where changing it means a restart by
 * somebody who meant to.
 *
 * The DEFAULT is `prod`, which is the harmless half: a prod-role server exposes
 * the ingest routes (which refuse every request without a live credential for an
 * offline event) and never pushes anywhere. A local server that has not been
 * configured therefore fails visibly — the Sync screen says it is running as
 * prod and nothing gets sent — rather than a prod box quietly starting to push.
 */

const env = (key: string, fallback: string): string => {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
};

const intEnv = (key: string, fallback: number): number => {
  const parsed = Number.parseInt(env(key, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export type HjudgeNodeRole = 'prod' | 'local';

/** The two things an event's public read can be served by. See migration 086. */
export type HjudgeDeliveryMode = 'online' | 'offline';

/** What a credential may write. Both halves check this — the guard on the way
 *  in, the console on the way out — so the list lives here. */
export const HJUDGE_INGEST_SCOPES = ['athletes', 'results'] as const;
export type HjudgeIngestScope = (typeof HJUDGE_INGEST_SCOPES)[number];

/** The dropdown, and the CHECK constraint on `event_push_targets`. Kept in one
 *  place because a value the UI offers and the column rejects is a save that
 *  fails with a constraint name in front of the operator. 0 = manual only. */
export const HJUDGE_PUSH_INTERVALS = [0, 1, 2, 3, 5, 10, 20, 30, 60] as const;

const role = env('HYFIT_NODE_ROLE', 'prod').trim().toLowerCase();

export const hjudgeSyncConfig = {
  /** 'prod' receives pushes. 'local' sends them. Nothing does both. */
  nodeRole: (role === 'local' ? 'local' : 'prod') as HjudgeNodeRole,

  /** True when HYFIT_NODE_ROLE held something this code does not recognise. The
   *  Sync screen surfaces it, because silently falling back to `prod` on a
   *  venue laptop looks exactly like a laptop that is refusing to push. */
  roleWasUnrecognised: role !== '' && role !== 'local' && role !== 'prod',

  /**
   * The most JSON one push request may carry, in bytes.
   *
   * Nest's body parser accepts 100 KB by default and neither deployment raises
   * it. Rather than widen that limit — on the prod app, for every route, to
   * accommodate one — the sender fills each chunk up to this budget and sends
   * as many chunks as the snapshot needs. 80 KB leaves room for the envelope
   * around the rows and for a proxy that counts headers against the same
   * ceiling.
   *
   * Raise it only alongside the receiving server's parser limit. A payload the
   * sender is happy with and the receiver rejects surfaces as a 413 on every
   * push, which the Sync screen will show but which no retry can clear.
   */
  pushMaxBytes: intEnv('HYFIT_PUSH_MAX_BYTES', 80_000),

  /** Per-request timeout for a push. Venue wifi fails slowly rather than
   *  cleanly, and a push that hangs past its own interval stacks up behind the
   *  next one. */
  pushTimeoutMs: intEnv('HYFIT_PUSH_TIMEOUT_MS', 20_000),

  /** How long a minted credential lasts by default, in hours. An event day plus
   *  the day either side of it — long enough that nobody re-mints one at 6 AM,
   *  short enough that a forgotten credential stops working within the week. */
  credentialDefaultHours: intEnv('HYFIT_INGEST_TOKEN_HOURS', 72),

  /** How many `push_runs` rows to keep per event. The screen shows a handful;
   *  the rest is there for the hour after something went wrong, not forever. */
  pushRunRetention: intEnv('HYFIT_PUSH_RUN_RETENTION', 200),

  /** The scheduler's tick. It wakes up this often and pushes whichever bound
   *  events are due — the per-event interval is a due-time, not a timer of its
   *  own, so changing the dropdown takes effect within one tick and needs no
   *  restart. */
  schedulerTickMs: intEnv('HYFIT_PUSH_TICK_MS', 30_000),
} as const;

/** A push that keeps failing should not keep failing at full speed: sixty
 *  attempts an hour against a venue link that is down is the fastest way to
 *  make the log useless. Backs off to at most eight tick-multiples. */
export function pushBackoffMultiplier(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 1;
  return Math.min(2 ** Math.min(consecutiveFailures, 3), 8);
}
