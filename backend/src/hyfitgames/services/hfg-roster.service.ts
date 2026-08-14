import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import * as XLSX from 'xlsx';
import { HfgDbService } from '../hfg-db.service';
import {
  parseParticipantImport,
  type ImportedParticipant,
} from '../../hyfit-judge/hjudge-participant-import.util';

/* Roster import for the admin event-setup flow.
 *
 * One event's roster is three tables since migration 066 folded the account
 * layer into the athlete, and an import has to land all three in order:
 *
 *   athletes          the person, profile stored once, carrying the mobile
 *                     number that signs in (optional — a start list has none)
 *   registrations     that person at this event
 *   category_entries  that person in one category, with a bib
 *
 * Both importers funnel through `upsertRow` so the CSV path and the RaceResult
 * path cannot drift apart on identity, and so the manual "add one athlete"
 * action on the console builds exactly the same rows an import does.
 */

// ---------------------------------------------------------------- normalising

// Accepted CSV headers, case/space-insensitive: organiser spreadsheets vary and
// the importer is forgiving about naming so a file "just works".
const HEADER_MAP: Record<string, string[]> = {
  full_name: ['name', 'fullname', 'athletename', 'participantname'],
  mobile: [
    'mobile',
    'phone',
    'contact',
    'mobileno',
    'phonenumber',
    'contactnumber',
  ],
  email: ['email', 'emailid'],
  gender: ['gender', 'sex'],
  dob: ['dob', 'dateofbirth', 'birthdate'],
  city: ['city'],
  state: ['state'],
  blood_group: ['bloodgroup', 'blood'],
  tshirt_size: ['tshirtsize', 'tshirt', 'shirtsize', 'size'],
  emergency_name: ['emergencyname', 'emergencycontactname'],
  emergency_phone: ['emergencyphone', 'emergencycontact', 'emergencynumber'],
  // The entry columns. Without these a file imports into the athlete directory
  // and nobody ends up on the start list — which is exactly the failure this
  // importer was written to remove.
  bib: [
    'bib',
    'bibno',
    'bibnumber',
    'race no',
    'raceno',
    'racenumber',
    'startno',
  ],
  category: ['category', 'contest', 'event', 'categoryname', 'contestname'],
  wave: ['wave', 'startwave', 'heat'],
  timeslot: ['timeslot', 'slot', 'starttime', 'startslot', 'session', 'flight'],
  // Which day the slot is on. A weekend event needs it; a one-day event can
  // leave the column out and every entry falls back to the event's own date.
  contest_date: [
    'contestdate',
    'racedate',
    'startdate',
    'eventdate',
    'competitiondate',
    'day',
  ],
  club: ['club', 'team', 'gym', 'box', 'affiliation'],
  source_id: ['sourceid', 'externalid', 'participantid', 'rrid', 'athleteid'],
};

const norm = (s: unknown) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const TSHIRT_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];

export function normalizeMobile(raw: unknown): string | null {
  let m = String(raw ?? '').replace(/\D/g, '');
  if (m.length === 10) m = '91' + m; // India default, matching the OTP service
  return m.length >= 10 && m.length <= 15 ? m : null;
}

export function normalizeGender(v: unknown): string | null {
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  if (['m', 'male', 'man', 'men'].includes(s)) return 'male';
  if (['f', 'female', 'woman', 'women'].includes(s)) return 'female';
  return s ? 'other' : null;
}

