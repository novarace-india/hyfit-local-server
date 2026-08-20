import {
  chunkByBytes,
  encodeSyncPair,
  encodeSyncUrl,
  normaliseBaseUrl,
  parseSyncEndpoint,
  rehostEndpoint,
  stripToken,
} from './hjudge-sync-credential.util';

/* The two pure pieces of offline-event sync, which are also the two most
 * breakable: a URL parser whose failures land on somebody at a venue with a
 * paste buffer, and a chunker whose failures land as a 413 on every push.
 * Everything else in that feature needs two databases and a network. */

const BASE = 'https://app.example.com';
const EVENT = '11111111-2222-3333-4444-555555555555';
const TOKEN = 'hyfitsync_' + 'a'.repeat(64);

describe('sync endpoint URLs', () => {
  it('publishes the two endpoints prod hands out', () => {
    const { pullUrl, pushUrl } = encodeSyncPair(BASE, EVENT, TOKEN);
    expect(pullUrl).toBe(
      `${BASE}/api/hyfit-judge/ingest/events/${EVENT}/config?k=${TOKEN}`,
    );
    expect(pushUrl).toBe(
      `${BASE}/api/hyfit-judge/ingest/events/${EVENT}/results?k=${TOKEN}`,
    );
  });

  it('reads back what it wrote', () => {
    const parsed = parseSyncEndpoint(encodeSyncUrl(BASE, EVENT, TOKEN, 'config'));
    expect(parsed.baseUrl).toBe(BASE);
    expect(parsed.eventId).toBe(EVENT);
    expect(parsed.token).toBe(TOKEN);
    expect(parsed.route).toBe('config');
  });

  /* THE POINT OF THE WHOLE PARSER. An operator pastes whichever of the two they
   * happened to copy, and both must produce the same pairing — otherwise which
   * one they grabbed decides whether the laptop can pull, push, or half of
   * each. */
  it('derives the same pair from either endpoint', () => {
    const { pullUrl, pushUrl } = encodeSyncPair(BASE, EVENT, TOKEN);
    const fromPull = parseSyncEndpoint(pullUrl);
    const fromPush = parseSyncEndpoint(pushUrl);

    expect(fromPull.pullUrl).toBe(fromPush.pullUrl);
    expect(fromPull.pushUrl).toBe(fromPush.pushUrl);
    expect(fromPull.route).toBe('config');
    expect(fromPush.route).toBe('results');
  });

  /* The stored form carries no credential: the token lives in its own column
   * and travels as a Bearer header. A second copy inside a string the console
   * renders would undo that. */
  it('strips the credential out of what it stores', () => {
    const parsed = parseSyncEndpoint(encodeSyncUrl(BASE, EVENT, TOKEN, 'results'));
    expect(parsed.pullUrl).not.toContain('k=');
    expect(parsed.pushUrl).not.toContain('k=');
    expect(parsed.pullUrl).toBe(
      `${BASE}/api/hyfit-judge/ingest/events/${EVENT}/config`,
    );
    // …and the token is still returned, separately, for the column that holds it.
    expect(parsed.token).toBe(TOKEN);
  });

  // Copying out of a chat window is how these actually travel, and that is
  // where the line breaks come from.
  it('survives whitespace and line breaks introduced by copying', () => {
    const url = encodeSyncUrl(BASE, EVENT, TOKEN, 'config');
    const mangled = `${url.slice(0, 20)}\n  ${url.slice(20, 60)}\t${url.slice(60)}  `;
    expect(parseSyncEndpoint(mangled).token).toBe(TOKEN);
  });

  it('keeps a non-default port', () => {
    const parsed = parseSyncEndpoint(
      encodeSyncUrl('http://192.168.1.20:3001', EVENT, TOKEN, 'config'),
    );
    expect(parsed.baseUrl).toBe('http://192.168.1.20:3001');
  });

  it('survives a token with characters that need escaping', () => {
    const odd = 'hyfitsync_a+b/c=d e';
    expect(parseSyncEndpoint(encodeSyncUrl(BASE, EVENT, odd, 'config')).token).toBe(
      odd,
    );
  });

  it('names what is missing rather than failing generically', () => {
    expect(() => parseSyncEndpoint('')).toThrow(/paste the sync url/i);
    // The half-copied paste: everything up to the query string. It looks
    // complete, and it is useless, so it has to say which half is missing.
    const truncated = encodeSyncUrl(BASE, EVENT, TOKEN, 'config').split('?')[0];
    expect(() => parseSyncEndpoint(truncated)).toThrow(/\?k=/);
    expect(() => parseSyncEndpoint(`${BASE}/api/hyfit-judge/ingest?k=${TOKEN}`)).toThrow(
      /names no event/i,
    );
  });

  /* The retired code form. Somebody will have a HYFITSYNC1 blob in a chat
   * window from before 093, and "not a URL" is a worse answer than saying the
   * form is gone and what to do instead. */
  it('tells the holder of an old HYFITSYNC1 code what to do', () => {
    expect(() => parseSyncEndpoint('HYFITSYNC1.eyJhIjoxfQ')).toThrow(
      /HYFITSYNC1/,
    );
  });

  /* "Change server address": prod moves, the path below the origin does not. */
  describe('rehosting', () => {
    it('swaps the origin and keeps the path', () => {
      const { pullUrl } = encodeSyncPair(BASE, EVENT, TOKEN);
      expect(rehostEndpoint(stripToken(pullUrl), 'https://staging.example.com')).toBe(
        `https://staging.example.com/api/hyfit-judge/ingest/events/${EVENT}/config`,
      );
    });

    it('leaves the endpoint alone when the new address is unusable', () => {
      const url = `${BASE}/api/hyfit-judge/ingest/events/${EVENT}/config`;
      expect(rehostEndpoint(url, 'not a url at all')).toBe(url);
    });
  });

  // A base URL carrying a path would produce /api/api/... and a 404 nobody
  // would read as a typo.
  it('reduces a base URL to its origin', () => {
    expect(normaliseBaseUrl('https://app.example.com/')).toBe(BASE);
    expect(normaliseBaseUrl('https://app.example.com/api/hyfit-judge')).toBe(BASE);
    expect(normaliseBaseUrl('app.example.com')).toBe(BASE);
    expect(normaliseBaseUrl('http://192.168.1.20:3001')).toBe(
      'http://192.168.1.20:3001',
    );
    expect(normaliseBaseUrl('  ')).toBe('');
    expect(normaliseBaseUrl('not a url at all')).toBe('');
  });
});

