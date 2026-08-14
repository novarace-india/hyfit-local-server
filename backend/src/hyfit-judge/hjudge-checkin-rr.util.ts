/**
 * Reading check-in state back out of RaceResult.
 *
 * Check-in keeps no copy of who has been checked in, and it no longer keeps a
 * copy of which desk a volunteer is standing at either. Two endpoints answer
 * everything, and they answer different questions:
 *
 *   - the **mapping table** (`buildAssignmentTable`, below) is the authority on
 *     equipment. What this athlete already holds decides the stage they are due;
 *     who else holds a scanned code decides whether it can be handed over at all.
 *   - the **participant feed** is the authority on identity, and carries the
 *     stamps a hand-over left behind — `stage1checkintime`, the issuing staff ID.
 *     Those are shown on the receipt; they do not decide anything.
 *
 * Keeping the decision on one side of that line is the point. Equipment is the
 * thing that was physically handed to a person, and a status flag set without a
 * band against it describes a check-in that did not happen.
 *
 * The identity half of a record (name, contest, slot, club) is NOT parsed here:
 * `parseParticipantImport` already does it, alias-matching included, and the
 * counter must read a start list exactly the way the importer does or the two
 * would disagree about the same feed. This file adds only the part the importer
 * has no reason to know about — the check-in fields the app itself writes.
 *
 * Kept free of Nest and pg, like its two neighbours, so the rules can be tested
 * on their own.
 */

import {
  parseParticipantImport,
  valueAtPath,
  type ImportedParticipant,
} from './hjudge-participant-import.util';
import {
  resolveUpdateField,
  resolveUpdateFields,
  type UpdateFieldKey,
} from './hjudge-update-mapping.util';

export type CheckinStageType = 'STAGE_1_WRISTBAND' | 'STAGE_2_TRANSPONDER';

export const CHECKIN_STAGES: CheckinStageType[] = [
  'STAGE_1_WRISTBAND',
  'STAGE_2_TRANSPONDER',
];

export function isCheckinStage(value: unknown): value is CheckinStageType {
  return (
    typeof value === 'string' &&
    (CHECKIN_STAGES as string[]).includes(value)
  );
}

/** The RaceResult field names this event uses for the check-in values. */
export interface CheckinFieldNames {
  judgedBy: string;
  /** The athlete's completion flag, READ from the participant feed. */
  statusOfAthlete: string;
  stage1Status: string;
  stage1Time: string;
  wristband: string;
  wristbandAssignedBy: string;
  stage2Status: string;
  stage2Time: string;
  transponder: string;
  transponderAssignedBy: string;
}

export function checkinFieldNames(mapping: unknown): CheckinFieldNames {
  return {
    judgedBy: resolveUpdateField(mapping, 'judgedby'),
    statusOfAthlete: resolveUpdateField(mapping, 'statusofathelet'),
    stage1Status: resolveUpdateField(mapping, 'stage1checkin'),
    stage1Time: resolveUpdateField(mapping, 'stage1checkintime'),
    wristband: resolveUpdateField(mapping, 'wristband'),
    wristbandAssignedBy: resolveUpdateField(mapping, 'wristbandassignedby'),
    stage2Status: resolveUpdateField(mapping, 'stage2checkin'),
    stage2Time: resolveUpdateField(mapping, 'stage2checkintime'),
    transponder: resolveUpdateField(mapping, 'transponder1'),
    transponderAssignedBy: resolveUpdateField(mapping, 'transponderassignedby'),
  };
}

/** The keys a stage writes, which is also the order it writes them in. */
const STAGE_KEYS = {
  STAGE_1_WRISTBAND: {
    status: 'stage1checkin',
    time: 'stage1checkintime',
    asset: 'wristband',
    assignedBy: 'wristbandassignedby',
  },
  STAGE_2_TRANSPONDER: {
    status: 'stage2checkin',
    time: 'stage2checkintime',
    asset: 'transponder1',
    assignedBy: 'transponderassignedby',
  },
} as const satisfies Record<CheckinStageType, Record<string, UpdateFieldKey>>;

/**
 * Every field name a stage writes, as lists.
 *
 * The read side is `stageFields`, which takes the primary name only — an event
 * that mirrors its transponder into a second column still has one column the
 * app treats as the truth. This is its write-side twin: a hand-over has to
 * reach all of them, or the mirror is a column that quietly stops agreeing.
 */
