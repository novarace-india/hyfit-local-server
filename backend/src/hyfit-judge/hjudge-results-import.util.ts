/* Reading a RaceResult RESULTS feed.
 *
 * The participant importer next door (`hjudge-participant-import.util.ts`)
 * reads the same provider's START LIST, and the two are deliberately separate:
 * a participant row answers "who is entered", a result row answers "what did
 * they do". They share the provider's conventions — a list somewhere in the
 * payload, per-event column spellings, a mapping that can override any of
 * them — and nothing else.
 *
 * Kept free of Nest and pg so the mapping rules can be reasoned about, and
 * tested, on their own. The service that calls this decides where the rows go;
 * this file decides only what they mean.
 *
 * The bib is the join key and the only required field. Everything else is
 * matched by alias against the payload's own keys, so an operator who has never
 * opened the mapping box still gets a usable pull off a normal HYFIT export.
 */

export type ImportedResult = {
  bib: string;
  name: string;
  category: string;
  club: string;
  mobile: string;
  gender: string;
  age: number | null;
  status: 'REG' | 'FIN' | 'DNF' | 'DNS' | 'DQ';
  rank: number | null;
  ageGroupRank: number | null;
  totalMs: number | null;
  teamTimeMs: number | null;
  /** The cognitive memorise segment at the start of the circuit (ST0COG). */
  cogMs: number | null;
  /** Six runs and six stations, in course order. Index 0 is Run1 / ST1. */
  runMs: (number | null)[];
  stationMs: (number | null)[];
  /** Every penalty and bonus column the feed carried a value in, by its own
   *  name. See the note on `collectPenalties`. */
  penalties: Record<string, string>;
  raw: Record<string, unknown>;
};

export type ResultsParse = {
  results: ImportedResult[];
  /** Rows dropped for having no usable bib. Reported, never silently absorbed:
   *  it is almost always the bib column being mapped to the wrong name, and a
   *  feed that half-parses looks like a race half the field did not run. */
  rejectedCount: number;
  /** The payload's own column names, for the console to show an operator who
   *  needs to write a mapping. */
  sourceColumns: string[];
};

const STATION_COUNT = 6;

/* RaceResult writes a time half a dozen ways depending on how the event was set
 * up, and the difference between them is three orders of magnitude — so a wrong
 * guess here does not produce a slightly-off leaderboard, it produces one where
 * every time is nonsense. Each accepted form is recognised explicitly and
 * anything else becomes null (no time) rather than a number that happens to
 * parse.
 *
 *   "1:31:21"   h:mm:ss     a long team total
 *   "22:16"     mm:ss       a HYFIT race total
 *   "00:11"     mm:ss       a memorise segment — eleven seconds, not eleven minutes
 *   "23:45.67"  mm:ss.frac
 *   4225670     a bare number → see below
 *
 * A bare number is the ambiguous case: milliseconds in some exports, seconds in
 * others, with no flag in the payload to tell them apart. The split is by
 * magnitude — under 100000 (~27 hours read as seconds, but only 100 seconds
 * read as ms) it is seconds, above that milliseconds. A HYFIT race lasts tens
 * of minutes, so both readings land far from that boundary.
 */
export function parseTimeMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null;
    return value < 100_000 ? Math.round(value * 1000) : Math.round(value);
  }

  const raw = String(value).trim();
  if (!raw) return null;

  const clock = /^(?:(\d+):)?(?:(\d{1,2}):)?(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(
    raw,
  );
  if (clock) {
    const [, a, b, c, frac] = clock;
    // The regex is greedy from the left, so "22:16" fills a and c, not b and c
    // — which is why minutes, not hours, is the one that reads `a` when there
    // are only two parts.
    const hours = b !== undefined ? Number(a ?? 0) : 0;
    const minutes = b !== undefined ? Number(b) : Number(a ?? 0);
    const seconds = Number(c);
    const millis = frac ? Number(frac.padEnd(3, '0')) : 0;
    const total = ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
    // "00:00" is how this feed spells "no team time" — a zero is the absence of
    // a time, never a time of zero.
    return total > 0 ? total : null;
  }

  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0)
    return numeric < 100_000 ? Math.round(numeric * 1000) : Math.round(numeric);

  return null;
}

/* The provider's status vocabulary mapped onto ours. An entry with a time and
 * no status is a finisher — that is what having a time means — and one with
 * neither is still registered, NOT a DNS: a mid-race pull is mostly athletes
 * who have simply not finished yet, and calling them DNS would be a claim the
 * feed never made.
 */
