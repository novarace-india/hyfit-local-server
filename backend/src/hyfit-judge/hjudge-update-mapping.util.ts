// The write-back vocabulary: every RaceResult field the judge and check-in
// apps push, keyed by the name the code knows it as. The value is the field
// name used when an event's "Update field mapping" says nothing — which is
// what every event ran on before the mapping covered these keys, so a blank
// mapping must keep behaving exactly as it did.
//
// Kept free of Nest and pg so the resolution rules can be tested on their own,
// the same way `hjudge-participant-import.util.ts` is for the read direction.

export const updateFieldDefaults = {
  // Check-in (stage 1 wristband, stage 2 transponder)
  stage1checkin: 'stage1checkin',
  stage1checkintime: 'stage1checkintime',
  wristband: 'wristbandID',
  stage2checkin: 'stage2checkin',
  stage2checkintime: 'stage2checkintime',
  transponder1: 'Transponder1',
  // Who handed the equipment over. The counter writes the volunteer's staff ID,
  // which is the only thing left that says who was answerable for a hand-over
  // now that no stage record is kept on our side.
  wristbandassignedby: 'wristbandidAssignedBy',
  transponderassignedby: 'transponderAssignedBy',
  // Judge app — per station, written on every station completion
  station1penalty: 'station1penalty',
  station2penalty: 'station2penalty',
  station3penalty: 'station3penalty',
  station4penalty: 'station4penalty',
  station5penalty: 'station5penalty',
  station6penalty: 'station6penalty',
  // What the judge wrote at a station. Captured on the tablet since the app
  // was written, sent with every race, validated against — and, until now, not
  // written anywhere. Six notes per race went into the void.
  station1note: 'station1note',
  station2note: 'station2note',
  station3note: 'station3note',
  station4note: 'station4note',
  station5note: 'station5note',
  station6note: 'station6note',
  station1ics: 'station1ics',
  station2ics: 'station2ics',
  station3ics: 'station3ics',
  station4ics: 'station4ics',
  station5ics: 'station5ics',
  station6ics: 'station6ics',
  athletenotes: 'athletenotes',
  // Who is judging this athlete right now. Written when a judge claims them and
  // cleared when they are released or finished, so "who has this athlete?" is a
  // question RaceResult answers rather than a lock held in a table here. It is
  // also read back off the participant feed, which is what lets one judge see
  // that another is already running someone.
  // `jugedby` — the spelling as the RaceResult event actually has it, missing
  // its 'd'. Ours is the key on the left and stays correct; this is the value,
  // and a value is RaceResult's to spell. Writing the corrected name here would
  // be writing to a field that does not exist, which `savevalue` accepts with
  // HTTP 200 and then discards.
  judgedby: 'jugedby',
  // Judge app — cognitive recall and the out-of-competition flag an ICS raises
  cognitiveskillpenalty: 'cognitiveskillpenalty',
  cognitiveskillbonus: 'cognitiveskillbonus',
  // The colour sequence itself, not just its score — what was shown to
  // memorise and what the athlete tapped back, ten letters each (e.g.
  // "RGBYRGBYRG"). Lets anyone re-derive or dispute the score from the raw
  // record instead of trusting the penalty/bonus alone.
  cognitivepattershown: 'cognitivepattershown',
  cognitiverecalled: 'cognitiverecalled',
  // Judge app — authoritative timing backups, written as decimal seconds
  cognitivememorisetime: 'cognitivememorisetime',
  run1time: 'run1time',
  station1time: 'station1time',
  run2time: 'run2time',
  station2time: 'station2time',
  run3time: 'run3time',
  station3time: 'station3time',
  run4time: 'run4time',
  station4time: 'station4time',
  run5time: 'run5time',
  station5time: 'station5time',
  run6time: 'run6time',
  station6time: 'station6time',
  cognitiverecalltime: 'cognitiverecalltime',
  tyrefliprecalltime: 'tyrefliprecalltime',
  recalltofinishtime: 'recalltofinishtime',
  totalracetime: 'totalracetime',
  // Judge app — the wall-clock time of day each boundary was tapped.
  //
  // The same taps the durations above are derived from, written as clock times
  // instead of elapsed ones. Nothing new is measured for these: the tablet has
  // always sent every boundary as an absolute instant, and until now only the
  // gaps between them were kept. They are what lets a result be lined up
  // against a timing mat, a video, or another athlete's race.
  starttod: 'starttod',
  run1tod: 'run1tod',
  station1tod: 'station1tod',
  run2tod: 'run2tod',
  station2tod: 'station2tod',
  run3tod: 'run3tod',
  station3tod: 'station3tod',
  run4tod: 'run4tod',
  station4tod: 'station4tod',
  run5tod: 'run5tod',
  station5tod: 'station5tod',
  run6tod: 'run6tod',
  station6tod: 'station6tod',
  cognitiverecalltod: 'cognitiverecalltod',
  finishtod: 'finishtod',
  status: 'Status',
  // The athlete's own status on the race record, set when their race is handed
  // in. Written alongside `status`, and separately from it, because they are
  // two fields on the RaceResult side and an event may use either, both or
  // neither.
  //
  // They do NOT share a vocabulary. `status` is RaceResult's built-in one
  // (0 = Completed, 1 = OOC, …); this is a custom field and a plain yes/no
  // flag, `1` once the race has been handed in. It is the field
  // `buildCheckinRoster` reads to decide whether an athlete has already raced,
  // so writing a status code into it inverts the roster — see `RACE_HANDED_IN`
  // in `services/hjudge-race-submit.service.ts`.
  statusofathelet: 'statusofathelet',
} as const;

