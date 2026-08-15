import {
  chunkByBytes,
  decodeSyncCredential,
  defaultIngestEndpoint,
  encodeSyncCredential,
  encodeSyncUrl,
  normaliseBaseUrl,
  parseIngestEndpoint,
  rehostEndpoint,
  HJUDGE_CREDENTIAL_PREFIX,
} from './hjudge-sync-credential.util';

/* The two pure pieces of offline-event sync, which are also the two most
 * breakable: a codec whose failures land on somebody at a venue with a paste
 * buffer, and a chunker whose failures land as a 413 on every push. Everything
 * else in that feature needs two databases and a network to exercise. */

const credential = {
  baseUrl: 'https://app.example.com',
  eventId: '11111111-2222-3333-4444-555555555555',
  eventName: 'HYFIT Bengaluru',
  token: 'hyfitsync_' + 'a'.repeat(64),
  expiresAt: '2026-09-01T00:00:00.000Z',
};

describe('sync connection codes', () => {
  it('round-trips', () => {
    expect(decodeSyncCredential(encodeSyncCredential(credential))).toEqual(
      credential,
    );
  });

  // Copying out of a chat window is how these actually travel, and that is
  // where the line breaks come from.
  it('survives whitespace and line breaks introduced by copying', () => {
    const code = encodeSyncCredential(credential);
    const mangled = `${code.slice(0, 20)}\n  ${code.slice(20, 60)}\t${code.slice(60)}  `;
    expect(decodeSyncCredential(mangled)).toEqual(credential);
  });

  // Somebody will paste the object rather than the code. Refusing something
  // this unambiguous would be a refusal for its own sake.
  it('accepts the bare JSON as well as the code', () => {
    expect(decodeSyncCredential(JSON.stringify(credential))).toEqual(credential);
  });

  it('names what is missing rather than failing generically', () => {
    expect(() => decodeSyncCredential('')).toThrow(/paste the connection code/i);
    expect(() => decodeSyncCredential('some-random-string')).toThrow(
      new RegExp(HJUDGE_CREDENTIAL_PREFIX),
    );
    expect(() =>
      decodeSyncCredential(JSON.stringify({ ...credential, token: '' })),
    ).toThrow(/no credential/i);
    expect(() =>
      decodeSyncCredential(JSON.stringify({ ...credential, eventId: '' })),
    ).toThrow(/names no event/i);
    expect(() =>
      decodeSyncCredential(JSON.stringify({ ...credential, baseUrl: '' })),
    ).toThrow(/no server address/i);
  });

  // The endpoint form: what prod's console leads with, and what an operator is
  // most likely to actually paste.
  describe('the endpoint URL form', () => {
    it('round-trips the parts that matter', () => {
      const back = decodeSyncCredential(encodeSyncUrl(credential));
      expect(back.baseUrl).toBe(credential.baseUrl);
      expect(back.eventId).toBe(credential.eventId);
      expect(back.token).toBe(credential.token);
      // Neither is carried by a URL; `bind` takes both from the handshake,
      // which is the authority on them in any case.
      expect(back.eventName).toBe('');
      expect(back.expiresAt).toBe('');
    });

    // Prod hands out two: one per destination. Either must bind the same
    // target, because they are two routes on one credential — not two keys.
    it('accepts either of the two endpoints prod publishes', () => {
      const athletes = encodeSyncUrl(credential, 'athletes');
      const results = encodeSyncUrl(credential, 'results');

      expect(athletes).toContain('/athletes?k=');
      expect(results).toContain('/results?k=');

      const a = decodeSyncCredential(athletes);
      const r = decodeSyncCredential(results);
      expect(a).toEqual(r);
      expect(a.eventId).toBe(credential.eventId);
      expect(a.token).toBe(credential.token);
      expect(a.baseUrl).toBe(credential.baseUrl);
    });

    it('reads the bare event endpoint too', () => {
      const bare = encodeSyncUrl(credential);
      expect(bare).not.toContain('/athletes');
      expect(decodeSyncCredential(bare).eventId).toBe(credential.eventId);
    });

    it('keeps a non-default port', () => {
      const local = { ...credential, baseUrl: 'http://192.168.1.20:3001' };
      expect(decodeSyncCredential(encodeSyncUrl(local)).baseUrl).toBe(
        'http://192.168.1.20:3001',
      );
    });

    // The half-copied paste: everything up to the query string. It looks
    // complete, and it is useless, so it has to say which half is missing.
    it('names the missing credential when the ?k= was left behind', () => {
      const truncated = encodeSyncUrl(credential).split('?')[0];
      expect(() => decodeSyncCredential(truncated)).toThrow(/\?k=/);
    });

    it('survives a token with characters that need escaping', () => {
      const odd = { ...credential, token: 'hyfitsync_a+b/c=d e' };
      expect(decodeSyncCredential(encodeSyncUrl(odd)).token).toBe(odd.token);
    });
  });

  it('rejects a truncated code as damaged', () => {
    const code = encodeSyncCredential(credential);
    expect(() => decodeSyncCredential(code.slice(0, code.length - 20))).toThrow(
      /damaged/i,
    );
  });

  // A base URL carrying a path would produce /api/api/... and a 404 nobody
  // would read as a typo.
  it('reduces a base URL to its origin', () => {
    expect(normaliseBaseUrl('https://app.example.com/')).toBe(
      'https://app.example.com',
    );
    expect(normaliseBaseUrl('https://app.example.com/api/hyfit-judge')).toBe(
      'https://app.example.com',
    );
    expect(normaliseBaseUrl('app.example.com')).toBe('https://app.example.com');
    expect(normaliseBaseUrl('http://192.168.1.20:3001')).toBe(
      'http://192.168.1.20:3001',
    );
    expect(normaliseBaseUrl('  ')).toBe('');
    expect(normaliseBaseUrl('not a url at all')).toBe('');
  });
});