export function normalizeStatus(
  value: unknown,
  totalMs: number | null,
): ImportedResult['status'] {
  const raw = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, '');

  if (!raw) return totalMs ? 'FIN' : 'REG';

  // Matched on containment rather than prefix: RaceResult writes these out in
  // full as often as it abbreviates them, and "Did not start" squashes to
  // DIDNOTSTART, which begins with neither "DNS" nor "NOTSTARTED".
  if (raw.includes('DIDNOTFINISH') || raw.includes('NOTFINISHED')) return 'DNF';
  if (
    raw.includes('DIDNOTSTART') ||
    raw.includes('NOTSTARTED') ||
    raw.includes('NOSHOW')
  )
    return 'DNS';
  if (raw.startsWith('DNF')) return 'DNF';
  if (raw.startsWith('DNS')) return 'DNS';
  if (
    raw.startsWith('DQ') ||
    raw.startsWith('DSQ') ||
    raw.includes('DISQUALIF')
  )
    return 'DQ';
  if (raw.startsWith('FIN') || raw === 'OK') return 'FIN';
  return totalMs ? 'FIN' : 'REG';
}

/* Is this contest raced in a team?
 *
 * RaceResult's `TeamTime` column is NOT evidence. On the reference event it is
 * filled for 332 of 351 entries in Female Open and 130 of 150 in NextGen Boys —
 * both individual contests — and for none at all in Male Open. Whatever it
 * holds for a solo athlete (a wave total, a leftover from another view), it is
 * not that athlete's team time, and showing it to them as one is how an
 * individual entrant ends up with a "Team 1:31:21 · <club>" line on their
 * result for a race they ran alone.
 *
 * For genuine doubles it is right and worth keeping: both members of a pair
 * carry the same value and it equals the LATER partner's finish, which is the
 * team-time rule this platform already uses.
 *
 * So the contest decides, and the only thing naming the contest is its name.
 * This mirrors what migration 056 did in the old schema — infer the format from
 * the name — because nothing else in the feed says it. A team category spelled
 * in a way this does not recognise loses its team time until the word is added
 * here; that is the failure worth having, because the other direction invents a
 * team for somebody who does not have one.
 */
const TEAM_CONTEST = /\b(doubles?|pairs?|relay|teams?|duos?|trios?|squad)\b/i;

export function isTeamCategory(category: string | null | undefined): boolean {
  return TEAM_CONTEST.test(String(category ?? ''));
}

function normalizeBib(value: unknown): string {
  if (value == null) return '';
  const bib = String(value).trim();
  return /^\d+$/.test(bib) ? bib : '';
}