// One calendar day, in every spelling a roster file arrives in: an ISO string,
// a spreadsheet cell already parsed to a Date, an Excel serial, DD/MM/YYYY, or
// the DD.MM.YYYY that RaceResult exports write. Null for anything that is not a
// real day — the callers below decide what an out-of-range day means.
export function parseCalendarDate(v: unknown): string | null {
  if (v == null || v === '') return null;
  let iso: string | null = null;
  // Local parts for a Date: XLSX with cellDates and node-postgres both build
  // one at LOCAL midnight, and toISOString() on that is the previous day in any
  // zone ahead of UTC — off-by-one on every Indian roster.
  if (v instanceof Date && !isNaN(v.getTime()))
    iso = `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  else if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000)); // Excel serial
    iso = isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  } else {
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) iso = `${m[1]}-${m[2]}-${m[3]}`;
    else {
      m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // DD/MM/YYYY, DD.MM.YYYY
      if (m) iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
  }
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso
    ? null
    : iso;
}

// Anything that is not a real calendar date in range becomes null rather than a
// guess: `hyfit_athletes_dob_check` would reject it anyway, and a wrong DOB is
// worse than a missing one because it looks present.
export function parseDob(v: unknown): string | null {
  const iso = parseCalendarDate(v);
  if (!iso) return null;
  return iso > '1900-01-01' && iso < new Date().toISOString().slice(0, 10)
    ? iso
    : null;
}

// A contest date is in the FUTURE for every roster imported before its event,
// so it gets the calendar rule without the DOB range. The only bound that means
// anything here is "a real day".
export const parseContestDate = parseCalendarDate;

// `hyfit_athletes_email_check` insists on lowercase and a plausible shape, so
// anything else is dropped rather than allowed to abort the whole transaction.
const cleanEmail = (v: unknown): string | null => {
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null;
};

const oneOf = (v: unknown, allowed: string[]): string | null => {
  const s = String(v ?? '')
    .trim()
    .toUpperCase();
  return allowed.includes(s) ? s : null;
};

// The same inference migration 056 used to backfill categories, applied to
// names an import invents. Female is tested before male because it contains it,
// and mixed before both because a mixed pair is not thereby a men's pair.
export function inferFormat(name: string): {
  format: string;
  size: number;
} {
  const n = name.toLowerCase();
  if (n.includes('mixed') && n.includes('doubles'))
    return { format: 'mixed_doubles', size: 2 };
  if (n.includes('doubles') || n.includes('pairs'))
    return { format: 'doubles', size: 2 };
  if (n.includes('relay') || n.includes('team'))
    return { format: 'team', size: 2 };
  return { format: 'singles', size: 1 };
}

// ------------------------------------------------------------------- types

/** Where an entry came from — the value written to `category_entries.origin`.
 *  'hyfit' means a human typed it; a file and a pull each name themselves. */
export type EntryOrigin = 'hyfit' | 'roster' | 'raceresult';

export type RosterRow = {
  full_name: string;
  mobile?: string | null;
  email?: string | null;
  gender?: string | null;
  dob?: string | null;
  city?: string | null;
  state?: string | null;
  blood_group?: string | null;
  tshirt_size?: string | null;
  emergency_name?: string | null;
  emergency_phone?: string | null;

  bib: string;
  category?: string | null;
  category_id?: string | null;
  wave?: string | null;
  timeslot?: string | null;
  /** YYYY-MM-DD; the day `timeslot` is on. Null = the event's own date. */
  contest_date?: string | null;
  club?: string | null;

  // Identity for someone with no phone number, and the operational columns a
  // RaceResult entry carries.
  source_id?: string | null;
  entry_source_id?: string | null;
  contest_id?: string | null;
  source_status?: string | null;
  source_data?: unknown;
};

export type ImportReport = {
  total: number;
  athletesCreated: number;
  athletesUpdated: number;
  entriesCreated: number;
  entriesUpdated: number;
  categoriesCreated: string[];
  errors: { row: number; reason: string }[];
  warnings: { row: number; reason: string }[];
  batchId: string | null;
};

type Counters = Pick<
  ImportReport,
  'athletesCreated' | 'athletesUpdated' | 'entriesCreated' | 'entriesUpdated'
> & { categoriesCreated: Set<string> };

const emptyCounters = (): Counters => ({
  athletesCreated: 0,
  athletesUpdated: 0,
  entriesCreated: 0,
  entriesUpdated: 0,
  categoriesCreated: new Set<string>(),
});

const snapshotCounters = (c: Counters): Counters => ({
  ...c,
  categoriesCreated: new Set(c.categoriesCreated),
});

/** A validated row and the line of the file or payload it came from, so the
 *  report can still point at it after the rows have been batched together. */
type PreparedRow = { rowNo: number; row: RosterRow };

/** The profile columns an import may write, merged across every row that turns
 *  out to be the same person. First non-null wins, which is what the row-by-row
 *  path produces too: it creates from the first row and then COALESCEs. */
const PROFILE_COLUMNS = [
  'mobile',
  'email',
  'gender',
  'dob',
  'city',
  'state',
  'blood_group',
  'tshirt_size',
  'emergency_name',
  'emergency_phone',
] as const;

type Profile = Record<(typeof PROFILE_COLUMNS)[number], string | null> & {
  full_name: string;
};

// How many rows travel together — one transaction on the RaceResult path, one
// batch of statements on both.
//
// A start list is not an atomic thing. It is thousands of independent facts,
// and holding them all open in a single transaction buys nothing an organiser
// wants: it pins one connection and one advisory lock for the whole run, it
// keeps the rows invisible until the very end, and a connection lost near the
// end throws away everything before it. Chunking gives that back — each chunk
// that commits is on the start list and stays there, and re-running the pull is
// idempotent, so the fix for a chunk that failed is to pull again.
//
// The size is a balance: large enough that the fixed cost of a batch (a
// transaction, an advisory lock, ~8 statements) is spread thin, small enough
// that a chunk commits quickly and progress moves visibly.
const CHUNK_SIZE = 500;

function mergeProfiles(rows: RosterRow[]): Profile {
  const out = { full_name: rows[0].full_name } as Profile;
  for (const col of PROFILE_COLUMNS) {
    let value: string | null = null;
    for (const row of rows) {
      const v = (row as Record<string, unknown>)[col];
      if (v != null && v !== '') {
        value = String(v);
        break;
      }
    }
    out[col] = value;
  }
  return out;
}

@Injectable()
export class HfgRosterService {
  private readonly logger = new Logger(HfgRosterService.name);

  constructor(private readonly db: HfgDbService) {}

  /** Where a caller follows a pull that is no longer attached to their request:
   *  the run's own row, plus the report of the last one that finished. */
  async getSyncStatus(eventId: string) {
    const run = await this.db.q<{
      id: string;
      state: string;
      importedCount: number;
      rejectedCount: number;
      totalCount: number | null;
      error: string | null;
      startedAt: string;
      finishedAt: string | null;
    }>(
      `SELECT id, state, imported_count AS "importedCount",
              rejected_count AS "rejectedCount", total_count AS "totalCount", error,
              started_at AS "startedAt", finished_at AS "finishedAt"
         FROM sync_runs
        WHERE event_id = $1 AND kind = 'participants'
        ORDER BY started_at DESC LIMIT 1`,
      [eventId],
    );

    // The per-row verdict outlives the run row, in the batch the import writes
    // when it finishes. Only reported once the run is actually over — a batch
    // from the PREVIOUS pull would otherwise read as this one's result.
    const batch =
      run.rows[0] && run.rows[0].state !== 'running'
        ? await this.db.q(
            `SELECT id, total_rows AS "totalRows",
                    athletes_created AS "athletesCreated", athletes_updated AS "athletesUpdated",
                    entries_created AS "entriesCreated", entries_updated AS "entriesUpdated",
                    error_rows AS "errorRows", errors, created_at AS "createdAt"
               FROM import_batches
              WHERE event_id = $1 AND source = 'raceresult'
              ORDER BY created_at DESC LIMIT 1`,
            [eventId],
          )
        : null;

    return { run: run.rows[0] ?? null, batch: batch?.rows[0] ?? null };
  }

  // ------------------------------------------------------------- one row
  //
  // Upserts athlete → registration → entry for a single person, and returns the
  // entry id. Everything is keyed so a re-import updates rather than
  // duplicates:
  //
  //   with a mobile      the number AND the name together are the identity.
  //                      Since 066 the number alone is not unique — a family
  //                      shares a phone — so a new name under a known number is
  //                      a new person, not a rename of the one already there.
  //   without one        person_source_id is, defaulting to the event+bib pair —
  //                      the only stable key a bare start list offers, and
  //                      stable exactly as far as this event, which is the
  //                      scope of a roster import
  async upsertRow(
    client: PoolClient,
    eventId: string,
    row: RosterRow,
    origin: EntryOrigin,
    counts: Counters,
    categoryCache: Map<string, string>,
  ): Promise<string> {
    const categoryId = await this.resolveCategory(
      client,
      eventId,
      row,
      counts,
      categoryCache,
    );

    // --- athlete ---
    // A number may carry several people, so the match is on number AND name.
    const sourceId = row.source_id || `csv:${eventId}:${row.bib}`;

    let found: { id: string; mobile: string | null } | undefined;
    if (row.mobile) {
      const byMobile = await client.query<{
        id: string;
        mobile: string | null;
      }>(
        `SELECT id, mobile FROM athletes
          WHERE mobile = $1 AND lower(btrim(full_name)) = lower(btrim($2))
          ORDER BY created_at LIMIT 1`,
        [row.mobile, row.full_name],
      );
      found = byMobile.rows[0];
    }
    // Fall back to the source key even when a mobile is present. The common
    // sequence is a bare start list imported first and the phone numbers
    // arriving later; without this, the second import creates a second person
    // and then fails on their own bib.
    if (!found) {
      const bySource = await client.query<{
        id: string;
        mobile: string | null;
      }>(
        `SELECT id, mobile FROM athletes WHERE person_source_id = $1 LIMIT 1`,
        [sourceId],
      );
      found = bySource.rows[0];
    }

    let athleteId: string;
    if (found) {
      athleteId = found.id;
      // A number arriving for a profile nobody had claimed turns it into a
      // claimed one — carrying a number IS being claimed, and claim_status must
      // agree with it (hyfit_athletes_claim_agrees).
      if (row.mobile && !found.mobile)
        await client.query(
          `UPDATE athletes
              SET mobile = $2, claim_status = 'claimed', is_managed = false,
                  updated_at = now()
            WHERE id = $1`,
          [athleteId, row.mobile],
        );
      // COALESCE every profile column: an import enriches a profile and never
      // blanks one, because the file being imported is usually narrower than
      // what the athlete has already filled in themselves.
      await client.query(
        `UPDATE athletes SET
           email           = COALESCE($2, email),
           gender          = COALESCE($3, gender),
           dob             = COALESCE($4::date, dob),
           city            = COALESCE($5, city),
           state           = COALESCE($6, state),
           blood_group     = COALESCE($7, blood_group),
           tshirt_size     = COALESCE($8, tshirt_size),
           emergency_name  = COALESCE($9, emergency_name),
           emergency_phone = COALESCE($10, emergency_phone),
           updated_at      = now()
         WHERE id = $1`,
        [
          athleteId,
          row.email ?? null,
          row.gender ?? null,
          row.dob ?? null,
          row.city ?? null,
          row.state ?? null,
          row.blood_group ?? null,
          row.tshirt_size ?? null,
          row.emergency_name ?? null,
          row.emergency_phone ?? null,
        ],
      );
      counts.athletesUpdated++;
    } else {
      // claim_status must agree with the number (hyfit_athletes_claim_agrees).
      // Someone off a start list is `unclaimed` and `is_managed`: they exist,
      // they have no way to sign in, and the organiser maintains their profile
      // until they claim it.
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO athletes (
           mobile, full_name, email, gender, dob, city, state,
           blood_group, tshirt_size, emergency_name, emergency_phone,
           person_source_id, created_via, claim_status, is_managed)
         VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11,$12,'csv_import',
                 CASE WHEN $1::text IS NULL THEN 'unclaimed' ELSE 'claimed' END,
                 $1::text IS NULL)
         RETURNING id`,
        [
          row.mobile ?? null,
          row.full_name,
          row.email ?? null,
          row.gender ?? null,
          row.dob ?? null,
          row.city ?? null,
          row.state ?? null,
          row.blood_group ?? null,
          row.tshirt_size ?? null,
          row.emergency_name ?? null,
          row.emergency_phone ?? null,
          sourceId,
        ],
      );
      athleteId = rows[0].id;
      counts.athletesCreated++;
    }

    // --- registration (this person at this event) ---
    // `registered_by` is the athlete who made the registration. An import puts
    // people in under their own name, so it is their own id when they can sign
    // in — the same value the account layer held before 066 — and NULL for a
    // start-list person, who has no profile to point at yet.
    const { rows: reg } = await client.query<{ id: string }>(
      `INSERT INTO registrations (athlete_id, event_id, registered_by)
       VALUES ($1,$2,$3)
       ON CONFLICT (athlete_id, event_id)
         DO UPDATE SET status = 'active', updated_at = now()
       RETURNING id`,
      [athleteId, eventId, row.mobile ? athleteId : null],
    );
    const registrationId = reg[0].id;

    // --- entry (this person in this category, with a bib) ---
    // The operational columns travel together or not at all
    // (hyfit_category_entries_operational_block), so a RaceResult entry sets
    // all three and a CSV entry sets none.
    const isRR = origin === 'raceresult';
    const { rows: entry } = await client.query<{
      id: string;
      inserted: boolean;
    }>(
      `INSERT INTO category_entries (
         event_id, registration_id, category_id, bib, wave, timeslot, contest_date, club,
         race_status, entry_status, origin,
         checkin_state, entry_source_id, contest_id, source_status,
         source_data, last_source_sync_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,'REG','confirmed',$9,
               CASE WHEN $10::boolean THEN 'not_checked_in' END,
               $11, $12,
               CASE WHEN $10::boolean THEN COALESCE($13,'Ready') END,
               CASE WHEN $10::boolean THEN $14::jsonb END,
               CASE WHEN $10::boolean THEN now() END)
       ON CONFLICT (registration_id, category_id) DO UPDATE SET
         bib        = EXCLUDED.bib,
         wave       = COALESCE(EXCLUDED.wave, category_entries.wave),
         timeslot   = COALESCE(EXCLUDED.timeslot, category_entries.timeslot),
         contest_date = COALESCE(EXCLUDED.contest_date, category_entries.contest_date),
         club       = COALESCE(EXCLUDED.club, category_entries.club),
         entry_source_id = COALESCE(EXCLUDED.entry_source_id, category_entries.entry_source_id),
         contest_id      = COALESCE(EXCLUDED.contest_id, category_entries.contest_id),
         source_status   = COALESCE(EXCLUDED.source_status, category_entries.source_status),
         source_data     = COALESCE(EXCLUDED.source_data, category_entries.source_data),
         checkin_state   = COALESCE(category_entries.checkin_state, EXCLUDED.checkin_state),
         last_source_sync_at = COALESCE(EXCLUDED.last_source_sync_at, category_entries.last_source_sync_at),
         updated_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [
        eventId,
        registrationId,
        categoryId,
        row.bib,
        row.wave ?? null,
        row.timeslot ?? null,
        row.contest_date ?? null,
        row.club ?? null,
        origin,
        isRR,
        row.entry_source_id ?? null,
        row.contest_id ?? null,
        row.source_status ?? null,
        row.source_data ? JSON.stringify(row.source_data) : null,
      ],
    );

    if (entry[0].inserted) counts.entriesCreated++;
    else counts.entriesUpdated++;
    return entry[0].id;
  }

  // How the category cache is keyed, in one place: a row that names its
  // category by id needs no entry, and one that names it by text is keyed on the
  // text so two spellings of one name do not create two categories. Shared with
  // `upsertRowIsolated`, which has to evict what a rolled-back row cached.
  private categoryKey(row: RosterRow): string | null {
    if (row.category_id) return null;
    return (String(row.category ?? '').trim() || 'Open').toLowerCase();
  }

  // A category named by an import that this event does not have yet is created
  // rather than rejected — a RaceResult contest list is where the categories
  // come from in the first place. Only `format` and the team sizes are
  // inferred, from the name; price, cap and eligibility stay NULL for an admin
  // to fill in, and the report names every category it created so nobody has to
  // notice on their own.
  private async resolveCategory(
    client: PoolClient,
    eventId: string,
    row: RosterRow,
    counts: Counters,
    cache: Map<string, string>,
  ): Promise<string> {
    if (row.category_id) return row.category_id;

    const name = String(row.category ?? '').trim() || 'Open';
    const key = this.categoryKey(row)!;
    const cached = cache.get(key);
    if (cached) return cached;

    const found = await client.query<{ id: string }>(
      `SELECT id FROM categories WHERE event_id = $1 AND lower(name) = $2 LIMIT 1`,
      [eventId, key],
    );
    if (found.rows[0]) {
      cache.set(key, found.rows[0].id);
      return found.rows[0].id;
    }

    const { format, size } = inferFormat(name);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO categories (event_id, name, format, team_size_min, team_size_max)
       VALUES ($1,$2,$3,$4,$4)
       ON CONFLICT (event_id, name) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [eventId, name, format, size],
    );
    cache.set(key, rows[0].id);
    counts.categoriesCreated.add(name);
    return rows[0].id;
  }

  // ------------------------------------------------------------ CSV import
  async importCsv(
    eventId: string,
    buffer: Buffer,
    filename: string,
    adminId: string | null,
  ): Promise<ImportReport> {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: '',
    });
    if (!rows.length) throw new BadRequestException('That file has no rows');

    const mapping: Record<string, number> = {};
    rows[0].forEach((h, idx) => {
      const n = norm(h);
      for (const [field, aliases] of Object.entries(HEADER_MAP))
        if (aliases.includes(n) && mapping[field] === undefined)
          mapping[field] = idx;
    });

    if (mapping.full_name === undefined || mapping.bib === undefined) {
      throw new BadRequestException(
        'The header row needs at least a "Name" and a "Bib" column — a roster import assigns bibs, so a file without them cannot produce a start list',
      );
    }

    const errors: { row: number; reason: string }[] = [];
    const warnings: { row: number; reason: string }[] = [];
    const counts = emptyCounters();
    const seenBibs = new Map<string, number>();
    const prepared: PreparedRow[] = [];
    let total = 0;

    // Read and validated first, written afterwards: the whole file becomes
    // rows in memory, and those rows are then written in batches.
    for (let i = 1; i < rows.length; i++) {
      const raw = rows[i];
      if (!raw.some((c) => String(c).trim() !== '')) continue; // blank line
      total++;
      const rowNo = i + 1;
      const get = (f: string) =>
        mapping[f] !== undefined ? raw[mapping[f]] : '';

      const full_name = String(get('full_name')).trim();
      // `hyfit_category_entries_bib_check` is digits-only, so a bib like
      // "M-12" is rejected here with a sentence rather than deep in the
      // transaction as a constraint violation.
      const bib = String(get('bib')).trim();
      if (!full_name) {
        errors.push({ row: rowNo, reason: 'Missing name' });
        continue;
      }
      if (!/^\d+$/.test(bib)) {
        errors.push({
          row: rowNo,
          reason: `Bib "${get('bib')}" is not a number`,
        });
        continue;
      }
      if (seenBibs.has(bib)) {
        errors.push({
          row: rowNo,
          reason: `Bib ${bib} is already used on row ${seenBibs.get(bib)}`,
        });
        continue;
      }
      seenBibs.set(bib, rowNo);

      const rawMobile = String(get('mobile')).trim();
      const mobile = normalizeMobile(rawMobile);
      if (rawMobile && !mobile)
        warnings.push({
          row: rowNo,
          reason: `Mobile "${rawMobile}" is not a valid number — imported without one, so this athlete cannot sign in yet`,
        });

      const rawDob = get('dob');
      const dob = parseDob(rawDob);
      if (rawDob && !dob)
        warnings.push({
          row: rowNo,
          reason: `Unreadable date of birth "${rawDob}" (use DD/MM/YYYY) — imported without it`,
        });

      // The emergency pair travels together or not at all
      // (hyfit_athletes_emergency_block).
      const emergency_name = String(get('emergency_name')).trim() || null;
      const emergency_phone = normalizeMobile(get('emergency_phone'));
      const emergencyPairOk = !!emergency_name === !!emergency_phone;

      // Said out loud, because the consequence is invisible otherwise: an
      // unreadable contest date falls back to the event's own date, which on
      // a two-day event puts that athlete's check-in window on the wrong day.
      const contest_date = parseContestDate(get('contest_date'));
      if (!contest_date && String(get('contest_date')).trim())
        warnings.push({
          row: rowNo,
          reason: `Contest date "${String(get('contest_date')).trim()}" is not a date — imported without one, so this entry follows the event date`,
        });
      if (!emergencyPairOk)
        warnings.push({
          row: rowNo,
          reason:
            'Emergency contact needs both a name and a valid number — imported without either',
        });

      prepared.push({
        rowNo,
        row: {
          full_name,
          mobile,
          email: cleanEmail(get('email')),
          gender: normalizeGender(get('gender')),
          dob,
          city: String(get('city')).trim() || null,
          state: String(get('state')).trim() || null,
          blood_group: oneOf(get('blood_group'), BLOOD_GROUPS),
          tshirt_size: oneOf(get('tshirt_size'), TSHIRT_SIZES),
          emergency_name: emergencyPairOk ? emergency_name : null,
          emergency_phone: emergencyPairOk ? emergency_phone : null,
          bib,
          category: String(get('category')).trim() || null,
          wave: String(get('wave')).trim() || null,
          timeslot: String(get('timeslot')).trim() || null,
          contest_date,
          club: String(get('club')).trim() || null,
          source_id: String(get('source_id')).trim() || null,
        },
      });
    }

    await this.db.tx(async (client) => {
      await this.lockEventImport(client, eventId);
      const cache = new Map<string, string>();
      // Written in batches, for the reason the RaceResult path is: a row at a
      // time is a round trip at a time, and a file of any size is then bounded
      // by network latency rather than by the database.
      for (let i = 0; i < prepared.length; i += CHUNK_SIZE)
        await this.writeRows(
          client,
          eventId,
          prepared.slice(i, i + CHUNK_SIZE),
          // 'roster', not 'hyfit' (073): an athlete who arrived in the
          // organiser's file and one somebody typed at the desk are different
          // facts, and only this column can tell them apart afterwards.
          'roster',
          counts,
          errors,
          cache,
        );
    });

    return this.finish(
      { eventId, adminId, source: 'csv', originLabel: filename },
      { total, counts, errors, warnings },
    );
  }

  // ----------------------------------------------------- RaceResult import
  //
  // Pulls a roster from a RaceResult participant endpoint into ONE named event.
  // The payload is read by `parseParticipantImport`, the same function the
  // field-ops sync uses, so an organiser configures the field mapping once and
  // both sides agree about which key is the bib.
  // A pull is STARTED by a request and finished by the server on its own time.
  //
  // Writing 2500 entries takes minutes, and for as long as that work sat inside
  // the HTTP request, the request was the weakest part of it: a proxy timeout,
  // a closed laptop or a reloaded tab killed the socket, the caller saw
  // `ECONNRESET — socket hang up`, and the import carried on writing rows that
  // nobody was told about. Whether it had worked was unanswerable.
  //
  // So the request now does only what needs answering immediately — is the URL
  // reachable, does the mapping fit the payload, is another pull already
  // running — and hands the writing to the background. The caller gets a run id
  // in about a second and follows it with `getSyncStatus`, which reads the
  // progress the chunk loop records as it goes. Nothing is lost if the caller
  // walks away: the run is a row in `sync_runs`, not a socket.
  async startRaceResultImport(
    eventId: string,
    opts: { url: string; mapping?: Record<string, unknown> },
    adminId: string | null,
  ): Promise<{ runId: string | null; total: number; rejected: number }> {
    const { url, normalized } = await this.fetchRaceResult(eventId, opts);

    // Claimed here, in the request, so "another pull is already running" is a
    // 409 the operator sees rather than a background failure they have to go
    // looking for.
    const runId = await this.beginSync(eventId, normalized.participants.length);

    // Deliberately not awaited — this is the handoff. The catch is not
    // optional: an unhandled rejection is a process-level crash in Node, so a
    // background import that throws must never be allowed to become one.
    void this.runRaceResultImport(
      eventId,
      url,
      normalized,
      adminId,
      runId,
    ).catch((err) => {
      this.logger.error(
        `RaceResult import for event ${eventId} failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
    });

    return {
      runId,
      total: normalized.participants.length,
      rejected: normalized.rejectedCount,
    };
  }

  /** Fetches and parses the participant payload. Everything here is fast and
   *  everything here can fail in a way the operator must see at once, which is
   *  why it stays on the request's side of the handoff. */
  private async fetchRaceResult(
    eventId: string,
    opts: { url: string; mapping?: Record<string, unknown> },
  ) {
    const url = String(opts.url || '').trim();
    if (!/^https?:\/\//i.test(url))
      throw new BadRequestException(
        'A complete http(s) participant endpoint is required',
      );

    let payload: unknown;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!res.ok)
        throw new BadRequestException(
          `RaceResult participant endpoint returned HTTP ${res.status}`,
        );
      payload = await res.json();
    } catch (err) {
      const message =
        (err as Error)?.name === 'AbortError'
          ? 'RaceResult participant request timed out after 15s'
          : (err as Error).message;
      await this.recordSync(eventId, 'failed', message);
      throw err instanceof BadRequestException
        ? err
        : new BadRequestException(message);
    } finally {
      clearTimeout(timeout);
    }

    let normalized: ReturnType<typeof parseParticipantImport>;
    try {
      normalized = parseParticipantImport(payload, opts.mapping ?? {});
    } catch (err) {
      await this.recordSync(eventId, 'failed', (err as Error).message);
      throw new BadRequestException((err as Error).message);
    }
    if (!normalized.participants.length) {
      const message = `RaceResult returned no usable participants (${normalized.rejectedCount} rejected) — check the field mapping`;
      await this.recordSync(eventId, 'failed', message);
      throw new BadRequestException(message);
    }

    return { url, normalized };
  }

  /** The background half: writes the roster chunk by chunk and records its own
   *  verdict. Returns the report for callers that do want to wait (the tests,
   *  and any future in-process caller); the HTTP path does not. */
  private async runRaceResultImport(
    eventId: string,
    url: string,
    normalized: ReturnType<typeof parseParticipantImport>,
    adminId: string | null,
    runId: string | null,
  ): Promise<ImportReport> {
    const errors: { row: number; reason: string }[] = [];
    const warnings: { row: number; reason: string }[] = [];
    const counts = emptyCounters();

    // Imported in chunks, each its own transaction (see CHUNK_SIZE).
    const cache = new Map<string, string>();
    let imported = 0;
    try {
      for (
        let start = 0;
        start < normalized.participants.length;
        start += CHUNK_SIZE
      ) {
        const chunk = normalized.participants.slice(start, start + CHUNK_SIZE);
        await this.importChunk(
          eventId,
          chunk,
          start,
          cache,
          counts,
          errors,
          warnings,
        );
        imported += chunk.length;
        // Progress the Operations screen can actually watch, written between
        // chunks because that is the only moment the numbers are true.
        await this.progressSync(runId, imported, normalized.rejectedCount);
        // Logged per chunk because this work has no request to report to. When
        // an import stops early — a restarted process, a killed connection —
        // the last line printed is how far it got, and there is otherwise
        // nothing anywhere that says.
        this.logger.log(
          `RaceResult import ${eventId}: ${imported}/${normalized.participants.length} entries`,
        );
      }
    } catch (err) {
      // Closed on every path, including a collision. The old code deliberately
      // skipped the bookkeeping for a refused second pull — a refusal is not
      // this roster's verdict — but that reasoning belongs to `beginSync`,
      // which now refuses before the row exists. Anything thrown from here is a
      // failure of a pull that already OWNS the running row, and leaving it
      // open would block the event's next pull for half an hour.
      await this.endSync(runId, eventId, 'failed', (err as Error).message, {
        // What actually landed before the failure, not what was asked for —
        // the chunks that committed are on the start list and stay there.
        imported,
        rejected: normalized.rejectedCount,
      });
      throw err;
    }

    if (normalized.rejectedCount)
      warnings.push({
        row: 0,
        reason: `${normalized.rejectedCount} record(s) in the payload had no usable bib or name and were skipped`,
      });

    await this.endSync(runId, eventId, 'complete', null, {
      imported: normalized.participants.length,
      rejected: normalized.rejectedCount,
    });
    return this.finish(
      { eventId, adminId, source: 'raceresult', originLabel: url },
      { total: normalized.participants.length, counts, errors, warnings },
    );
  }

  /** One chunk of a RaceResult pull, in one transaction. `offset` is the index
   *  the chunk starts at, so a row number in the report still points at the
   *  line of the payload it came from. */
  private async importChunk(
    eventId: string,
    chunk: ImportedParticipant[],
    offset: number,
    cache: Map<string, string>,
    counts: Counters,
    errors: { row: number; reason: string }[],
    warnings: { row: number; reason: string }[],
  ) {
    const prepared: PreparedRow[] = chunk.map((p, j) => {
      const i = offset + j;
      // Said out loud, the way the CSV path says it: a phone column full of
      // numbers the app cannot use would otherwise leave every athlete
      // unclaimed with nothing on screen to explain why.
      if (p.mobile && !normalizeMobile(p.mobile))
        warnings.push({
          row: i + 1,
          reason: `Mobile "${p.mobile}" is not a valid number — imported without one, so this athlete cannot sign in yet`,
        });
      if (p.contestDate && !parseContestDate(p.contestDate))
        warnings.push({
          row: i + 1,
          reason: `Contest date "${p.contestDate}" is not a date — imported without one, so this entry follows the event date`,
        });
      return {
        rowNo: i + 1,
        row: {
          full_name: p.name,
          // Read when the payload has a phone column and left null when it does
          // not — a bare start list has none, which is why the unclaimed-athlete
          // state exists. Without a number the athlete cannot sign in, so a
          // roster that has them must carry them through rather than drop them
          // here.
          mobile: normalizeMobile(p.mobile),
          gender: normalizeGender(p.gender),
          dob: parseDob(p.dateOfBirth),
          bib: p.bib,
          category: p.category,
          wave: p.wave && p.wave !== 'Wave pending' ? p.wave : null,
          timeslot: p.timeslot || null,
          // RaceResult writes dates in several shapes depending on the event's
          // locale; an unreadable one is left null rather than guessed, and the
          // entry follows the event date as before.
          contest_date: parseContestDate(p.contestDate),
          club: p.club || null,
          source_id: `rr:${p.id}`,
          entry_source_id: p.id,
          contest_id: p.contestId || null,
          source_status: p.status,
          source_data: p,
        },
      };
    });

    try {
      await this.db.tx(async (client) => {
        // Taken per chunk, and still enough: the lock exists to keep two
        // imports off one event's roster, and a competing import cannot start
        // between chunks either, because `sync_runs` already holds a running
        // row for this one (hyfit_one_running_sync).
        await this.lockEventImport(client, eventId);
        await this.writeRows(
          client,
          eventId,
          prepared,
          'raceresult',
          counts,
          errors,
          cache,
        );
      });
    } catch (err) {
      // The whole chunk rolled back — a lost connection, or a lock this import
      // could not take. Every category id this chunk cached went with it, so
      // the cache is dropped rather than carried into the next chunk, where it
      // would name rows that no longer exist.
      cache.clear();
      throw err;
    }
  }

  // ------------------------------------------------------- the batched write
  //
  // A batch of rows, written with a fixed number of statements instead of one
  // statement per row.
  //
  // This is where the import's time used to go, and none of it was spent in the
  // database. `upsertRow` is six to eight round trips — look the athlete up by
  // number, look them up by source key, update them, upsert the registration,
  // upsert the entry, and a SAVEPOINT and a RELEASE around the lot. At a couple
  // of milliseconds each that is fine for one athlete and ruinous for 2500:
  // the run becomes ~18,000 sequential round trips and takes minutes, of which
  // the server spends almost all of it waiting for the network.
  //
  // Set-based, the same 2500 rows are ~40 statements. The work Postgres does is
  // the same work; what disappears is the waiting.
  //
  // The batch is all-or-nothing, though, and an import must still be able to
  // say "row 412 has a duplicate bib" rather than failing whole. So the batch
  // runs inside a savepoint, and if ANY statement in it fails the savepoint is
  // rolled back and the batch is rewritten the old way, row by row, each in its
  // own savepoint. The fast path handles the ordinary import; the slow path
  // keeps the per-row verdicts an operator needs when a file is wrong. A
  // clean import never pays for the fallback, and a dirty one pays for it once
  // per batch that contains a bad row.
  private async writeRows(
    client: PoolClient,
    eventId: string,
    prepared: PreparedRow[],
    origin: EntryOrigin,
    counts: Counters,
    errors: { row: number; reason: string }[],
    cache: Map<string, string>,
  ): Promise<void> {
    if (!prepared.length) return;

    const before = snapshotCounters(counts);
    const cachedBefore = new Set(cache.keys());

    await client.query('SAVEPOINT roster_batch');
    try {
      await this.bulkUpsert(client, eventId, prepared, origin, counts, cache);
      await client.query('RELEASE SAVEPOINT roster_batch');
      return;
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT roster_batch');
      // Everything the batch did is gone, including the counters it advanced
      // and any category it created — an id cached for a category that no
      // longer exists would be written into entries by the rows that follow.
      Object.assign(counts, before);
      for (const key of cache.keys())
        if (!cachedBefore.has(key)) cache.delete(key);
      this.logger.warn(
        `Batched roster write failed (${(err as Error).message}) — rewriting ${prepared.length} rows one at a time to find the bad ones`,
      );
    }

    for (const { rowNo, row } of prepared) {
      try {
        await this.upsertRowIsolated(
          client,
          eventId,
          row,
          origin,
          counts,
          cache,
        );
      } catch (err) {
        errors.push({ row: rowNo, reason: this.explain(err, row.bib) });
      }
    }
  }

  /** The fast path: athletes, registrations and entries for a whole batch, in a
   *  fixed handful of statements. Throws on the first thing that does not fit,
   *  which is `writeRows`' signal to fall back to the row-by-row path. */
  private async bulkUpsert(
    client: PoolClient,
    eventId: string,
    prepared: PreparedRow[],
    origin: EntryOrigin,
    counts: Counters,
    cache: Map<string, string>,
  ): Promise<void> {
    await this.resolveCategoriesBulk(client, eventId, prepared, counts, cache);

    const sourceIds = prepared.map(
      ({ row }) => row.source_id || `csv:${eventId}:${row.bib}`,
    );
    // Two rows that are the same person must not become two athletes just
    // because they landed in the same batch — row by row, the second row would
    // have FOUND what the first one wrote. Same rule as `upsertRow`: with a
    // number, the number and the name together; without one, the source key.
    const keys = prepared.map(({ row }, i) =>
      row.mobile
        ? `m:${row.mobile}|${row.full_name.trim().toLowerCase()}`
        : `s:${sourceIds[i]}`,
    );

    // --- who is already here ---
    const mobileHits = new Map<string, string>();
    const withMobile = prepared
      .map(({ row }, i) => ({
        k: keys[i],
        mobile: row.mobile,
        name: row.full_name,
      }))
      .filter((x) => x.mobile);
    if (withMobile.length) {
      const { rows } = await client.query<{ k: string; id: string }>(
        `SELECT DISTINCT ON (x.k) x.k, a.id
           FROM jsonb_to_recordset($1::jsonb) AS x(k text, mobile text, name text)
           JOIN athletes a
             ON a.mobile = x.mobile
            AND lower(btrim(a.full_name)) = lower(btrim(x.name))
          ORDER BY x.k, a.created_at`,
        [JSON.stringify(withMobile)],
      );
      for (const r of rows) mobileHits.set(r.k, r.id);
    }

    // Looked up for every row, with or without a number — the common sequence
    // is a bare start list imported first and the phone numbers arriving later.
    const sourceHits = new Map<string, string>();
    {
      const { rows } = await client.query<{ sid: string; id: string }>(
        `SELECT DISTINCT ON (a.person_source_id) a.person_source_id AS sid, a.id
           FROM athletes a
          WHERE a.person_source_id = ANY($1::text[])
          ORDER BY a.person_source_id, a.created_at`,
        [[...new Set(sourceIds)]],
      );
      for (const r of rows) sourceHits.set(r.sid, r.id);
    }

    // --- athletes: one insert for the new, one update for the rest ---
    const existingByKey = new Map<string, string>(); // identity key → athlete id
    const keyToSource = new Map<string, string>(); // identity key → its source id
    const createRows = new Map<string, RosterRow[]>(); // source id → rows
    const updateRows = new Map<string, RosterRow[]>(); // athlete id → rows

    prepared.forEach(({ row }, i) => {
      const key = keys[i];
      const hit =
        existingByKey.get(key) ??
        mobileHits.get(key) ??
        sourceHits.get(sourceIds[i]);
      if (hit) {
        existingByKey.set(key, hit);
        updateRows.set(hit, [...(updateRows.get(hit) ?? []), row]);
        return;
      }
      // The first row of an unknown person decides which source key the new
      // athlete is filed under; the rest of the batch joins them there.
      const sid = keyToSource.get(key) ?? sourceIds[i];
      keyToSource.set(key, sid);
      createRows.set(sid, [...(createRows.get(sid) ?? []), row]);
    });

    if (createRows.size) {
      const payload = [...createRows.entries()].map(([sid, rows]) => ({
        ...mergeProfiles(rows),
        person_source_id: sid,
      }));
      // claim_status must agree with the number (hyfit_athletes_claim_agrees).
      // Someone off a start list is `unclaimed` and `is_managed`: they exist,
      // they have no way to sign in, and the organiser maintains their profile
      // until they claim it.
      const { rows } = await client.query<{
        id: string;
        person_source_id: string;
      }>(
        `INSERT INTO athletes (
           mobile, full_name, email, gender, dob, city, state,
           blood_group, tshirt_size, emergency_name, emergency_phone,
           person_source_id, created_via, claim_status, is_managed)
         SELECT x.mobile, x.full_name, x.email, x.gender, x.dob, x.city, x.state,
                x.blood_group, x.tshirt_size, x.emergency_name, x.emergency_phone,
                x.person_source_id, 'csv_import',
                CASE WHEN x.mobile IS NULL THEN 'unclaimed' ELSE 'claimed' END,
                x.mobile IS NULL
           FROM jsonb_to_recordset($1::jsonb)
             AS x(mobile text, full_name text, email text, gender text, dob date,
                  city text, state text, blood_group text, tshirt_size text,
                  emergency_name text, emergency_phone text, person_source_id text)
         RETURNING id, person_source_id`,
        [JSON.stringify(payload)],
      );
      const idBySource = new Map<string, string>(
        rows.map((r) => [r.person_source_id, r.id]),
      );
      for (const [key, sid] of keyToSource) {
        const id = idBySource.get(sid);
        if (!id) throw new Error(`Athlete insert lost source key ${sid}`);
        existingByKey.set(key, id);
      }
    }

    if (updateRows.size) {
      const payload = [...updateRows.entries()].map(([id, rows]) => ({
        id,
        ...mergeProfiles(rows),
      }));
      // COALESCE every profile column: an import enriches a profile and never
      // blanks one, because the file being imported is usually narrower than
      // what the athlete has already filled in themselves. A number arriving
      // for a profile nobody had claimed turns it into a claimed one — carrying
      // a number IS being claimed (hyfit_athletes_claim_agrees).
      await client.query(
        `UPDATE athletes a SET
           mobile          = COALESCE(a.mobile, x.mobile),
           claim_status    = CASE WHEN COALESCE(a.mobile, x.mobile) IS NOT NULL
                                  THEN 'claimed' ELSE a.claim_status END,
           is_managed      = CASE WHEN a.mobile IS NULL AND x.mobile IS NOT NULL
                                  THEN false ELSE a.is_managed END,
           email           = COALESCE(x.email, a.email),
           gender          = COALESCE(x.gender, a.gender),
           dob             = COALESCE(x.dob, a.dob),
           city            = COALESCE(x.city, a.city),
           state           = COALESCE(x.state, a.state),
           blood_group     = COALESCE(x.blood_group, a.blood_group),
           tshirt_size     = COALESCE(x.tshirt_size, a.tshirt_size),
           emergency_name  = COALESCE(x.emergency_name, a.emergency_name),
           emergency_phone = COALESCE(x.emergency_phone, a.emergency_phone),
           updated_at      = now()
         FROM jsonb_to_recordset($1::jsonb)
           AS x(id uuid, mobile text, email text, gender text, dob date,
                city text, state text, blood_group text, tshirt_size text,
                emergency_name text, emergency_phone text)
        WHERE a.id = x.id`,
        [JSON.stringify(payload)],
      );
    }

    // Row by row, every row advances exactly one of the two counters: the row
    // that creates the athlete counts as created, and every later row naming
    // that same person counts as updated. Batched, that is the same arithmetic.
    counts.athletesCreated += createRows.size;
    counts.athletesUpdated += prepared.length - createRows.size;

    // --- registrations (this person at this event) ---
    // `registered_by` is the athlete who made the registration. An import puts
    // people in under their own name, so it is their own id when they can sign
    // in, and NULL for a start-list person, who has no profile to point at yet.
    const regBy = new Map<string, string | null>();
    prepared.forEach(({ row }, i) => {
      const athleteId = existingByKey.get(keys[i])!;
      if (!regBy.has(athleteId))
        regBy.set(athleteId, row.mobile ? athleteId : null);
    });
    const { rows: regs } = await client.query<{
      id: string;
      athlete_id: string;
    }>(
      `INSERT INTO registrations (athlete_id, event_id, registered_by)
       SELECT x.athlete_id, $2::uuid, x.registered_by
         FROM jsonb_to_recordset($1::jsonb)
           AS x(athlete_id uuid, registered_by uuid)
       ON CONFLICT (athlete_id, event_id)
         DO UPDATE SET status = 'active', updated_at = now()
       RETURNING id, athlete_id`,
      [
        JSON.stringify(
          [...regBy.entries()].map(([athlete_id, registered_by]) => ({
            athlete_id,
            registered_by,
          })),
        ),
        eventId,
      ],
    );
    const regByAthlete = new Map(regs.map((r) => [r.athlete_id, r.id]));

    // --- entries (this person in this category, with a bib) ---
    // One entry per (registration, category): a batch that names the same pair
    // twice would make ON CONFLICT touch one row twice, which Postgres refuses.
    // The later row wins, exactly as it would if the two were written in order.
    const entries = new Map<string, Record<string, unknown>>();
    prepared.forEach(({ row }, i) => {
      const registration_id = regByAthlete.get(existingByKey.get(keys[i])!);
      if (!registration_id) throw new Error('Registration upsert lost a row');
      const category_id = row.category_id ?? cache.get(this.categoryKey(row)!);
      if (!category_id) throw new Error('Category resolution lost a row');
      entries.set(`${registration_id}|${category_id}`, {
        registration_id,
        category_id,
        bib: row.bib,
        wave: row.wave ?? null,
        timeslot: row.timeslot ?? null,
        contest_date: row.contest_date ?? null,
        club: row.club ?? null,
        entry_source_id: row.entry_source_id ?? null,
        contest_id: row.contest_id ?? null,
        source_status: row.source_status ?? null,
        source_data: row.source_data ?? null,
      });
    });

    // The operational columns travel together or not at all
    // (hyfit_category_entries_operational_block), so a RaceResult entry sets
    // all three and a CSV entry sets none.
    const isRR = origin === 'raceresult';
    const { rows: written } = await client.query<{ inserted: boolean }>(
      `INSERT INTO category_entries (
         event_id, registration_id, category_id, bib, wave, timeslot, contest_date, club,
         race_status, entry_status, origin,
         checkin_state, entry_source_id, contest_id, source_status,
         source_data, last_source_sync_at)
       SELECT $2::uuid, x.registration_id, x.category_id, x.bib, x.wave, x.timeslot,
              x.contest_date, x.club, 'REG', 'confirmed', $3,
              CASE WHEN $4::boolean THEN 'not_checked_in' END,
              x.entry_source_id, x.contest_id,
              CASE WHEN $4::boolean THEN COALESCE(x.source_status,'Ready') END,
              CASE WHEN $4::boolean THEN x.source_data END,
              CASE WHEN $4::boolean THEN now() END
         FROM jsonb_to_recordset($1::jsonb)
           AS x(registration_id uuid, category_id uuid, bib text, wave text,
                timeslot text, contest_date date, club text, entry_source_id text,
                contest_id text, source_status text, source_data jsonb)
       ON CONFLICT (registration_id, category_id) DO UPDATE SET
         bib        = EXCLUDED.bib,
         wave       = COALESCE(EXCLUDED.wave, category_entries.wave),
         timeslot   = COALESCE(EXCLUDED.timeslot, category_entries.timeslot),
         contest_date = COALESCE(EXCLUDED.contest_date, category_entries.contest_date),
         club       = COALESCE(EXCLUDED.club, category_entries.club),
         entry_source_id = COALESCE(EXCLUDED.entry_source_id, category_entries.entry_source_id),
         contest_id      = COALESCE(EXCLUDED.contest_id, category_entries.contest_id),
         source_status   = COALESCE(EXCLUDED.source_status, category_entries.source_status),
         source_data     = COALESCE(EXCLUDED.source_data, category_entries.source_data),
         checkin_state   = COALESCE(category_entries.checkin_state, EXCLUDED.checkin_state),
         last_source_sync_at = COALESCE(EXCLUDED.last_source_sync_at, category_entries.last_source_sync_at),
         updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [JSON.stringify([...entries.values()]), eventId, origin, isRR],
    );

    const created = written.filter((r) => r.inserted).length;
    counts.entriesCreated += created;
    // The rows collapsed above updated an entry the batch itself had just
    // written, which is what the row-by-row path would have counted them as.
    counts.entriesUpdated += prepared.length - created;
  }

  /** Every category this batch names, resolved in two statements instead of two
   *  per row. Same rule as `resolveCategory`: a name this event does not have
   *  is created rather than rejected, and the report says which. */
  private async resolveCategoriesBulk(
    client: PoolClient,
    eventId: string,
    prepared: PreparedRow[],
    counts: Counters,
    cache: Map<string, string>,
  ): Promise<void> {
    const wanted = new Map<string, string>(); // lower(name) → name as written
    for (const { row } of prepared) {
      const key = this.categoryKey(row);
      if (!key || cache.has(key) || wanted.has(key)) continue;
      wanted.set(key, String(row.category ?? '').trim() || 'Open');
    }
    if (!wanted.size) return;

    const { rows: found } = await client.query<{ id: string; key: string }>(
      `SELECT id, lower(name) AS key FROM categories
        WHERE event_id = $1 AND lower(name) = ANY($2::text[])`,
      [eventId, [...wanted.keys()]],
    );
    for (const f of found) {
      cache.set(f.key, f.id);
      wanted.delete(f.key);
    }
    if (!wanted.size) return;

    // Only `format` and the team sizes are inferred, from the name; price, cap
    // and eligibility stay NULL for an admin to fill in.
    const payload = [...wanted.values()].map((name) => ({
      name,
      ...inferFormat(name),
    }));
    const { rows: made } = await client.query<{ id: string; key: string }>(
      `INSERT INTO categories (event_id, name, format, team_size_min, team_size_max)
       SELECT $1, x.name, x.format, x.size, x.size
         FROM jsonb_to_recordset($2::jsonb) AS x(name text, format text, size int)
       ON CONFLICT (event_id, name) DO UPDATE SET updated_at = now()
       RETURNING id, lower(name) AS key`,
      [eventId, JSON.stringify(payload)],
    );
    for (const m of made) cache.set(m.key, m.id);
    for (const p of payload) counts.categoriesCreated.add(p.name);
  }

  /** Opens the `running` sync row for a pull. Null when the bookkeeping insert
   *  fails for any reason other than a collision — losing the progress record
   *  is not a reason to refuse an import. */
  private async beginSync(
    eventId: string,
    total: number,
  ): Promise<string | null> {
    try {
      // Reclaim first. A pull whose process died leaves its row in `running`,
      // and the unique index would then refuse every later pull of this event —
      // the schema comment on hyfit_one_running_sync calls that out as the
      // thing not to do.
      //
      // Judged on the heartbeat (074), not on how long ago the run started: a
      // live import stamps `progress_at` after every chunk, seconds apart, so
      // three minutes of silence means the process is gone. Reclaiming on total
      // age instead would have to wait out the slowest possible import before
      // it dared, which is the same as making the operator wait it out too.
      await this.db
        .q(
          `UPDATE sync_runs
              SET state = 'failed', finished_at = now(),
                  error = COALESCE(error, 'Abandoned — the import stopped without finishing')
            WHERE event_id = $1 AND kind = 'participants' AND state = 'running'
              AND COALESCE(progress_at, started_at) < now() - interval '3 minutes'`,
          [eventId],
        )
        .catch(() => undefined);

      const { rows } = await this.db.q<{ id: string }>(
        `INSERT INTO sync_runs (event_id, kind, state, total_count)
         VALUES ($1,'participants','running',$2)
         RETURNING id`,
        [eventId, total],
      );
      return rows[0]?.id ?? null;
    } catch (err) {
      // hyfit_one_running_sync: someone else's pull owns this event.
      if ((err as { code?: string })?.code === '23505')
        throw new ConflictException(
          'A participant sync for this event is already running — wait for it to finish before starting another',
        );
      return null;
    }
  }

  private async progressSync(
    runId: string | null,
    imported: number,
    rejected: number,
  ) {
    if (!runId) return;
    await this.db
      .q(
        `UPDATE sync_runs SET imported_count = $2, rejected_count = $3, progress_at = now()
          WHERE id = $1`,
        [runId, imported, rejected],
      )
      .catch(() => undefined);
  }

  /** Closes the running row. A row left in `running` would block every later
   *  pull of this event, so this must run on both paths — and if there is no
   *  row to close, the verdict is still recorded, as it was before chunking. */
  private async endSync(
    runId: string | null,
    eventId: string,
    state: 'complete' | 'failed',
    error: string | null,
    counts: { imported: number; rejected: number },
  ) {
    if (!runId) {
      await this.recordSync(eventId, state, error, counts);
      return;
    }
    await this.db
      .q(
        `UPDATE sync_runs SET state = $2, imported_count = $3, rejected_count = $4,
                              error = $5, finished_at = now()
          WHERE id = $1`,
        [
          runId,
          state,
          counts.imported,
          counts.rejected,
          error?.slice(0, 1000) ?? null,
        ],
      )
      .catch(() => undefined);
  }

  // --------------------------------------------------------------- helpers

  // One row, inside its own savepoint.
  //
  // The per-row `try/catch` around `upsertRow` reads as "report this row and
  // carry on", but Postgres aborts the whole transaction on the first error, so
  // without a savepoint every later row fails with "current transaction is
  // aborted" and the whole import is lost behind one bad bib. A 2000-row pull
  // came back with exactly that: one real error and 1999 phantoms.
  private async upsertRowIsolated(
    client: PoolClient,
    eventId: string,
    row: RosterRow,
    origin: EntryOrigin,
    counts: Counters,
    categoryCache: Map<string, string>,
  ): Promise<string> {
    // The counters are advanced as the row's three writes land, so a row that
    // creates an athlete and then fails on its bib has to give the count back —
    // otherwise the report claims an athlete the transaction rolled away.
    const before = snapshotCounters(counts);

    await client.query('SAVEPOINT roster_row');
    try {
      const entryId = await this.upsertRow(
        client,
        eventId,
        row,
        origin,
        counts,
        categoryCache,
      );
      await client.query('RELEASE SAVEPOINT roster_row');
      return entryId;
    } catch (err) {
      // Back to the savepoint, so the rows after this one still see a live
      // transaction.
      await client.query('ROLLBACK TO SAVEPOINT roster_row');
      Object.assign(counts, before);
      // A category this row created went back with it, so the id cached for it
      // no longer exists and the next row naming it must look again.
      const key = this.categoryKey(row);
      if (key) categoryCache.delete(key);
      throw err;
    }
  }

  // Refuses a second import of the same event while one is still running.
  //
  // A pull of a large field takes minutes, and the console's proxy hangs up
  // long before it finishes — so the natural thing to do is click again. The
  // second run then races the first: it cannot see the athletes the first has
  // not committed yet, creates its own, and dies on their bibs the moment the
  // first commits. The lock is transaction-scoped, so it goes when the import
  // does, however it ends.
  private async lockEventImport(client: PoolClient, eventId: string) {
    const { rows } = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock(4207, hashtext($1)) AS locked`,
      [eventId],
    );
    if (!rows[0]?.locked)
      throw new ConflictException(
        'An import for this event is already running — wait for it to finish before starting another',
      );
  }

  // Turns the constraint violations this import can realistically hit into
  // sentences. Everything else keeps its own message.
  private explain(err: unknown, bib: string): string {
    const e = err as { code?: string; constraint?: string; message?: string };
    if (e?.code === '23505') {
      if (e.constraint?.includes('event_bib'))
        return `Bib ${bib} already belongs to a different athlete at this event`;
      return 'That athlete is already entered in this category';
    }
    if (e?.code === '23514')
      return `Rejected by ${e.constraint ?? 'a validation rule'} — check gender, date of birth and bib`;
    return e?.message ?? 'Import failed';
  }

  // Recorded in `sync_runs`, where the field module's own participant sync
  // records itself, so the console's Roster tab and the Operations screen show
  // one history rather than two that disagree.
  //
  // The row is written finished, never 'running': `hyfit_one_running_sync` is a
  // partial unique index over running rows, and a pull that died mid-flight
  // would otherwise strand it and block every later sync for that event.
  private async recordSync(
    eventId: string,
    state: 'complete' | 'failed',
    error: string | null,
    counts?: { imported: number; rejected: number },
  ) {
    await this.db
      .q(
        `INSERT INTO sync_runs (event_id, kind, state, imported_count,
                                rejected_count, error, finished_at)
         VALUES ($1, 'participants', $2, $3, $4, $5, now())`,
        [
          eventId,
          state,
          counts?.imported ?? 0,
          counts?.rejected ?? 0,
          error?.slice(0, 1000) ?? null,
        ],
      )
      // The import itself succeeded or failed on its own terms; losing the
      // bookkeeping row must not change that verdict.
      .catch(() => undefined);
  }

  private async finish(
    meta: {
      eventId: string;
      adminId: string | null;
      source: 'csv' | 'raceresult';
      originLabel: string;
    },
    data: {
      total: number;
      counts: Counters;
      errors: { row: number; reason: string }[];
      warnings: { row: number; reason: string }[];
    },
  ): Promise<ImportReport> {
    const { counts, errors, warnings, total } = data;
    let batchId: string | null = null;
    try {
      const { rows } = await this.db.q<{ id: string }>(
        `INSERT INTO import_batches (
           event_id, admin_id, source, origin_label, total_rows,
           athletes_created, athletes_updated, entries_created, entries_updated,
           error_rows, errors)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING id`,
        [
          meta.eventId,
          meta.adminId,
          meta.source,
          meta.originLabel.slice(0, 500),
          total,
          counts.athletesCreated,
          counts.athletesUpdated,
          counts.entriesCreated,
          counts.entriesUpdated,
          errors.length,
          JSON.stringify(errors),
        ],
      );
      batchId = rows[0].id;
    } catch {
      // Migration 062 may not be applied yet. The roster landed either way, and
      // reporting the import as failed because its receipt could not be filed
      // would be worse than losing the receipt.
    }

    return {
      total,
      athletesCreated: counts.athletesCreated,
      athletesUpdated: counts.athletesUpdated,
      entriesCreated: counts.entriesCreated,
      entriesUpdated: counts.entriesUpdated,
      categoriesCreated: [...counts.categoriesCreated],
      errors,
      warnings,
      batchId,
    };
  }

  // The last few imports for one event, for the screen that ran them.
  async listBatches(eventId: string) {
    const { rows } = await this.db.q(
      `SELECT b.id, b.source, b.origin_label, b.total_rows,
              b.athletes_created, b.athletes_updated,
              b.entries_created, b.entries_updated, b.error_rows,
              b.errors, b.created_at, u.name AS admin_name
         FROM import_batches b
         LEFT JOIN users u ON u.id = b.admin_id
        WHERE b.event_id = $1
        ORDER BY b.created_at DESC LIMIT 10`,
      [eventId],
    );
    return rows;
  }
}
