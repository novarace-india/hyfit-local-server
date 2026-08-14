/**
 * The connection code: everything a local server needs to reach one prod event,
 * as one string somebody can copy.
 *
 * WHY ONE STRING. The alternative is four fields — base URL, event id, token,
 * expiry — typed into four boxes at a venue, usually from a phone screen, often
 * at six in the morning. Three of the four are opaque, one of them is 71
 * characters of hex, and a single mistyped character in any of them produces
 * the same unhelpful "credential is not valid". One blob is one paste.
 *
 * IT IS NOT ENCRYPTION AND MUST NOT BE MISTAKEN FOR IT. Base64url of JSON is a
 * transport wrapper: it survives being pasted into a chat window, a spreadsheet
 * cell or a terminal without a newline or a quote mangling it. Anyone holding
 * the code holds the token. It is a secret, it is scoped to one event, and it
 * expires — those three, not the encoding, are what make it safe to carry.
 *
 * The prefix is deliberate. A loose blob in a chat log is recognisable as a
 * HYFIT sync credential, which means somebody can revoke it without first
 * working out what it is.
 */

export const HJUDGE_CREDENTIAL_PREFIX = 'HYFITSYNC1.';

export interface HjudgeSyncCredential {
  /** Prod's origin, no trailing slash: "https://app.example.com". */
  baseUrl: string;
  /** The event id ON PROD. The local event has its own, and they differ. */
  eventId: string;
  /** For the confirmation screen, so an operator sees a race name rather than
   *  a uuid before binding. Prod re-states it in the handshake, and the
   *  handshake is what is trusted — this is only ever a label. */
  eventName: string;
  token: string;
  expiresAt: string;
}

/**
 * The same credential written as a URL — the "temporary endpoint" form.
 *
 *     …/ingest/events/<eventId>/athletes?k=<token>   the start list
 *     …/ingest/events/<eventId>/results?k=<token>    the standings
 *
 * Pass a `route` for one of those two; omit it for the bare event endpoint,
 * which the local server turns into both by appending the route itself.
 *
 * THE TWO URLS SHARE ONE CREDENTIAL. They are two destinations, not two keys —
 * the same token opens both, and `scopes` on the token is what could narrow
 * that if an event ever wanted a results-only sender. So binding a venue server
 * with either URL binds it for both; the pair exists because an operator
 * setting this up thinks in terms of "where does the roster go and where do the
 * results go", and answering that with one URL and a footnote does not land.
 *
 * WHY BOTH FORMS EXIST. They carry identical information and the difference is
 * entirely who is reading. The code above is compact and unmistakably a secret;
 * this is self-describing — an operator can see the host they are pushing to
 * and the event it is scoped to without decoding anything, which is the shape
 * people already expect from "prod gives you an endpoint".
 *
 * THE TOKEN IS IN THE QUERY STRING HERE, AND ONLY HERE. This string is copied
 * between two consoles; it is never fetched. When the local server actually
 * pushes, the token travels as `Authorization: Bearer` and the URL it requests
 * carries no `k` at all — so the secret stays out of prod's access logs, out of
 * whatever proxy sits in front of it, and out of `Referer`. Treat the string
 * itself as a password, because that is what it is.
 */
export function encodeSyncUrl(
  credential: HjudgeSyncCredential,
  route?: 'athletes' | 'results',
): string {
  const base = normaliseBaseUrl(credential.baseUrl);
  const path = route ? `/${route}` : '';
  return `${base}/api/hyfit-judge/ingest/events/${credential.eventId}${path}?k=${encodeURIComponent(credential.token)}`;
}

export function encodeSyncCredential(credential: HjudgeSyncCredential): string {
  return (
    HJUDGE_CREDENTIAL_PREFIX +
    Buffer.from(JSON.stringify(credential), 'utf8').toString('base64url')
  );
}