function toInt(value: unknown): number | null {
  const n = Number(String(value ?? '').replace(/[^\d-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeGender(value: unknown): string {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('m')) return 'male';
  if (raw.startsWith('f') || raw.startsWith('w')) return 'female';
  return '';
}

export function valueAtPath(value: unknown, path: string): unknown {
  if (!path?.trim()) return value;
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

/* Our field key → the spellings this provider uses for it. The station and run
 * aliases below cover the two shapes seen in the wild: HYFIT's own export
 * ("Run1", "ST1", "ST0COG") and the longer names the judge app writes back
 * ("run1time", "station1time").
 */
const ALIASES: Record<string, string[]> = {
  bib: ['bib', 'bibnumber', 'startnumber', 'startno', 'no'],
  name: ['name', 'fullname', 'participant', 'athlete', 'displayname'],
  category: ['category', 'contest', 'race', 'class', 'division'],
  club: ['club', 'team', 'teamname', 'clubname'],
  mobile: ['phone', 'mobile', 'contact', 'phonenumber', 'mobilenumber'],
  gender: ['gender', 'sex', 'mf'],
  age: ['age'],
  status: ['status', 'racestatus', 'state', 'finishstatus'],
  rank: ['rank', 'place', 'position', 'pos', 'overallrank'],
  ageGroupRank: ['agegrouprank', 'agrank', 'agegroupplace', 'categoryrank'],
  total: [
    'total',
    'totaltime',
    'time',
    'finishtime',
    'nettime',
    'chiptime',
    'totalracetime',
  ],
  teamTime: ['teamtime', 'teamtotal', 'teamtotaltime'],
  cog: ['st0cog', 'cog', 'cognitive', 'cognitivememorisetime', 'st0'],
};

for (let i = 1; i <= STATION_COUNT; i++) {
  ALIASES[`run${i}`] = [`run${i}`, `run${i}time`, `r${i}`];
  ALIASES[`station${i}`] = [
    `st${i}`,
    `station${i}`,
    `station${i}time`,
    `s${i}`,
  ];
}

type Field = keyof typeof ALIASES;

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/* Find the list of result rows.
 *
 * RaceResult buries it at a different depth per endpoint, and a mapping may
 * name the path outright. Failing that, the first array-of-objects a shallow
 * walk finds is it — deep enough for the shapes this provider emits
 * ({data:[…]}, {Results:{List:[…]}}) and shallow enough that it cannot wander
 * into some unrelated nested array.
 */
export function findRows(
  payload: unknown,
  listPath = '',
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
 * name when the mapping supplies one that the payload has, otherwise the first
 * key whose squashed spelling matches a known alias.
 *
 * A configured name that the payload does NOT have falls through to the aliases
 * rather than resolving to nothing — a stale mapping left over from last year's
 * event should degrade to the defaults, not blank the column.
 */
export function resolveFields(
  sample: Record<string, unknown>,
  mapping: Record<string, unknown> = {},
): Record<string, string | null> {
  const keys = Object.keys(sample);
  const out: Record<string, string | null> = {};

  for (const field of Object.keys(ALIASES)) {
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

/* Every penalty and bonus the row carried, under the feed's own column names.
 *
 * Collected by pattern rather than mapped one by one because which of them an
 * event has is an event-by-event decision — the reference feed carries "S2
 * Penalty" and "S3 Penalty" and not the other four — and a fixed list would
 * quietly drop whatever the next event invents. Blank and "0" are both dropped:
 * a zero penalty is the absence of one, and keeping it would put a row of
 * meaningless zeroes on every scorecard.
 */
export function collectPenalties(
  row: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    const k = squash(key);
    if (!k.includes('penalty') && !k.includes('bonus')) continue;
    const text = String(value ?? '').trim();
    if (!text || text === '0') continue;
    out[key] = text;
  }
  return out;
}

export function parseResults(
  payload: unknown,
  mapping: Record<string, unknown> = {},
): ResultsParse {
  const listPath = String(mapping.listPath ?? mapping.list_path ?? '').trim();
  const rows = findRows(payload, listPath);
  if (!rows.length) return { results: [], rejectedCount: 0, sourceColumns: [] };

  const fields = resolveFields(rows[0], mapping);
  const read = (row: Record<string, unknown>, field: Field) =>
    fields[field] ? valueAtPath(row, fields[field]) : undefined;
  const text = (row: Record<string, unknown>, field: Field) =>
    String(read(row, field) ?? '').trim();

  const results: ImportedResult[] = [];
  const seen = new Set<string>();
  let rejectedCount = 0;

  for (const row of rows) {
    // No bib, no row. The bib is how a result finds the athlete it belongs to;
    // a row without one cannot be shown to anybody, so it is counted rather
    // than kept as an anonymous time.
    const bib = normalizeBib(read(row, 'bib'));
    if (!bib) {
      rejectedCount++;
      continue;
    }
    /* THE ENTRY IS THE ROW, and an entry is a bib IN A CONTEST.
     *
     * The same athlete under one bib in two contests — solo and doubles at the
     * same event — is two entries with two times and two placings. Treating the
     * bib alone as the identity threw the second one away as a duplicate, which
     * is a race somebody ran disappearing without a trace.
     *
     * A repeat of the same bib in the SAME contest is still the feed
     * contradicting itself: the first wins and the rest are counted as
     * rejected, because (event_id, bib, category) is unique downstream and
     * letting the last write win would make the stored result depend on the
     * order the rows happened to arrive in.
     */
    const category = text(row, 'category');
    // Normalised exactly as `hyfit_v2.contest_key` and `entryKey` do it —
    // case-folded with internal whitespace collapsed — so that "Male Open" and
    // "MALE  OPEN" are one contest here, in the database, and on the page.
    const key = `${bib}|${category.replace(/\s+/g, ' ').toLowerCase()}`;
    if (seen.has(key)) {
      rejectedCount++;
      continue;
    }
    seen.add(key);

    const totalMs = parseTimeMs(read(row, 'total'));

    results.push({
      bib,
      name: text(row, 'name'),
      category,
      club: text(row, 'club'),
      mobile: text(row, 'mobile'),
      gender: normalizeGender(read(row, 'gender')),
      age: toInt(read(row, 'age')),
      status: normalizeStatus(read(row, 'status'), totalMs),
      rank: toInt(read(row, 'rank')),
      ageGroupRank: toInt(read(row, 'ageGroupRank')),
      totalMs,
      // Dropped at the door for an individual contest — see isTeamCategory.
      // The original value survives in `raw` either way, so nothing is lost,
      // but nothing downstream has to re-decide whether it means anything.
      teamTimeMs: isTeamCategory(category)
        ? parseTimeMs(read(row, 'teamTime'))
        : null,
      cogMs: parseTimeMs(read(row, 'cog')),
      runMs: Array.from({ length: STATION_COUNT }, (_, i) =>
        parseTimeMs(read(row, `run${i + 1}`)),
      ),
      stationMs: Array.from({ length: STATION_COUNT }, (_, i) =>
        parseTimeMs(read(row, `station${i + 1}`)),
      ),
      penalties: collectPenalties(row),
      raw: row,
    });
  }

  return { results, rejectedCount, sourceColumns: Object.keys(rows[0]) };
}