export type UpdateFieldKey = keyof typeof updateFieldDefaults;

export const updateFieldKeys = Object.keys(
  updateFieldDefaults,
) as UpdateFieldKey[];

export function isUpdateFieldKey(value: unknown): value is UpdateFieldKey {
  return (
    typeof value === 'string' && (updateFieldKeys as string[]).includes(value)
  );
}

// The six stations are fixed by the race format, so a number outside 1-6 is a
// bug rather than a configuration question — say so here instead of quietly
// writing to a field RaceResult has never heard of.
export function stationUpdateFieldKey(
  stationNumber: number,
  kind: 'penalty' | 'ics' | 'note',
): UpdateFieldKey {
  const key = `station${stationNumber}${kind}`;
  if (!isUpdateFieldKey(key))
    throw new Error(`Station ${stationNumber} has no ${kind} field`);
  return key;
}

function normalizeKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// The field names behind one mapping value: normally a single name, and for an
// event that keeps the same value in two columns, a list of them.
//
// Blank and non-string entries are dropped rather than written to, because a
// `savevalue` to "" is accepted with HTTP 200 like everything else and would be
// indistinguishable from a real write. The same name twice is one write — a
// duplicate would otherwise be an extra RaceResult round trip per athlete for
// no second value.
function fieldNameList(value: unknown): string[] {
  const names: string[] = [];
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (!name) continue;
    if (names.some((seen) => normalizeKey(seen) === normalizeKey(name)))
      continue;
    names.push(name);
  }
  return names;
}

// An organiser types these by hand into a textarea, so `Station1Penalty`,
// `station_1_penalty` and `station1penalty` all have to mean the same key —
// only the value is copied verbatim, because that half is RaceResult's spelling
// and we are in no position to correct it.
//
// Every field this key writes to, in the order they are written.
//
// A value may be a list — `"transponder1": ["Transponder1", "chipused"]` —
// for an event that has to keep one value in two columns because the timing
// side reads a different one from ours. Repeating the key in the JSON does NOT
// do this: `{"transponder1": "a", "transponder1": "b"}` is a single key to any
// JSON parser, the last one silently wins, and the first field then stops being
// written at all. The list is the only way to say it.
//
// The first name is the primary one and the list is not a set: it is the name
// read back off the participant feed, so reordering it changes which column the
// app believes.
export function resolveUpdateFields(
  mapping: unknown,
  key: UpdateFieldKey,
): string[] {
  const fallback = [updateFieldDefaults[key]];
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping))
    return fallback;

  const entries = Object.entries(mapping as Record<string, unknown>);
  const wanted = normalizeKey(key);
  for (const [candidate, value] of entries) {
    if (normalizeKey(candidate) !== wanted) continue;
    const names = fieldNameList(value);
    if (names.length) return names;
  }
  return fallback;
}

/** The primary field for a key: what a read looks at, and what a log names. */
export function resolveUpdateField(
  mapping: unknown,
  key: UpdateFieldKey,
): string {
  return resolveUpdateFields(mapping, key)[0];
}

// Read before a config is saved, so a typo lands as a message on the admin
// screen rather than as a silently ignored key that only shows up as a run of
// rejected write-backs during the race.
export function updateMappingProblems(mapping: unknown): string[] {
  if (mapping == null) return [];
  if (typeof mapping !== 'object' || Array.isArray(mapping))
    return ['it must be a JSON object of our key → RaceResult field name'];

  const problems: string[] = [];
  for (const [key, value] of Object.entries(
    mapping as Record<string, unknown>,
  )) {
    const known = updateFieldKeys.some(
      (candidate) => normalizeKey(candidate) === normalizeKey(key),
    );
    if (!known) {
      problems.push(`"${key}" is not a field this app writes back`);
      continue;
    }
    // A list is reported on entry by entry rather than through `fieldNameList`,
    // which drops what it cannot use: a mapping that reads
    // `["Transponder1", ""]` would resolve perfectly well to one field and the
    // organiser would never learn that their second column is not being
    // written.
    if (Array.isArray(value)) {
      if (!value.length)
        problems.push(`"${key}" needs at least one RaceResult field name`);
      else if (value.some((name) => typeof name !== 'string' || !name.trim()))
        problems.push(
          `"${key}" has a blank entry in its list of RaceResult field names`,
        );
      continue;
    }
    if (typeof value !== 'string' || !value.trim())
      problems.push(
        `"${key}" needs a non-empty RaceResult field name, or a list of them`,
      );
  }
  return problems;
}

// Resolves a field name supplied by a client (the judge app's offline penalty
// queue). Known keys go through the mapping; anything else is passed through
// untouched so an older tablet holding a queued operation still delivers.
export function resolveClientUpdateFields(
  mapping: unknown,
  fieldName: string,
): string[] {
  const match = updateFieldKeys.find(
    (key) => normalizeKey(key) === normalizeKey(fieldName),
  );
  return match ? resolveUpdateFields(mapping, match) : [fieldName];
}

export function resolveClientUpdateField(
  mapping: unknown,
  fieldName: string,
): string {
  return resolveClientUpdateFields(mapping, fieldName)[0];
}
