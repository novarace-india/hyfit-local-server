// Pure helpers for turning a RaceResult participant payload into rows for the
// participants table. Ported from the standalone judge app's
// app/participant-sync.server.ts + lib/participant-import.ts. Kept free of Nest
// and pg so the mapping rules can be reasoned about (and tested) on their own.

export type ParticipantFieldConfig = {
  listPath: string;
  bibField: string;
  nameField: string;
  categoryField: string;
  contestIdField: string;
  waveField: string;
  // When the wave is on the floor. Optional in a way `wave` is not: plenty of
  // start lists carry no slot column at all, and one that does not leaves the
  // roster's timeslot untouched rather than blanking it.
  timeslotField: string;
  // Which DAY that slot is on — RaceResult's ContestDate. Same optionality as
  // timeslotField: a single-day start list has no such column, and its absence
  // must not blank a date already on the roster.
  contestDateField: string;
  genderField: string;
  dateOfBirthField: string;
  clubField: string;
  statusField: string;
  idField: string;
  // A start list usually has no phone number, but a registration export does,
  // and the number is what lets the athlete sign in to the app at all. Read
  // when the payload carries it; empty when it does not.
  mobileField: string;
};

export type ImportedParticipant = {
  id: string;
  bib: string;
  name: string;
  category: string;
  contestId: string;
  wave: string;
  timeslot: string;
  contestDate: string;
  gender: string;
  dateOfBirth: string;
  club: string;
  avatar: string;
  status: 'Ready' | 'On course';
  mobile: string;
};

type SourceRecord = Record<string, unknown>;

export function valueAtPath(value: unknown, path: string): unknown {
  if (!path?.trim()) return value;
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function sourceString(record: SourceRecord, field: string) {
  if (!field?.trim()) return '';
  const value = valueAtPath(record, field);
  return value == null ? '' : String(value).trim();
}

export function normalizeBib(value: unknown) {
  if (value == null) return null;
  const bib = String(value).trim();
  return /^\d+$/.test(bib) ? bib : null;
}

function normalizeStatus(value: unknown): ImportedParticipant['status'] {
  const status = String(value ?? '')
    .trim()
    .toLowerCase();
  return ['on course', 'on_course', 'active', 'assigned', 'racing'].includes(
    status,
  )
    ? 'On course'
    : 'Ready';
}

// Anything that is not a real ISO calendar date becomes '' rather than a
// guess — the column is a date and a wrong DOB is worse than a missing one.
function normalizeDateOfBirth(value: string) {
  if (!value) return '';
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
  if (!iso) return '';
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== iso
    ? ''
    : iso;
}

function participantInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function normalizeParticipants(
  payload: unknown,
  config: ParticipantFieldConfig,
): { participants: ImportedParticipant[]; rejectedCount: number } {
  const source = valueAtPath(payload, config.listPath);
  if (!Array.isArray(source))
    throw new Error('Configured participant list is not an array');

  const candidates: ImportedParticipant[] = [];
  let rejectedCount = 0;

  for (const item of source) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      rejectedCount += 1;
      continue;
    }

    const record = item as SourceRecord;
    const bib = normalizeBib(valueAtPath(record, config.bibField));
    const name = sourceString(record, config.nameField);
    if (!bib || !name) {
      rejectedCount += 1;
      continue;
    }

    candidates.push({
      id: sourceString(record, config.idField) || bib,
      bib,
      name,
      category: sourceString(record, config.categoryField) || 'Unassigned',
      contestId: sourceString(record, config.contestIdField),
      wave: sourceString(record, config.waveField) || 'Wave pending',
      timeslot: sourceString(record, config.timeslotField),
      contestDate: sourceString(record, config.contestDateField),
      gender: sourceString(record, config.genderField),
      dateOfBirth: normalizeDateOfBirth(
        sourceString(record, config.dateOfBirthField),
      ),
      club: sourceString(record, config.clubField),
      avatar: participantInitials(name),
      status: normalizeStatus(valueAtPath(record, config.statusField)),
      // Passed through as written. Whether these digits are a number the app can
      // send an OTP to is decided by `normalizeMobile` on the roster side, which
      // is where the same question is already answered for a CSV.
      mobile: sourceString(record, config.mobileField),
    });
  }

  // A duplicated BIB is rejected outright rather than last-one-wins: the
  // participants table is unique on (event_id, bib) and silently picking one
  // of two athletes sharing a BIB would put the wrong name on a race.
  const bibCounts = new Map<string, number>();
  for (const participant of candidates) {
    bibCounts.set(participant.bib, (bibCounts.get(participant.bib) ?? 0) + 1);
  }

  const participants = candidates.filter((participant) => {
    const unique = bibCounts.get(participant.bib) === 1;
    if (!unique) rejectedCount += 1;
    return unique;
  });

  return { participants, rejectedCount };
}