/* The two endpoints, kept whole.
 *
 * This is the half `decodeSyncCredential` deliberately throws away, and the
 * throwing-away is what made a pasted results endpoint look accepted and do
 * nothing: the path was discarded and the sender rebuilt one it had invented.
 * So what these assert is mostly "the URL that comes out is the URL that went
 * in, minus the secret". */
describe('ingest endpoints', () => {
  const athletes = encodeSyncUrl(credential, 'athletes');
  const results = encodeSyncUrl(credential, 'results');

  it('keeps the pasted path and strips only the credential', () => {
    const parsed = parseIngestEndpoint(athletes, 'athletes');
    expect(parsed.url).toBe(athletes.split('?')[0]);
    expect(parsed.url).not.toContain('k=');
    expect(parsed.token).toBe(credential.token);
    expect(parsed.eventId).toBe(credential.eventId);
    expect(parsed.baseUrl).toBe(credential.baseUrl);
  });

  // The point of the change: prod publishing this route from somewhere the
  // sender would never have guessed is not an error, and the pasted address is
  // what gets stored.
  it('keeps a path this codebase would never have built', () => {
    const odd =
      'https://ingest.example.com/hyfit/v9/events/' +
      credential.eventId +
      '/standings?k=' +
      credential.token;
    const parsed = parseIngestEndpoint(odd, 'results');
    expect(parsed.url).toBe(odd.split('?')[0]);
    expect(parsed.baseUrl).toBe('https://ingest.example.com');
  });

  it('keeps other query parameters, and does not leave a bare ?', () => {
    const withExtras = `${athletes}&tenant=bengaluru`;
    const parsed = parseIngestEndpoint(withExtras, 'athletes');
    expect(parsed.url).toContain('tenant=bengaluru');
    expect(parsed.url).not.toContain('k=');
    expect(parseIngestEndpoint(athletes, 'athletes').url).not.toMatch(/\?$/);
  });

  // The silent mix-up: the same URL in both boxes sends the roster to the
  // results route, which prod accepts as an empty standings push.
  it('catches the two endpoints being pasted the wrong way round', () => {
    expect(() => parseIngestEndpoint(results, 'athletes')).toThrow(/results/i);
    expect(() => parseIngestEndpoint(athletes, 'results')).toThrow(
      /participants/i,
    );
  });

  it('names what is missing, per box', () => {
    expect(() => parseIngestEndpoint('', 'results')).toThrow(/results endpoint/i);
    expect(() => parseIngestEndpoint('', 'athletes')).toThrow(
      /participants endpoint/i,
    );
    expect(() => parseIngestEndpoint(athletes.split('?')[0], 'athletes')).toThrow(
      /\?k=/,
    );
    expect(() => parseIngestEndpoint('HYFITSYNC1.abc', 'athletes')).toThrow(
      /https:\/\//,
    );
    expect(() =>
      parseIngestEndpoint(`https://app.example.com/nothing?k=x`, 'athletes'),
    ).toThrow(/names no event/i);
  });

  it('survives a token with characters that need escaping', () => {
    const odd = { ...credential, token: 'hyfitsync_a+b/c=d e' };
    expect(parseIngestEndpoint(encodeSyncUrl(odd, 'results'), 'results').token).toBe(
      odd.token,
    );
  });

  // What a binding made from the short code — or one made before the endpoints
  // were stored at all — falls back to. It must be exactly what the sender used
  // to build, or those bindings change behaviour on upgrade.
  it('builds the same endpoint the URL form encodes', () => {
    expect(
      defaultIngestEndpoint(credential.baseUrl, credential.eventId, 'results'),
    ).toBe(results.split('?')[0]);
  });

  // "Change server address" has to move the endpoints with it, or it is a
  // no-op on the only field it exists to fix.
  it('moves an endpoint onto another origin, path intact', () => {
    const moved = rehostEndpoint(
      'https://app.example.com/hyfit/v9/events/abc/standings',
      'http://192.168.1.20:3001',
    );
    expect(moved).toBe('http://192.168.1.20:3001/hyfit/v9/events/abc/standings');
  });

  it('leaves an endpoint alone when the new address is unusable', () => {
    const url = 'https://app.example.com/x';
    expect(rehostEndpoint(url, 'not a url at all')).toBe(url);
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
