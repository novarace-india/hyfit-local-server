/**
 * The pairing endpoints: everything a local server needs to reach one prod
 * event, as URLs somebody can copy.
 *
 * TWO URLS, POINTING IN OPPOSITE DIRECTIONS.
 *
 *     …/ingest/events/<eventId>/config?k=<token>    GET   prod → local
 *     …/ingest/events/<eventId>/results?k=<token>   POST  local → prod
 *
 * The first is how the venue laptop learns what the event IS — its name, dates,
 * RaceResult wiring, declaration text, check-in window, certificate layouts.
 * The second is how the standings come back. They share one credential: the
 * same token opens both, and `scopes` on the token is what narrows that if an
 * event ever wants a read-only laptop.
 *
 * ONE PASTE, NOT TWO. An operator pastes EITHER url and the other is derived —
 * they differ in one path segment and nothing else, so asking for both is
 * asking somebody to copy the same string twice at six in the morning and get
 * one of them wrong. Both are stored, and both are editable afterwards, because
 * an endpoint that moves mid-event should be a field somebody corrects rather
 * than a Disconnect and a fresh credential.
 *
 * WHY URLS AND NOT AN OPAQUE CODE. Until 093 this was a base64url blob prefixed
 * `HYFITSYNC1.` — compact, unmistakably a secret, and completely unreadable. An
 * operator could not see which host they were about to push to or which event
 * it named without pasting it somewhere and hoping. A URL is self-describing:
 * the host and the event are on the face of it, it is the shape people already
 * expect from "prod gives you an endpoint", and every one of them is a real
 * route that can be opened in a browser to see what it says.
 *
 * THE TOKEN IS IN THE QUERY STRING HERE, AND ONLY HERE. These strings are
 * copied between two consoles; they are never fetched with the `k` on them.
 * When the local server actually calls prod, the token travels as
 * `Authorization: Bearer` and the URL it requests carries no `k` at all — so
 * the secret stays out of prod's access logs, out of whatever proxy sits in
 * front of it, and out of `Referer`. Treat either string as a password, because
 * that is what it is.
 */

/** The path both endpoints share, below the origin. One constant, because a
 *  sender that builds a path the receiver does not serve fails with a 404 that
 *  reads like a network problem. */
export const HJUDGE_INGEST_PATH = '/api/hyfit-judge/ingest/events';

/** The two halves of a pairing, by the segment that distinguishes them. */
export type HjudgeSyncRoute = 'config' | 'results';

export interface HjudgeSyncPairing {
  /** Prod's origin, no trailing slash: "https://app.example.com". */
  baseUrl: string;
  /** The event id. The SAME value in both databases since 093 — the local
   *  event is created by the first pull carrying this id, so there is no second
   *  id to map it to. */
  eventId: string;
  /** For the confirmation screen, so an operator sees a race name rather than a
   *  uuid before pairing. Prod re-states it in the handshake, and the handshake
   *  is what is trusted — this is only ever a label. */
  eventName: string;
  token: string;
  expiresAt: string;
  /** GET, prod → local. */
  pullUrl: string;
  /** POST, local → prod. */
  pushUrl: string;
}

/** What one pasted endpoint resolved to, before the handshake confirms it. */
export interface HjudgeParsedEndpoint {
  baseUrl: string;
  eventId: string;
  token: string;
  /** Which half was pasted, so the caller can say what it derived. */
  route: HjudgeSyncRoute;
  pullUrl: string;
  pushUrl: string;
}

/** One endpoint URL, with the token on it. Prod shows these; nothing fetches
 *  them in this form. */
export function encodeSyncUrl(
  baseUrl: string,
  eventId: string,
  token: string,
  route: HjudgeSyncRoute,
): string {
  const base = normaliseBaseUrl(baseUrl);
  return `${base}${HJUDGE_INGEST_PATH}/${eventId}/${route}?k=${encodeURIComponent(token)}`;
}

/** The pair, for the console that has just minted a credential. */
export function encodeSyncPair(
  baseUrl: string,
  eventId: string,
  token: string,
): { pullUrl: string; pushUrl: string } {
  return {
    pullUrl: encodeSyncUrl(baseUrl, eventId, token, 'config'),
    pushUrl: encodeSyncUrl(baseUrl, eventId, token, 'results'),
  };
}

/**
 * Parse what the operator pasted, and derive the half they did not.
 *
 * Accepts either endpoint. Whitespace and stray newlines are tolerated, because
 * that is what copying out of a chat window does; refusing a paste that is
 * perfectly unambiguous apart from a line break is a refusal to read.
 *
 * THE PATH IS REBUILT RATHER THAN EDITED. It would be shorter to swap the last
 * segment of whatever was pasted and keep the rest, and that is exactly the
 * mistake 086 made in the other direction: it invented a path, the invented one
 * happened to match, and the day prod served these from somewhere else the
 * endpoint an operator had pasted was silently ignored. So the ORIGIN and the
 * EVENT ID are taken from the paste — those are the facts it carries — and the
 * two URLs are then built from the one path constant this file and the
 * controller share. If prod ever serves them from a different path, one
 * constant changes and both ends move together.
 *
 * Throws with a message aimed at the person holding the paste buffer.
 */