function mappingValue(
  mapping: Record<string, unknown>,
  keys: string[],
  fallback: string,
) {
  for (const key of keys) {
    const value = mapping[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return fallback;
}

export function participantFieldConfig(
  mapping: Record<string, unknown>,
): ParticipantFieldConfig {
  return {
    listPath: mappingValue(mapping, ['listPath', 'participantListPath'], ''),
    bibField: mappingValue(mapping, ['bibField', 'bib'], 'bib'),
    nameField: mappingValue(mapping, ['nameField', 'name'], 'name'),
    categoryField: mappingValue(
      mapping,
      ['categoryField', 'category'],
      'category',
    ),
    contestIdField: mappingValue(
      mapping,
      ['contestIdField', 'contestId'],
      'ContestID',
    ),
    waveField: mappingValue(mapping, ['waveField', 'wave'], 'wave'),
    timeslotField: mappingValue(
      mapping,
      ['timeslotField', 'timeslot', 'slotField', 'slot'],
      'timeslot',
    ),
    contestDateField: mappingValue(
      mapping,
      ['contestDateField', 'contestDate', 'contestdate', 'dateField', 'date'],
      'ContestDate',
    ),
    genderField: mappingValue(mapping, ['genderField', 'gender'], 'Gender'),
    dateOfBirthField: mappingValue(
      mapping,
      ['dateOfBirthField', 'dateOfBirth'],
      'DateOfBirth',
    ),
    clubField: mappingValue(mapping, ['clubField', 'club'], 'club'),
    statusField: mappingValue(mapping, ['statusField', 'status'], 'status'),
    idField: mappingValue(mapping, ['idField', 'id'], 'id'),
    mobileField: mappingValue(
      mapping,
      ['mobileField', 'mobile', 'phoneField', 'phone'],
      'mobile',
    ),
  };
}

function setValueAtPath(payload: unknown, path: string, value: unknown): unknown {
  if (!path) return value;
  const root =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? structuredClone(payload)
      : {};
  const segments = path.split('.');
  let current = root as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    current[segment] =
      next && typeof next === 'object' && !Array.isArray(next) ? next : {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments.at(-1)!] = value;
  return root;
}

// RaceResult exports vary between deployments, so the configured mapping is
// treated as a hint: where a configured field is absent from the first record,
// fall back to matching a known alias case- and punctuation-insensitively.
// Also handles rosters that carry firstname/lastname instead of a single name.
export function parseParticipantImport(
  payload: unknown,
  mapping: Record<string, unknown>,
) {
  const config = participantFieldConfig(mapping);
  const source = valueAtPath(payload, config.listPath);
  if (
    !Array.isArray(source) ||
    !source.length ||
    !source[0] ||
    typeof source[0] !== 'object'
  ) {
    return normalizeParticipants(payload, config);
  }

  const sample = source[0] as Record<string, unknown>;
  const keys = Object.keys(sample);
  const matchingKey = (configured: string, aliases: string[]) => {
    if (configured && valueAtPath(sample, configured) !== undefined)
      return configured;
    const normalizedAliases = aliases.map((alias) =>
      alias.toLowerCase().replace(/[^a-z0-9]/g, ''),
    );
    return (
      keys.find((key) =>
        normalizedAliases.includes(key.toLowerCase().replace(/[^a-z0-9]/g, '')),
      ) ?? configured
    );
  };

  config.bibField = matchingKey(config.bibField, [
    'bib',
    'bibnumber',
    'startnumber',
  ]);
  config.categoryField = matchingKey(config.categoryField, [
    'category',
    'contest',
    'race',
  ]);
  config.contestIdField = matchingKey(config.contestIdField, [
    'contestid',
    'contest_id',
  ]);
  config.waveField = matchingKey(config.waveField, [
    'wave',
    'startwave',
    'startgroup',
  ]);
  config.timeslotField = matchingKey(config.timeslotField, [
    'timeslot',
    'slot',
    'starttime',
    'startslot',
    'session',
  ]);
  config.contestDateField = matchingKey(config.contestDateField, [
    'contestdate',
    'contest_date',
    'racedate',
    'startdate',
    'eventdate',
  ]);
  config.genderField = matchingKey(config.genderField, ['gender', 'sex']);
  config.dateOfBirthField = matchingKey(config.dateOfBirthField, [
    'dateofbirth',
    'dob',
    'birthdate',
  ]);
  config.clubField = matchingKey(config.clubField, [
    'club',
    'team',
    'teamname',
  ]);
  config.statusField = matchingKey(config.statusField, [
    'status',
    'participantstatus',
  ]);
  config.idField = matchingKey(config.idField, ['participantid', 'id', 'bib']);
  config.mobileField = matchingKey(config.mobileField, [
    'mobile',
    'mobileno',
    'mobilenumber',
    'phone',
    'phoneno',
    'phonenumber',
    'contact',
    'contactno',
    'contactnumber',
    'cell',
    'cellphone',
    'whatsapp',
    'whatsappnumber',
  ]);

  const resolvedName = matchingKey(config.nameField, [
    'name',
    'fullname',
    'participantname',
  ]);
  if (valueAtPath(sample, resolvedName) !== undefined) {
    config.nameField = resolvedName;
    return normalizeParticipants(payload, config);
  }

  const firstNameKey = matchingKey('', ['firstname', 'givenname']);
  const lastNameKey = matchingKey('', ['lastname', 'surname', 'familyname']);
  if (!firstNameKey && !lastNameKey)
    return normalizeParticipants(payload, config);

  const adapted = source.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    const fullName = [record[firstNameKey], record[lastNameKey]]
      .filter((value) => value != null && String(value).trim())
      .map((value) => String(value).trim())
      .join(' ');
    return { ...record, __hyfitFullName: fullName };
  });
  config.nameField = '__hyfitFullName';
  return normalizeParticipants(
    config.listPath ? setValueAtPath(payload, config.listPath, adapted) : adapted,
    config,
  );
}

export type ExistingParticipant = {
  name: string;
  category: string;
  contestId: string;
  wave: string;
  timeslot: string;
  contestDate: string;
  gender: string;
  dateOfBirth: string;
  club: string;
  sourceId: string;
};

// Reports what a sync actually changed, so the admin screen can distinguish a
// no-op re-import from one that rewrote the roster mid-event.
export function classifyParticipantImport(
  existing: Map<string, ExistingParticipant>,
  incoming: ImportedParticipant[],
) {
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const participant of incoming) {
    const current = existing.get(participant.bib);
    if (!current) {
      inserted += 1;
    } else if (
      current.name !== participant.name ||
      current.category !== participant.category ||
      current.contestId !== participant.contestId ||
      current.wave !== participant.wave ||
      current.timeslot !== participant.timeslot ||
      current.contestDate !== participant.contestDate ||
      current.gender !== participant.gender ||
      current.dateOfBirth !== participant.dateOfBirth ||
      current.club !== participant.club ||
      current.sourceId !== participant.id
    ) {
      updated += 1;
    } else {
      unchanged += 1;
    }
  }

  return { inserted, updated, unchanged };
}
