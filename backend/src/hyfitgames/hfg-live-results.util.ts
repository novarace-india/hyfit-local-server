import {
  valueAtPath,
  normalizeBib,
} from '../hyfit-judge/hjudge-participant-import.util';

/* Reading a RaceResult RESULTS feed.
 *
 * The roster importer next door (`parseParticipantImport`) reads the same
 * provider's PARTICIPANT feed, and the two are deliberately separate functions:
 * a participant row answers "who is entered", a result row answers "what did
 * they do". They share the provider's shape conventions — a list somewhere in
 * the payload, column names that vary per event, `valueAtPath` to reach into
 * it — and nothing else. Folding them together would mean one config object
 * where half the fields are meaningless on either side.
 *
 * The bib is the join key and the only required field. Everything else is
 * matched by alias against the first row's keys, so an operator who has never
 * opened the mapping screen still gets a usable pull off a normally-configured
 * RaceResult export.
 */

export type LiveResultRecord = {
  bib: string;
  full_name: string | null;
  category: string | null;
  gender: string | null;
  total_ms: number | null;
  rank: number | null;
  status: string;
};

export type LiveResultsParse = {
  records: LiveResultRecord[];
  rejectedCount: number;
};

/* RaceResult writes a finish time half a dozen ways depending on how the event
 * was set up, and the difference between them is three orders of magnitude —
 * so guessing wrong here does not produce a slightly-off leaderboard, it
 * produces one where every time is nonsense. Each accepted form is therefore
 * recognised explicitly and anything unrecognised becomes null (no time) rather
 * than a number that happens to parse.
 *
 *   "01:23:45.67"  h:m:s.frac      the usual chip-timing export
 *   "23:45.67"     m:s.frac
 *   "1:23:45"      h:m:s
 *   4225670        a bare number   → see below
 *
 * A bare number is the ambiguous case: it is milliseconds in some exports and
 * seconds in others, and no flag in the payload distinguishes them. The split
 * is by magnitude — under 100000 (~27 hours as seconds, but only 100 seconds as
 * ms) it is read as seconds, above that as milliseconds. A HYFIT race lasts
 * tens of minutes, so both readings land far from that boundary.
 */
export function parseTimeMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null;
    return value < 100_000 ? Math.round(value * 1000) : Math.round(value);
  }

  const raw = String(value).trim();
  if (!raw) return null;

  // A clock string: 1–3 colon-separated parts, optional fractional seconds.
  const clock = /^(?:(\d+):)?(?:(\d{1,2}):)?(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(
    raw,
  );
  if (clock) {
    const [, a, b, c, frac] = clock;
    // The regex is greedy from the left, so "23:45" fills a and c, not b and c.
    const hours = b !== undefined ? Number(a ?? 0) : 0;
    const minutes = b !== undefined ? Number(b) : Number(a ?? 0);
    const seconds = Number(c);
    const millis = frac ? Number(frac.padEnd(3, '0')) : 0;
    const total = ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
    return total > 0 ? total : null;
  }

  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0)
    return numeric < 100_000 ? Math.round(numeric * 1000) : Math.round(numeric);

  return null;
}

/* The provider's status vocabulary mapped onto ours ('REG'|'FIN'|'DNF'|'DNS'|
 * 'DQ'). An entry with a time and no status is a finisher — that is what having
 * a time means — and one with neither is still registered, not a DNS: a mid-race
 * pull is mostly athletes who simply have not finished yet, and calling them
 * DNS would be a claim the feed never made.
 */
export function normalizeRaceStatus(
  value: unknown,
  totalMs: number | null,
): string {
  const raw = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, '');

  if (!raw) return totalMs ? 'FIN' : 'REG';

  // Matched on containment, not prefix: the provider writes these out in full
  // as often as it abbreviates them, and "Did not start" squashes to
  // DIDNOTSTART — which starts with neither "DNS" nor "NOTSTARTED", and was
  // silently read as "still racing" until a test said so. A DNS shown as an
  // athlete still on course is a wrong answer that looks like a right one.
  if (raw.includes('DIDNOTFINISH') || raw.includes('NOTFINISHED')) return 'DNF';
  if (
    raw.includes('DIDNOTSTART') ||
    raw.includes('NOTSTARTED') ||
    raw.includes('NOSHOW')
  )
    return 'DNS';
  if (raw.startsWith('DNF')) return 'DNF';
  if (raw.startsWith('DNS')) return 'DNS';
  if (raw.startsWith('DQ') || raw.startsWith('DSQ') || raw.includes('DISQUALIF'))
    return 'DQ';
  if (raw.startsWith('FIN') || raw === 'OK') return 'FIN';
  return totalMs ? 'FIN' : 'REG';
}