/**
 * Parse what the operator pasted.
 *
 * Accepts all three shapes an operator might arrive with: the endpoint URL, the
 * connection code, and bare JSON. Whitespace and stray newlines are tolerated,
 * because that is what copying out of a chat window does. Refusing any of these
 * would be a refusal to read something perfectly unambiguous.
 *
 * Throws with a message aimed at the person holding the paste buffer.
 */
export function decodeSyncCredential(input: string): HjudgeSyncCredential {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Paste the connection code from the prod console');

  const compact = raw.replace(/\s+/g, '');
  let json: string;

  // The URL form. Checked first because it is the one an operator is most
  // likely to paste, and because everything it needs is on the face of it:
  // origin, event id in the path, token in `k`. The event name and expiry are
  // absent, and deliberately not invented — `bind` takes both from the
  // handshake, which is the authority on them anyway.
  if (/^https?:\/\//i.test(compact)) {
    return fromUrl(compact);
  }

  if (compact.startsWith(HJUDGE_CREDENTIAL_PREFIX)) {
    const body = compact.slice(HJUDGE_CREDENTIAL_PREFIX.length);
    try {
      json = Buffer.from(body, 'base64url').toString('utf8');
    } catch {
      throw new Error('That connection code is damaged — copy it again');
    }
  } else if (raw.startsWith('{')) {
    json = raw;
  } else {
    throw new Error(
      `A connection code starts with ${HJUDGE_CREDENTIAL_PREFIX} — this does not`,
    );
  }

  let parsed: Partial<HjudgeSyncCredential>;
  try {
    parsed = JSON.parse(json) as Partial<HjudgeSyncCredential>;
  } catch {
    throw new Error('That connection code is damaged — copy it again');
  }

  const baseUrl = normaliseBaseUrl(parsed.baseUrl ?? '');
  const eventId = String(parsed.eventId ?? '').trim();
  const token = String(parsed.token ?? '').trim();

  if (!baseUrl) throw new Error('The connection code carries no server address');
  if (!eventId) throw new Error('The connection code names no event');
  if (!token) throw new Error('The connection code carries no credential');

  return {
    baseUrl,
    eventId,
    eventName: String(parsed.eventName ?? '').trim(),
    token,
    expiresAt: String(parsed.expiresAt ?? '').trim(),
  };
}

/** Pull a credential out of the URL form. Kept beside the encoder so the two
 *  cannot drift on the parameter name or the path shape. */
function fromUrl(input: string): HjudgeSyncCredential {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('That does not look like a URL — copy the endpoint again');
  }

  const token = (url.searchParams.get('k') ?? '').trim();
  // `/api/hyfit-judge/ingest/events/<uuid>` — take the segment AFTER `events`
  // rather than the last one, so the same paste works whether or not somebody
  // included a trailing `/athletes` or `/results`.
  const parts = url.pathname.split('/').filter(Boolean);
  const eventId = parts[parts.indexOf('events') + 1] ?? '';

  if (!token) {
    throw new Error(
      'That endpoint has no credential on it. Copy the whole line including the ?k= part — it is the half that makes it work.',
    );
  }
  if (!eventId) {
    throw new Error('That endpoint names no event — copy it again from prod');
  }

  return {
    baseUrl: url.origin,
    eventId,
    eventName: '',
    token,
    // Unknown from the URL alone; the handshake supplies it.
    expiresAt: '',
  };
}

/** Origin only, no trailing slash, no path. The push service appends the API
 *  path itself; a base URL that already carried one would produce
 *  `/api/api/hyfit-judge/...` and a 404 nobody would read as a typo. */
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
 * counted: an athlete row is a couple of hundred bytes or a couple of thousand
 * depending on how much `raw` RaceResult's export carried, and a fixed
 * rows-per-chunk that is safe for the fat case wastes most of the budget on the
 * thin one.
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
  // One empty chunk, marked final by the caller. (An empty ROSTER is refused
  // before it reaches here — see HjudgePushService.pushAthletes.)
  return chunks.length ? chunks : [[]];
}

/** Room for `{"batch":"…","seq":0,"final":true,"rows":[]}` and then some. */
const ENVELOPE_BYTES = 512;
