import {
  chunkByBytes,
  decodeSyncCredential,
  encodeSyncCredential,
  normaliseBaseUrl,
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
