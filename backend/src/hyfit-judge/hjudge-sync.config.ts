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

/**
 * What a credential opens. Both halves check this — the guard on the way in,
 * the console on the way out — so the list lives here.
 *
 * ONE READ AND ONE WRITE, not two writes. `config` is prod → local: the event
 * and its whole configuration, which is what lets a venue laptop be set up by
 * pasting one URL instead of by retyping everything an admin already entered.
 * `results` is local → prod: the standings.
 *
 * There is no `athletes` scope any more. The roster endpoint is gone — a
 * results push carries its own athletes (see HjudgeIngestService.ingestResults)
 * — and a scope naming an endpoint that does not exist is a scope somebody
 * grants and then wonders why nothing happens. See migration 093.
 */
export const HJUDGE_INGEST_SCOPES = ['config', 'results'] as const;
export type HjudgeIngestScope = (typeof HJUDGE_INGEST_SCOPES)[number];

/** The quick picks beside each interval box. SUGGESTIONS, not the permitted set
 *  — see the bounds below. "Every 7 minutes" is a thing a venue may reasonably
 *  ask for, and 086's enumerated CHECK answered it with a constraint name. */
export const HJUDGE_PUSH_INTERVALS = [0, 1, 2, 3, 5, 10, 20, 30, 60] as const;

/** The quick picks for the other direction. Configuration changes when an admin
 *  edits it, which is rare and never urgent, so these are the slower half. */
export const HJUDGE_PULL_INTERVALS = [0, 5, 15, 30, 60, 120] as const;

/** What both interval columns accept, matching the CHECKs in migration 093.
 *  Kept in one place because a value the UI offers and the column rejects is a
 *  save that fails with a constraint name in front of the operator. 0 = manual
 *  only; a day is the far end, past which "automatic" has stopped meaning
 *  anything. */
export const HJUDGE_SYNC_INTERVAL_MIN = 0;
export const HJUDGE_SYNC_INTERVAL_MAX = 1440;

/** What a fresh pairing gets when the paste does not say. Matches the column
 *  defaults in 086 and 093; stated here because `pair` writes both columns
 *  explicitly and would otherwise bypass them. */
export const HJUDGE_PUSH_INTERVAL_DEFAULT = 5;
export const HJUDGE_PULL_INTERVAL_DEFAULT = 15;

/** Origin only. Duplicated from `normaliseBaseUrl` in the credential util
 *  rather than imported, because that module imports nothing and this one is
 *  read at module load by both — a cycle between them would be resolved
 *  differently by ts-node and by the compiled build. */
const normaliseOrigin = (input: string): string => {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return '';
  }
};

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

  /**
   * The address a venue laptop can actually reach this deployment on.
   *
   * Only the PROD role uses it, and only to build the two URLs the console
   * hands an operator to paste. It cannot be derived from the request: the
   * person minting a credential may be on an internal hostname, a VPN name or
   * localhost, while the URL they copy has to resolve from a laptop on a
   * venue's own network on the far side of the internet. That is a deployment
   * fact, so it lives beside the database credentials.
   *
   * Unset is handled rather than guessed — `mintCredential` returns
   * `baseUrlMissing` and the console says so, which is visibly incomplete and
   * therefore fixable. A URL built from a hostname that happens to be in the
   * request would look correct and resolve to nothing.
   */
  publicBaseUrl: normaliseOrigin(env('HYFIT_PUBLIC_BASE_URL', '')),

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
