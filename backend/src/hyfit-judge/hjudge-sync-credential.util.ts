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

export function encodeSyncCredential(credential: HjudgeSyncCredential): string {
  return (
    HJUDGE_CREDENTIAL_PREFIX +
    Buffer.from(JSON.stringify(credential), 'utf8').toString('base64url')
  );
}

/**
 * Parse what the operator pasted.
 *
 * Accepts the code, the code with whitespace or a stray newline through it
 * (which is what copying out of a chat window does), and bare JSON — because
 * somebody will eventually paste the object rather than the code, and failing
 * on it would be a refusal to read something perfectly unambiguous.
 *
 * Throws with a message aimed at the person holding the paste buffer.
 */
export function decodeSyncCredential(input: string): HjudgeSyncCredential {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Paste the connection code from the prod console');

  const compact = raw.replace(/\s+/g, '');
  let json: string;

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
