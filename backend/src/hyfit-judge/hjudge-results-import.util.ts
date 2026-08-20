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
  /** The CONTEST — "NextGen Boys", "Male Doubles". What the entry is keyed on
   *  everywhere downstream. Not the age band; that is `ageGroup`. */
  category: string;
  name: string;
  /** The band `ageGroupRank` counts within — "Next Gen Boys 12-15". Empty when
   *  the export names no band narrower than the contest. */
  ageGroup: string;
  club: string;
  mobile: string;
  gender: string;
  age: number | null;
  status: 'REG' | 'FIN' | 'DNF' | 'DNS' | 'DQ';
  rank: number | null;
  ageGroupRank: number | null;
  /** The pair's placing. Null for a solo entry, and for a feed that publishes
   *  no team rank at all. */
  teamRank: number | null;
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
  /** Every OTHER time in the row — HyZone, COGRecall, whatever the next event
   *  adds — under the feed's own column names, unparsed. See
   *  `collectExtraTimes` for why they are published rather than placed. */
  extraTimes: Record<string, string>;
  raw: Record<string, unknown>;
};

export type ResultsParse = {
  results: ImportedResult[];
  /** Rows dropped for having no usable bib. Reported, never silently absorbed:
   *  it is almost always the bib column being mapped to the wrong name, and a
   *  feed that half-parses looks like a race half the field did not run. */
  rejectedCount: number;
  /* WHY each dropped row was dropped, in the file's own order.
   *
   * The count alone tells an operator that seven rows of their export are not
   * on the leaderboard and nothing at all about which seven — and the two
   * reasons need opposite fixes: a row with no usable bib is a hole in the
   * export, while a repeated entry is the export contradicting itself. Capped
   * (see REJECTION_DETAIL_CAP); `rejectedCount` is always the true total. */
  rejections: ResultRejection[];
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
 *
 * `unit: 'ms'` removes the guess, and the caller passes it when the COLUMN says
 * so — a file carrying this platform's own `total_ms` / `st1_ms` columns is not
 * ambiguous, and the heuristic is actively wrong on it: an eleven-second
 * cognitive segment stored as 11000 is under the boundary and would be read as
 * eleven thousand seconds.
 */
export function parseTimeMs(value: unknown, unit?: 'ms'): number | null {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null;
    if (unit === 'ms') return Math.round(value);
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
    return unit === 'ms' || numeric >= 100_000
      ? Math.round(numeric)
      : Math.round(numeric * 1000);

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
 * NO LONGER USED BY THE IMPORTER, and the reason is worth keeping: the import
 * used to gate `TeamRank`/`TeamTime` on this, so a pairs wave run inside a
 * contest called "Male Open" had its team results silently dropped. The feed
 * states per row whether an entry raced as a pair; a regex over a name only
 * guesses. Kept because it is still a fair answer to "does this NAME describe a
 * team contest?" — for a UI label or a setup hint — but it must never again
 * decide whether stored data is real.
 */
const TEAM_CONTEST = /\b(doubles?|pairs?|relay|teams?|duos?|trios?|squad)\b/i;

export function isTeamCategory(category: string | null | undefined): boolean {
  return TEAM_CONTEST.test(String(category ?? ''));
}

/** Are these two strings naming the same contest? The same normalisation
 *  `hyfit_v2.contest_key` and `entryKey` use — so "Male Doubles" and
 *  "male  doubles" are one name here, in the database and on the page. */
function sameContest(a: string, b: string) {
  const key = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  return key(a) === key(b);
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
 * aliases below cover the three shapes seen in the wild: HYFIT's own export
 * ("Run1", "ST1", "ST0COG"), the longer names the judge app writes back
 * ("run1time", "station1time"), and this platform's own column names
 * ("total_ms", "run1_ms", "st1_ms") — which is what an operator uploading a
 * file exported from a venue's own database is holding. Times under the last
 * spelling are read as milliseconds outright; see `parseTimeMs`.
 */
const ALIASES: Record<string, string[]> = {
  bib: ['bib', 'bibnumber', 'startnumber', 'startno', 'no'],
  name: ['name', 'fullname', 'participant', 'athlete', 'displayname'],
  /* THE CONTEST — the race an entry is IN, and the thing every downstream key
     is built on (`contest_key`, the entry key, whether a club counts as a team).
     `contest` leads the list because the 2026 export carries BOTH columns with
     different meanings:

         "Contest":  "NextGen Boys"          ← this
         "Category": "Next Gen Boys 12-15"   ← the age band, see ageGroup

     and the older export carries only `Category`, meaning the contest. Alias
     ORDER decides, not the order the columns happen to appear in the file —
     which is what used to decide it, and would have keyed an entire event on
     its age bands if a future export listed Category first. */
  category: ['contest', 'category', 'race', 'class', 'division'],
  /* The band `ageGroupRank` counts within. Only ever read from a column the
     contest did not already take (see resolveFields), so the older export —
     where `Category` IS the contest — leaves this null rather than repeating
     the contest name back as an age group. */
  ageGroup: ['agegroup', 'agecategory', 'ageclass', 'agedivision', 'category'],
  club: ['club', 'team', 'teamname', 'clubname'],
  mobile: ['phone', 'mobile', 'contact', 'phonenumber', 'mobilenumber'],
  gender: ['gender', 'sex', 'mf'],
  age: ['age'],
  status: ['status', 'racestatus', 'state', 'finishstatus'],
  rank: ['rank', 'place', 'position', 'pos', 'overallrank'],
  ageGroupRank: ['agegrouprank', 'agrank', 'agegroupplace', 'categoryrank'],
  /* The pair's placing. Zero in the feed means "not in a team" — the same rows
     that write "00:00" for TeamTime — and `toInt` drops it to null, so a solo
     entry cannot be given rank 0 and sorted ahead of the winner. */
  teamRank: ['teamrank', 'teamplace', 'teamposition', 'team_rank'],
  total: [
    'total',
    'totaltime',
    'time',
    'finishtime',
    'nettime',
    'chiptime',
    'totalracetime',
    'total_ms',
  ],
  teamTime: ['teamtime', 'teamtotal', 'teamtotaltime', 'team_time_ms'],
  cog: ['st0cog', 'cog', 'cognitive', 'cognitivememorisetime', 'st0', 'cog_ms'],
};

for (let i = 1; i <= STATION_COUNT; i++) {
  ALIASES[`run${i}`] = [`run${i}`, `run${i}time`, `r${i}`, `run${i}_ms`];
  ALIASES[`station${i}`] = [
    `st${i}`,
    `station${i}`,
    `station${i}time`,
    `s${i}`,
    `st${i}_ms`,
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
 * name when the mapping supplies one that the payload has, otherwise the key
 * matching the EARLIEST alias this field lists.
 *
 * Alias order, not payload order. The two differ only when one payload has
 * columns for two of a field's aliases — "Contest" and "Category" in the same
 * export — and there the alias list is a decision somebody made, while the
 * column order is whatever RaceResult happened to emit. Reading it the other
 * way round put an entire event's entries under their age bands the first time
 * an export listed Category first.
 *
 * A configured name that the payload does NOT have falls through to the aliases
 * rather than resolving to nothing — a stale mapping left over from last year's
 * event should degrade to the defaults, not blank the column.
 *
 * NO COLUMN IS CLAIMED TWICE. `category` and `ageGroup` both list `category`,
 * because in the older export that column IS the contest and in the newer one
 * it is the band beneath it. Resolving in declaration order and skipping keys
 * already taken is what tells those two exports apart with no per-event
 * configuration: whichever field gets `Contest` frees `Category` for the other,
 * and an export with only `Category` gives it to the contest and leaves the age
 * group unset — which is the truth about that file.
 */
export function resolveFields(
  sample: Record<string, unknown>,
  mapping: Record<string, unknown> = {},
): Record<string, string | null> {
  const keys = Object.keys(sample);
  const out: Record<string, string | null> = {};
  const claimed = new Set<string>();

  for (const field of Object.keys(ALIASES)) {
    const configured = String(
      mapping[`${field}Field`] ?? mapping[field] ?? '',
    ).trim();
    if (configured && valueAtPath(sample, configured) !== undefined) {
      out[field] = configured;
      claimed.add(configured);
      continue;
    }
    let found: string | null = null;
    for (const alias of ALIASES[field]) {
      found =
        keys.find((k) => !claimed.has(k) && squash(k) === squash(alias)) ??
        null;
      if (found) break;
    }
    out[field] = found;
    if (found) claimed.add(found);
  }
  return out;
}

/* Every penalty and bonus the row carried, under the feed's own column names.
 *
 * Collected by pattern rather than mapped one by one because which of them an
 * event has is an event-by-event decision — the reference feed carries "COG
 * Penalty", "COG Bonus", "S2 Penalty" and "S3 Penalty" and not the other
 * stations' — and a fixed list would quietly drop whatever the next event
 * invents.
 *
 * A ZERO IS KEPT. It used to be dropped here, on the reasoning that a penalty of
 * nought is the absence of a penalty — which is true of what to SHOW an athlete
 * and false of what to STORE. The two are not the same decision, and collapsing
 * them cost the console the ability to answer the only question an operator
 * actually asks of this column: was S3 judged clean, or was S3 never judged? A
 * dropped zero and a missing column are indistinguishable once they are both
 * absent from the map, and on a feed where "S2 Penalty": "0" appears on every
 * row and "S4 Penalty" appears on none, that difference is the whole import.
 *
 * So everything the column carried is stored, and the athlete-facing scorecard
 * filters to the non-zero ones at render time (see split-timeline.tsx) — where
 * a zero really is nothing worth a chip. Blank is still dropped: a column the
 * export left empty made no statement at all.
 */
export function collectPenalties(
  row: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    const k = squash(key);
    if (!k.includes('penalty') && !k.includes('bonus')) continue;
    const text = String(value ?? '').trim();
    if (!text) continue;
    out[key] = text;
  }
  return out;
}

/** Is this penalty/bonus value one worth showing an athlete? The counterpart to
 *  the rule above: everything is stored, and "0", "0.0", "00:00" are the ways
 *  this feed writes "nothing happened here". */
export function isScoredPenalty(value: string): boolean {
  const text = String(value ?? '').trim();
  if (!text) return false;
  return /[1-9]/.test(text);
}

/* Every OTHER time in the row, under the feed's own column names.
 *
 * The circuit has thirteen typed columns and a HYFIT export has more than
 * thirteen times in it: the 2026 one adds `HyZone` ("2:46" on every row) and
 * `COGRecall`, and the next event will add something else. Those are dropped by
 * the mapping — no alias claims them — and until this existed the only sign of
 * them was that the legs did not add up to the total: bib 1105's thirteen legs
 * come to 7:21 against a total of 11:35.
 *
 * Collected by SHAPE, exactly as `collectPenalties` collects by name: a value
 * is an extra time if it reads as a clock. The colon is required — `Age: 14`
 * and `TeamRank: 1` are numbers this must not turn into times, and a bare
 * number is the one form of a time that cannot be told from them.
 *
 * Nothing is claimed about what they MEAN. HyZone is not additive (bib 2007's
 * legs plus its HyZone exceed its total), so guessing it into the circuit would
 * put a wrong number in a scorecard; it is published beside the circuit under
 * the name the organiser gave it, which is a fact.
 */
export function collectExtraTimes(
  row: Record<string, unknown>,
  claimed: Iterable<string> = [],
): Record<string, string> {
  const taken = new Set([...claimed].map(squash));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    const k = squash(key);
    if (taken.has(k)) continue;
    // Penalties and bonuses have their own home, and a penalty expressed as a
    // duration ("00:30") would otherwise be published twice.
    if (k.includes('penalty') || k.includes('bonus')) continue;
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (!/^\d{1,2}(:\d{1,2}){1,2}([.,]\d{1,3})?$/.test(text)) continue;
    // A zero is the absence of a time here as everywhere else in this feed.
    if (parseTimeMs(text) === null) continue;
    out[key] = text;
  }
  return out;
}

/** One row the parser refused, described well enough to find it in the file. */
export type ResultRejection = {
  /** 1-based position in the row list, which is what a text editor shows. */
  row: number;
  /** The bib exactly as the column held it — blank, "DNS", a name, whatever. */
  bib: string;
  name: string;
  category: string;
  reason: ResultRejectionReason;
};

export type ResultRejectionReason =
  /** No usable bib, so the row cannot find the athlete it belongs to. */
  | 'no-bib'
  /** The same bib in the same contest as an earlier row: the first one won. */
  | 'duplicate-entry'
  /* Two rows that are different entries by bib but the SAME entry by athlete —
     one person, one contest, two bib numbers, or two rows with no phone and the
     same name. Raised by the importer rather than the parser, which cannot see
     the athlete key. */
  | 'same-athlete-twice';

/* How many rejected rows are described rather than only counted.
 *
 * A file with a broken bib column rejects every row in it, and a list of nine
 * thousand of those is neither readable nor worth carrying through an API and
 * into a Valkey payload. Two hundred is far past the point where the pattern is
 * obvious and small enough to keep the response a response. */
export const REJECTION_DETAIL_CAP = 200;

export function parseResults(
  payload: unknown,
  mapping: Record<string, unknown> = {},
): ResultsParse {
  const listPath = String(mapping.listPath ?? mapping.list_path ?? '').trim();
  const rows = findRows(payload, listPath);
  if (!rows.length)
    return { results: [], rejectedCount: 0, rejections: [], sourceColumns: [] };

  const fields = resolveFields(rows[0], mapping);
  const read = (row: Record<string, unknown>, field: Field) =>
    fields[field] ? valueAtPath(row, fields[field]) : undefined;
  const text = (row: Record<string, unknown>, field: Field) =>
    String(read(row, field) ?? '').trim();
  /* A time, in whatever unit its own column declares. A column whose name ends
     in "ms" — this platform's `total_ms`, `st1_ms`, the shape of a file dumped
     from a venue's own database — is milliseconds and is read as such; anything
     else goes through the magnitude heuristic, which is wrong on small
     millisecond counts (see parseTimeMs). Decided once per field, off the header,
     never per row: a column cannot change units halfway down. */
  const unitOf = (field: Field): 'ms' | undefined =>
    fields[field] && squash(fields[field]!).endsWith('ms') ? 'ms' : undefined;
  const time = (row: Record<string, unknown>, field: Field) =>
    parseTimeMs(read(row, field), unitOf(field));

  const results: ImportedResult[] = [];
  const seen = new Set<string>();
  let rejectedCount = 0;
  const rejections: ResultRejection[] = [];

  // Described up to the cap, counted always. `index` is the row's place in the
  // file, 1-based, because that is the number an operator can go and look at.
  const reject = (
    index: number,
    reason: ResultRejectionReason,
    row: Record<string, unknown>,
  ) => {
    rejectedCount++;
    if (rejections.length >= REJECTION_DETAIL_CAP) return;
    rejections.push({
      row: index + 1,
      // The raw value, not the normalised one: what makes this row unusable is
      // usually WHAT is in the bib column ("DNS", "1105a", a blank), and the
      // normalised form has already thrown that away.
      bib: String(read(row, 'bib') ?? '').trim(),
      name: text(row, 'name'),
      category: text(row, 'category'),
      reason,
    });
  };

  for (const [index, row] of rows.entries()) {
    // No bib, no row. The bib is how a result finds the athlete it belongs to;
    // a row without one cannot be shown to anybody, so it is counted rather
    // than kept as an anonymous time.
    const bib = normalizeBib(read(row, 'bib'));
    if (!bib) {
      reject(index, 'no-bib', row);
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
      reject(index, 'duplicate-entry', row);
      continue;
    }
    seen.add(key);

    const totalMs = time(row, 'total');

    results.push({
      bib,
      name: text(row, 'name'),
      category,
      // Never the contest repeated back: an export whose only contest column is
      // called "Category" leaves this empty (see resolveFields), and one that
      // spells the band identically to the contest is saying the contest IS the
      // band, which is not an age group worth printing next to a placing.
      ageGroup: sameContest(text(row, 'ageGroup'), category)
        ? ''
        : text(row, 'ageGroup'),
      club: text(row, 'club'),
      mobile: text(row, 'mobile'),
      gender: normalizeGender(read(row, 'gender')),
      age: toInt(read(row, 'age')),
      status: normalizeStatus(read(row, 'status'), totalMs),
      rank: toInt(read(row, 'rank')),
      ageGroupRank: toInt(read(row, 'ageGroupRank')),
      /* THE FEED DECIDES WHETHER THERE IS A TEAM, NOT THE CONTEST'S NAME.
       *
       * These two used to be gated on `isTeamCategory(category)` — a regex for
       * the words doubles/pairs/relay/team/duo/trio/squad in the contest name —
       * on the reasoning that nothing in the feed says a contest is a team
       * event. That reasoning was wrong: `TeamRank` and `TeamTime` say it, per
       * row, which is more precise than a name ever is. The gate cost real
       * results — 24 rows at HYFIT Bengaluru, in contests called "Male Open"
       * and "Female Open", arrived with TeamRank 1-4 and team times like
       * "19:08" and were stored as NULL because neither name contains one of
       * those words. An organiser who runs a pairs wave inside an open contest
       * had no way to make it show.
       *
       * What is stored is what was sent. The only value not carried across is
       * the feed's own "not applicable" sentinel — `0` and `"00:00"`, which
       * RaceResult writes on EVERY solo row (1 034 of 1 647 here). Those become
       * NULL, because NULL is how this database spells "no team", and storing a
       * literal 0 would put "#0" on the card, the admin table and the printed
       * certificate. See `toInt` and `parseTimeMs`.
       */
      teamRank: toInt(read(row, 'teamRank')),
      totalMs,
      teamTimeMs: time(row, 'teamTime'),
      cogMs: time(row, 'cog'),
      runMs: Array.from({ length: STATION_COUNT }, (_, i) =>
        time(row, `run${i + 1}`),
      ),
      stationMs: Array.from({ length: STATION_COUNT }, (_, i) =>
        time(row, `station${i + 1}`),
      ),
      penalties: collectPenalties(row),
      // Everything the thirteen typed columns did not take. `fields` is what
      // the mapping claimed, so a feed whose total lives under an unusual name
      // does not have it published twice.
      extraTimes: collectExtraTimes(
        row,
        Object.values(fields).filter((k): k is string => Boolean(k)),
      ),
      raw: row,
    });
  }

  return {
    results,
    rejectedCount,
    rejections,
    sourceColumns: Object.keys(rows[0]),
  };
}