export function stageWriteTargets(
  mapping: unknown,
  stage: CheckinStageType,
): { status: string[]; time: string[]; asset: string[]; assignedBy: string[] } {
  const keys = STAGE_KEYS[stage];
  return {
    status: resolveUpdateFields(mapping, keys.status),
    time: resolveUpdateFields(mapping, keys.time),
    asset: resolveUpdateFields(mapping, keys.asset),
    assignedBy: resolveUpdateFields(mapping, keys.assignedBy),
  };
}

/** The asset field a stage hands over, plus the status, time and issuer it stamps. */
export function stageFields(
  fields: CheckinFieldNames,
  stage: CheckinStageType,
): { status: string; time: string; asset: string; assignedBy: string } {
  return stage === 'STAGE_1_WRISTBAND'
    ? {
        status: fields.stage1Status,
        time: fields.stage1Time,
        asset: fields.wristband,
        assignedBy: fields.wristbandAssignedBy,
      }
    : {
        status: fields.stage2Status,
        time: fields.stage2Time,
        asset: fields.transponder,
        assignedBy: fields.transponderAssignedBy,
      };
}

function normalizeKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * A field's value on one RaceResult record.
 *
 * Exact key first, then a normalised match, because the two halves of the same
 * field name are chosen by different people: the mapping says `wristbandID`
 * (what savevalue is told to write) while the feed answers with `wristbandid`
 * (what the Custom API's column list happens to be called). Requiring those to
 * agree letter-for-letter would make every check-in look outstanding.
 */
/** The raw value of a field, matched the same forgiving way. Undefined when the
 *  record has no such key at all — which is different from having a blank one. */
export function rawRecordValue(record: unknown, fieldName: string): unknown {
  if (!record || typeof record !== 'object' || !fieldName?.trim()) return undefined;
  const direct = valueAtPath(record, fieldName);
  if (direct !== undefined) return direct;

  const wanted = normalizeKey(fieldName);
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (normalizeKey(key) === wanted) return value;
  }
  return undefined;
}

export function readRecordField(record: unknown, fieldName: string): string {
  const value = rawRecordValue(record, fieldName);
  return value == null ? '' : String(value).trim();
}

/**
 * A yes/no field, read as one.
 *
 * `stage1checkin` comes back as a JSON **boolean** — `false` for an athlete who
 * has not been through. Read as text that is the five-character string
 * `"false"`, which is perfectly truthy, and every athlete on the start list
 * reads as already checked in: the counter refuses everybody and the event
 * cannot open. So booleans are honoured as booleans, and the textual forms
 * RaceResult might return instead are matched explicitly rather than by
 * emptiness.
 */