export function parseSyncEndpoint(input: string): HjudgeParsedEndpoint {
  const compact = String(input ?? '')
    .trim()
    .replace(/\s+/g, '');

  if (!compact) {
    throw new Error('Paste the sync URL prod gave you for this event');
  }
  if (!/^https?:\/\//i.test(compact)) {
    throw new Error(
      'A sync URL starts with https:// — what you pasted does not. If you have a HYFITSYNC1 code from an older console, mint a fresh credential instead: the code form was retired in 093.',
    );
  }

  let url: URL;
  try {
    url = new URL(compact);
  } catch {
    throw new Error('That is not a readable URL — copy it again');
  }

  const token = (url.searchParams.get('k') ?? '').trim();
  if (!token) {
    throw new Error(
      'That URL has no credential on it. Copy the whole line including the ?k= part — it is the half that makes it work.',
    );
  }

  // The segment AFTER `events`, so the same paste works whichever endpoint it
  // is and whether or not a trailing slash came with it.
  const parts = url.pathname.split('/').filter(Boolean);
  const at = parts.indexOf('events');
  const eventId = at === -1 ? '' : (parts[at + 1] ?? '');
  if (!eventId) {
    throw new Error('That URL names no event — copy it again from prod');
  }

  const tail = at === -1 ? '' : (parts[at + 2] ?? '').toLowerCase();
  const route: HjudgeSyncRoute = tail === 'results' ? 'results' : 'config';

  const baseUrl = url.origin;
  const pair = encodeSyncPair(baseUrl, eventId, token);

  return {
    baseUrl,
    eventId,
    token,
    route,
    // Stored without the `k`: the token lives in its own column and travels as
    // a Bearer header. Keeping a second copy of it inside a string the console
    // renders would undo that.
    pullUrl: stripToken(pair.pullUrl),
    pushUrl: stripToken(pair.pushUrl),
  };
}

/** The endpoint as it is stored and shown: no credential on it. */
export function stripToken(input: string): string {
  try {
    const url = new URL(input);
    url.searchParams.delete('k');
    // `URL.toString()` leaves a bare `?` behind once the only parameter is gone.
    return url.toString().replace(/\?$/, '');
  } catch {
    return String(input ?? '').trim();
  }
}

/**
 * Move an endpoint onto a different origin, keeping its path.
 *
 * This is what "Change server address" does. Prod moving — a new host, a
 * tunnel, a laptop pointed at staging for a rehearsal — should be one field an
 * operator edits, not a re-pairing, and the path below the origin is not the
 * part that changed.
 */
export function rehostEndpoint(url: string, baseUrl: string): string {
  const origin = normaliseBaseUrl(baseUrl);
  if (!origin) return url;
  try {
    const parsed = new URL(url);
    const next = new URL(origin);
    next.pathname = parsed.pathname;
    next.search = parsed.search;
    return stripToken(next.toString());
  } catch {
    return url;
  }
}

/** Origin only, no trailing slash, no path. The endpoints carry their own path;
 *  a base URL that already had one would produce `/api/api/hyfit-judge/...` and
 *  a 404 nobody would read as a typo. */
export function normaliseBaseUrl(input: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return '';
  }
}

/**
 * Split a snapshot into requests the receiver will accept.
 *
 * Nest's body parser takes 100 KB by default and neither deployment raises it,
 * so the sender is what has to be careful. Rows are measured rather than
 * counted: a result row carrying its athlete is a few hundred bytes or a few
 * thousand depending on how much `raw` RaceResult's export brought with it, and
 * a fixed rows-per-chunk that is safe for the fat case wastes most of the
 * budget on the thin one.
 *
 * A single row that will not fit is emitted alone. It will very likely be
 * rejected by the receiver, and that is the right outcome: it fails loudly,
 * once, naming the push — rather than being silently dropped from a snapshot
 * that otherwise reports success.
 */
export function chunkByBytes<T>(rows: T[], maxBytes: number): T[][] {
  const budget = Math.max(1024, maxBytes - ENVELOPE_BYTES);
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 0;

  for (const row of rows) {
    const bytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
    if (current.length && size + bytes > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(row);
    size += bytes;
  }
  if (current.length) chunks.push(current);
  // An empty snapshot is still a push: withdrawing published standings is
  // sending no results, and the receiver needs a final chunk to prune against.
  // One empty chunk, marked final by the caller.
  return chunks.length ? chunks : [[]];
}

/** Room for `{"batch":"…","seq":0,"final":true,"rows":[]}` and then some. */
const ENVELOPE_BYTES = 512;