function normalizeGender(value: unknown): string | null {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (raw.startsWith('m')) return 'male';
  if (raw.startsWith('f') || raw.startsWith('w')) return 'female';
  return null;
}

function toRank(value: unknown): number | null {
  const n = Number(String(value ?? '').replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const ALIASES = {
  bib: ['bib', 'bibnumber', 'startnumber', 'startno', 'no'],
  full_name: ['name', 'fullname', 'participant', 'athlete', 'displayname'],
  category: ['category', 'contest', 'race', 'class', 'division'],
  gender: ['gender', 'sex', 'mf'],
  total_ms: [
    'time',
    'totaltime',
    'finishtime',
    'nettime',
    'chiptime',
    'result',
    'elapsed',
  ],
  rank: ['rank', 'place', 'position', 'pos', 'overallrank'],
  status: ['status', 'racestatus', 'state', 'finishstatus'],
} as const;

type Field = keyof typeof ALIASES;

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/* Find the list of result rows.
 *
 * RaceResult buries it at a different depth per endpoint, and the mapping may
 * name the path explicitly. Failing that, the first array-of-objects found by a
 * shallow walk is it — deep enough for the shapes this provider actually emits
 * ({data: [...]}, {Results: {List: [...]}}), and shallow enough that it cannot
 * wander into some unrelated nested array.
 */
function findRows(
  payload: unknown,
  listPath: string,
): Record<string, unknown>[] {
  const isRowList = (v: unknown): v is Record<string, unknown>[] =>
    Array.isArray(v) &&
    v.length > 0 &&
    !!v[0] &&
    typeof v[0] === 'object' &&
    !Array.isArray(v[0]);

  if (listPath) {
    const at = valueAtPath(payload, listPath);
    if (isRowList(at)) return at;
  }
  if (isRowList(payload)) return payload;

  const walk = (
    node: unknown,
    depth: number,
  ): Record<string, unknown>[] | null => {
    if (depth > 3 || !node || typeof node !== 'object') return null;
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (isRowList(value)) return value;
      const nested = walk(value, depth + 1);
      if (nested) return nested;
    }
    return null;
  };
  return walk(payload, 0) ?? [];
}

/* Resolve each field to the key it actually has in THIS payload: the configured
 * name when the mapping supplies one that exists, otherwise the first key whose
 * squashed spelling matches a known alias.
 */
function resolveFields(
  sample: Record<string, unknown>,
  mapping: Record<string, unknown>,
): Record<Field, string | null> {
  const keys = Object.keys(sample);
  const out = {} as Record<Field, string | null>;

  for (const field of Object.keys(ALIASES) as Field[]) {
    const configured = String(
      mapping[`${field}Field`] ?? mapping[field] ?? '',
    ).trim();
    if (configured && valueAtPath(sample, configured) !== undefined) {
      out[field] = configured;
      continue;
    }
    const wanted = ALIASES[field].map(squash);
    out[field] = keys.find((k) => wanted.includes(squash(k))) ?? null;
  }
  return out;
}

export function parseLiveResults(
  payload: unknown,
  mapping: Record<string, unknown> = {},
): LiveResultsParse {
  const listPath = String(mapping.listPath ?? mapping.list_path ?? '').trim();
  const rows = findRows(payload, listPath);
  if (!rows.length) return { records: [], rejectedCount: 0 };

  const fields = resolveFields(rows[0], mapping);
  const read = (row: Record<string, unknown>, field: Field) =>
    fields[field] ? valueAtPath(row, fields[field]) : undefined;

  const records: LiveResultRecord[] = [];
  let rejectedCount = 0;

  for (const row of rows) {
    // No bib, no row. The bib is how a live result finds the athlete it belongs
    // to; a row without one cannot be shown to anybody, so it is dropped and
    // counted rather than kept as an anonymous time.
    const bib = normalizeBib(read(row, 'bib'));
    if (!bib) {
      rejectedCount++;
      continue;
    }

    const total_ms = parseTimeMs(read(row, 'total_ms'));
    const name = String(read(row, 'full_name') ?? '').trim();

    records.push({
      bib,
      full_name: name || null,
      category: String(read(row, 'category') ?? '').trim() || null,
      gender: normalizeGender(read(row, 'gender')),
      total_ms,
      rank: toRank(read(row, 'rank')),
      status: normalizeRaceStatus(read(row, 'status'), total_ms),
    });
  }

  return { records, rejectedCount };
}