describe('push chunking', () => {
  const row = (i: number) => ({ id: i, raw: 'x'.repeat(500) });

  it('keeps every chunk inside the budget', () => {
    const rows = Array.from({ length: 200 }, (_, i) => row(i));
    const chunks = chunkByBytes(rows, 8_000);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(JSON.stringify(chunk), 'utf8')).toBeLessThan(
        8_000,
      );
    }
  });

  it('loses nothing and reorders nothing', () => {
    const rows = Array.from({ length: 57 }, (_, i) => row(i));
    expect(chunkByBytes(rows, 4_000).flat()).toEqual(rows);
  });

  // An empty snapshot is still a push: it is how "everybody withdrew" reaches
  // prod, and the receiver has to be given a final chunk to prune against.
  it('emits one empty chunk for an empty snapshot', () => {
    expect(chunkByBytes([], 80_000)).toEqual([[]]);
  });

  // Loudly, once — rather than silently dropped out of a snapshot that then
  // reports success.
  it('emits an oversized row alone rather than discarding it', () => {
    const huge = { id: 1, raw: 'x'.repeat(50_000) };
    const chunks = chunkByBytes([huge, { id: 2 }], 4_000);
    expect(chunks[0]).toEqual([huge]);
    expect(chunks.flat()).toHaveLength(2);
  });

  it('packs thin rows together instead of one per request', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    expect(chunkByBytes(rows, 80_000)).toHaveLength(1);
  });
});