export function readRecordFlag(record: unknown, fieldName: string): boolean {
  const value = rawRecordValue(record, fieldName);
  if (value == null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (!text) return false;
  // Anything explicitly negative is negative; everything else that is present
  // and non-empty counts as set, which keeps a value the organiser typed by
  // hand ("done", "COMPLETED") working.
  return !['false', '0', 'no', 'n', 'off', 'null', 'undefined'].includes(text);
}

function hasKey(record: unknown, fieldName: string): boolean {
  return rawRecordValue(record, fieldName) !== undefined;
}

/** Comparison key for a BIB: leading zeros are presentation, not identity. */
export function bibKey(value: unknown): string {
  const bib = String(value ?? '').trim();
  return bib.replace(/^0+/, '') || bib;
}

/** Comparison key for a wristband or transponder code. Case and leading zeros
 *  both vary between what is printed on the band and what is typed at a desk. */
export function assetKey(value: unknown): string {
  const code = String(value ?? '')
    .trim()
    .toLowerCase();
  return code.replace(/^0+/, '') || code;
}

export interface CheckinStageState {
  state: 'completed';
  /** As RaceResult holds it — already the event's local clock, so it is shown
   *  verbatim rather than being re-interpreted through a browser timezone. */
  completedAt: string;
  assetCode: string;
}

export type CheckinPerson = ImportedParticipant & {
  wristbandCode: string;
  transponderCode: string;
  /** The staff ID of the judge currently holding this athlete, or blank. */
  judgedBy: string;
  /**
   * Whether this athlete's race is already done.
   *
   * Read from `statusofathelet` on the participant feed: 1 means completed, and
   * a completed athlete cannot be judged again. It is the only thing standing
   * between a finished race and somebody re-running it — nothing else on the
   * record says the athlete is done.
   */
  completed: boolean;
};

export interface CheckinRosterEntry {
  person: CheckinPerson;
  stages: Partial<Record<CheckinStageType, CheckinStageState>>;
}

/**
 * Whether a stage has been completed, according to the feed.
 *
 * When the feed publishes the status field, that field is the answer and
 * nothing else is consulted — an organiser who clears `stage1checkin` to undo a
 * check-in means it, and a wristband still sitting in the row must not override
 * them.
 *
 * Only a feed that does NOT publish the status falls back, and then only for
 * Stage 1, to "a wristband is recorded" — a band against a bib gets there one
 * way. Stage 2 never falls back: `Transponder1` is pre-populated by the
 * organiser for the whole field before the event opens, so reading it as
 * evidence of a hand-over would mark every athlete checked in.
 */
function stageState(
  record: unknown,
  fields: CheckinFieldNames,
  stage: CheckinStageType,
  publishesStatus: boolean,
): CheckinStageState | null {
  const { status, time, asset } = stageFields(fields, stage);
  const assetValue = readRecordField(record, asset);

  const done = publishesStatus
    ? readRecordFlag(record, status)
    : stage === 'STAGE_1_WRISTBAND' && Boolean(assetValue);
  if (!done) return null;

  return {
    state: 'completed',
    completedAt: readRecordField(record, time),
    assetCode: assetValue,
  };
}

export interface CheckinRoster {
  entries: CheckinRosterEntry[];
  byBib: Map<string, CheckinRosterEntry>;
  rejectedCount: number;
  /**
   * Whether the feed publishes the stage status fields at all. When it does
   * not, Stage 2 has no completion signal and a transponder can be handed over
   * twice without the counter noticing — which is a RaceResult configuration
   * gap the admin screen should say out loud rather than a bug to work around.
   */
  publishesStageStatus: boolean;
}

/** Turns a RaceResult participant payload into the counter's view of it. */
export function buildCheckinRoster(
  payload: unknown,
  participantMapping: unknown,
  updateMapping: unknown,
): CheckinRoster {
  const fields = checkinFieldNames(updateMapping);
  const mapping =
    participantMapping && typeof participantMapping === 'object'
      ? (participantMapping as Record<string, unknown>)
      : {};

  const { participants, rejectedCount } = parseParticipantImport(
    payload,
    mapping,
  );

  // The raw records, keyed the same way, so the check-in fields can be read off
  // the record `parseParticipantImport` derived each participant from.
  const source = valueAtPath(
    payload,
    typeof mapping.listPath === 'string' ? mapping.listPath : '',
  );
  const rawByBib = new Map<string, unknown>();
  if (Array.isArray(source)) {
    for (const item of source) {
      if (!item || typeof item !== 'object') continue;
      for (const key of Object.keys(item as Record<string, unknown>)) {
        if (!/^(bib|bibnumber|startnumber)$/.test(normalizeKey(key))) continue;
        const key_ = bibKey((item as Record<string, unknown>)[key]);
        if (key_) rawByBib.set(key_, item);
        break;
      }
    }
  }

  const first = Array.isArray(source) ? source[0] : null;
  const publishesStageStatus =
    hasKey(first, fields.stage1Status) || hasKey(first, fields.stage2Status);

  const entries: CheckinRosterEntry[] = participants.map(
    (participant: ImportedParticipant) => {
      const record = rawByBib.get(bibKey(participant.bib)) ?? {};
      const stages: Partial<Record<CheckinStageType, CheckinStageState>> = {};
      for (const stage of CHECKIN_STAGES) {
        const state = stageState(record, fields, stage, publishesStageStatus);
        if (state) stages[stage] = state;
      }
      return {
        person: {
          ...participant,
          wristbandCode: readRecordField(record, fields.wristband),
          transponderCode: readRecordField(record, fields.transponder),
          judgedBy: readRecordField(record, fields.judgedBy),
          completed: readRecordFlag(record, fields.statusOfAthlete),
        },
        stages,
      };
    },
  );

  const byBib = new Map<string, CheckinRosterEntry>();
  for (const entry of entries) byBib.set(bibKey(entry.person.bib), entry);

  return { entries, byBib, rejectedCount, publishesStageStatus };
}

/** The BIB column of a mapping-table row, by whichever of its usual names the
 *  table happens to use — alias-matched the way the roster importer does it. */
function bibOfRow(row: Record<string, unknown>): string {
  for (const key of Object.keys(row)) {
    if (!/^(bib|bibnumber|startnumber)$/.test(normalizeKey(key))) continue;
    return String(row[key] ?? '').trim();
  }
  return '';
}

/** The rows of a table that may or may not arrive wrapped in an envelope. */
function tableRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const key of ['participants', 'data', 'list', 'rows']) {
      const value = (payload as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

/** What equipment one BIB holds, according to the mapping table. */
export interface AssetAssignment {
  bib: string;
  wristband: string;
  transponder: string;
}

/**
 * The equipment assignment table, read from the map endpoint.
 *
 * This is the counter's authority on who holds which wristband and which
 * transponder. Both directions matter and they answer different questions:
 * `byBib` says what an athlete has already been issued, which is what decides
 * the stage they are due; `byWristband` / `byTransponder` say who a scanned
 * code belongs to, which is what catches a code about to be handed out twice.
 *
 * `publishesWristband` / `publishesTransponder` are how the table admits it
 * does not carry a column. A missing column is indistinguishable from an empty
 * one row-by-row, and reading "absent" as "unassigned" would let a counter
 * issue the same transponder to the whole field without one complaint. So the
 * gap is reported and the counter refuses, rather than guessed at.
 */
export interface AssignmentTable {
  byBib: Map<string, AssetAssignment>;
  byWristband: Map<string, AssetAssignment>;
  byTransponder: Map<string, AssetAssignment>;
  publishesWristband: boolean;
  publishesTransponder: boolean;
  rowCount: number;
}

/**
 * Reads the mapping table.
 *
 * A different kind of thing from the participant feed: fetched WHOLE, with no
 * query parameter, and searched here. That is not an optimisation we declined
 * to make — the endpoint does not filter, so asking it for `?bib=` returns the
 * same full table and the caller still has to find the row.
 *
 * The asset columns are the event's own `wristbandID` / `Transponder1` names
 * from the update mapping, so a table that spells either differently is read
 * correctly without extra configuration — and it is read with exactly the names
 * the counter writes back through, which is what keeps the two halves of a
 * hand-over talking about the same column.
 */
export function buildAssignmentTable(
  payload: unknown,
  updateMapping: unknown,
): AssignmentTable {
  const fields = checkinFieldNames(updateMapping);
  const rows = tableRows(payload).filter(
    (row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object',
  );

  const byBib = new Map<string, AssetAssignment>();
  const byWristband = new Map<string, AssetAssignment>();
  const byTransponder = new Map<string, AssetAssignment>();

  for (const row of rows) {
    const bib = bibOfRow(row);
    if (!bib) continue;

    const assignment: AssetAssignment = {
      bib,
      wristband: readRecordField(row, fields.wristband),
      transponder: readRecordField(row, fields.transponder),
    };

    // First wins, throughout. A bib or a code appearing twice is a table with a
    // duplicate in it, and taking the later row would silently prefer whichever
    // the endpoint happened to return last.
    const bibIndex = bibKey(bib);
    if (!byBib.has(bibIndex)) byBib.set(bibIndex, assignment);

    const band = assetKey(assignment.wristband);
    if (band && !byWristband.has(band)) byWristband.set(band, assignment);

    const chip = assetKey(assignment.transponder);
    if (chip && !byTransponder.has(chip)) byTransponder.set(chip, assignment);
  }

  // Asked of the first row, the same way the participant feed is asked whether
  // it publishes the stage flags: the column list is the table's, not the row's.
  const first = rows[0] ?? null;
  return {
    byBib,
    byWristband,
    byTransponder,
    publishesWristband: hasKey(first, fields.wristband),
    publishesTransponder: hasKey(first, fields.transponder),
    rowCount: rows.length,
  };
}

/** What the table holds for one BIB — blank rather than absent, so a caller
 *  reading "no wristband yet" does not have to tell the two cases apart. */
export function assignmentFor(
  table: AssignmentTable,
  bib: string,
): AssetAssignment {
  return (
    table.byBib.get(bibKey(bib)) ?? { bib, wristband: '', transponder: '' }
  );
}

/** Whoever already holds this code, if anyone. */
export function holderOfAsset(
  table: AssignmentTable,
  code: string,
  stage: CheckinStageType,
): AssetAssignment | null {
  const wanted = assetKey(code);
  if (!wanted) return null;
  const index =
    stage === 'STAGE_1_WRISTBAND' ? table.byWristband : table.byTransponder;
  return index.get(wanted) ?? null;
}

/**
 * Whoever holds this code as EITHER kind of equipment.
 *
 * For identifying an athlete from whatever they are carrying. Someone arriving
 * at the counter has a wristband, or a transponder, or both, and which one they
 * hand over is not something the desk gets to decide — so the code is looked up
 * in both columns of the mapping table rather than in the one the caller
 * guessed at.
 *
 * The wristband wins a code that is somehow in both columns, matching the judge
 * app: it is the identifier every other path is keyed on.
 */
export function holderOfAnyAsset(
  table: AssignmentTable,
  code: string,
): { assignment: AssetAssignment; matched: 'wristband' | 'transponder' } | null {
  const wanted = assetKey(code);
  if (!wanted) return null;

  const band = table.byWristband.get(wanted);
  if (band) return { assignment: band, matched: 'wristband' };

  const chip = table.byTransponder.get(wanted);
  return chip ? { assignment: chip, matched: 'transponder' } : null;
}

/**
 * The stage this athlete is due, from what they have already been issued.
 *
 * There is no such thing as a Stage 1 counter or a Stage 2 counter any more —
 * one desk runs whichever stage the athlete in front of it has not had. A band
 * but no transponder means Stage 2; neither means Stage 1; both means they are
 * finished and the counter says so instead of handing out a second one.
 *
 * Read from the mapping table rather than the participant feed's `stage1checkin`
 * flags, because the equipment is the thing that was physically handed over —
 * a flag set without a band against it describes a check-in that did not happen.
 */
export function nextStageFor(
  assignment: AssetAssignment,
): CheckinStageType | null {
  if (!assignment.wristband.trim()) return 'STAGE_1_WRISTBAND';
  if (!assignment.transponder.trim()) return 'STAGE_2_TRANSPONDER';
  return null;
}

const doublesContests: Record<string, string> = {
  '9': 'Bloodline Doubles',
  '10': 'Male Doubles',
  '11': 'Female Doubles',
  '12': 'Mixed Doubles',
};

export function isDoublesContestId(contestId: unknown): boolean {
  return (
    typeof contestId === 'string' &&
    Object.prototype.hasOwnProperty.call(doublesContests, contestId)
  );
}

export function isDoublesContest(category: string) {
  return /\bdoubles?\b/i.test(String(category ?? ''));
}

function clubKey(club: unknown) {
  return String(club ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en');
}

/**
 * The other athletes on this entry's doubles team.
 *
 * A team IS the club, inside one contest — the same rule the platform scores by
 * (see `inTeam` in hyfitgames/hfg.util.ts). A blank club is nobody's team, or
 * every club-less athlete in the contest would become one enormous one.
 */
export function findTeammates(
  roster: CheckinRoster,
  entry: CheckinRosterEntry,
): CheckinRosterEntry[] {
  const club = clubKey(entry.person.club);
  if (!club) return [];
  if (
    !isDoublesContestId(entry.person.contestId) &&
    !isDoublesContest(entry.person.category)
  )
    return [];

  return roster.entries
    .filter(
      (other) =>
        other.person.bib !== entry.person.bib &&
        other.person.contestId === entry.person.contestId &&
        clubKey(other.person.club) === club,
    )
    .sort((a, b) => Number(a.person.bib) - Number(b.person.bib));
}

export function teamWarning(
  entry: CheckinRosterEntry,
  teammates: CheckinRosterEntry[],
): string | null {
  if (
    !isDoublesContestId(entry.person.contestId) &&
    !isDoublesContest(entry.person.category)
  )
    return null;
  if (!entry.person.club.trim())
    return 'Doubles team has no club identifier';
  if (teammates.length === 0) return 'Doubles teammate was not found';
  if (teammates.length > 1) return 'More than two athletes share this Doubles club';
  return null;
}
