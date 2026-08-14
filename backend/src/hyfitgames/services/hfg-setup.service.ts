import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { HfgDbService } from '../hfg-db.service';
import { HfgCacheService } from '../hfg-cache.service';
import {
  HfgRosterService,
  inferFormat,
  normalizeGender,
  normalizeMobile,
  parseContestDate,
  parseDob,
} from './hfg-roster.service';
import { teamNameColumn, teammatesColumn } from '../hfg.util';

/* Event setup for the admin console: create the event, shape its course and
 * categories, hold its roster.
 *
 * Everything here is written against the normalised `hyfit` schema (migrations
 * 056/057): an event has categories, a person is an `athletes` row reached
 * through `registrations`, and a bib belongs to a `category_entries` row. The
 * older admin handlers still address the pre-057 shape, which is why this is a
 * service of its own rather than edits scattered through the controller.
 */

const PUBLIC_STATUSES = ['draft', 'upcoming', 'live', 'completed', 'cancelled'];
const OPS_STATUSES = ['draft', 'ready', 'live', 'closed', 'archived'];
const FORMATS = ['singles', 'doubles', 'mixed_doubles', 'team'];
const GENDER_RULES = ['men', 'women', 'mixed', 'open'];
const RACE_STATUSES = ['REG', 'DNS', 'DNF', 'DQ', 'FIN'];
const ENTRY_STATUSES = [
  'pending_payment',
  'pending_partner',
  'confirmed',
  'waitlisted',
  'withdrawn',
  'disqualified',
];

export type CategoryInput = {
  name?: string;
  format?: string;
  gender_rule?: string | null;
  min_age?: number | null;
  max_age?: number | null;
  team_size_min?: number | null;
  team_size_max?: number | null;
  price_inr?: number | null;
  entry_cap?: number | null;
  schedule_block?: string | null;
  is_active?: boolean;
};

@Injectable()
export class HfgSetupService {
  constructor(
    private readonly db: HfgDbService,
    private readonly cache: HfgCacheService,
    private readonly roster: HfgRosterService,
  ) {}

  // ================================================================= events

  async getEvent(id: string) {
    const { rows } = await this.db.q(
      `SELECT e.*,
              (SELECT count(*)::int FROM registrations r WHERE r.event_id = e.id) AS registrations,
              (SELECT count(*)::int FROM category_entries c WHERE c.event_id = e.id) AS entries
         FROM events e WHERE e.id = $1`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException('Event not found');

    const [stations, categories, integration] = await Promise.all([
      this.db.q(
        `SELECT s.id, s.seq, s.name,
                (SELECT count(*)::int FROM splits sp WHERE sp.station_id = s.id) AS splits
           FROM stations s WHERE s.event_id = $1 ORDER BY s.seq`,
        [id],
      ),
      this.listCategories(id),
      this.getIntegration(id),
    ]);

    return {
      ...rows[0],
      stations: stations.rows,
      categories,
      integration,
    };
  }

  // Creates the public listing, its course and its categories in one call, and
  // optionally the operational face as well. Doing all four together is the
  // point: an event created without an operational record cannot be run from
  // the field apps, and one created without categories has nothing anyone can
  // enter — both were separate later steps that were easy to forget.
  async createEvent(body: {
    name?: string;
    edition?: number;
    city?: string;
    venue?: string;
    event_date?: string;
    timezone?: string;
    starts_at?: string | null;
    reg_opens_at?: string | null;
    reg_closes_at?: string | null;
    stations?: string[];
    categories?: (string | CategoryInput)[];
  }) {
    const name = String(body.name ?? '').trim();
    const city = String(body.city ?? '').trim();
    const edition = Number(body.edition);
    const eventDate = String(body.event_date ?? '').trim();

    if (name.length < 3)
      throw new BadRequestException('Event name is too short');
    if (city.length < 2) throw new BadRequestException('City is required');
    if (!Number.isInteger(edition) || edition <= 0)
      throw new BadRequestException('Edition must be a positive whole number');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate))
      throw new BadRequestException('Event date must be YYYY-MM-DD');

    const stations = (body.stations ?? [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (stations.length < 1 || stations.length > 12)
      throw new BadRequestException('An event needs between 1 and 12 stations');

    const categories = (body.categories ?? []).map((c) =>
      typeof c === 'string' ? { name: c } : c,
    );

    return this.db
      .tx(async (client) => {
        // `hyfit.events` dropped the DEFAULTs the old table carried, because a
        // judge-origin row has no public face and NULL is how it says so. This
        // creates the public face, so it states both values — otherwise the row
        // has neither face and hyfit_events_has_face rejects it.
        const { rows } = await client.query(
          `INSERT INTO events (name, edition, city, venue, event_date,
                               reg_opens_at, reg_closes_at, starts_at, timezone,
                               status, results_status, ops_status, origin)
           VALUES ($1,$2,$3,$4,$5::date,$6::timestamptz,$7::timestamptz,$8::timestamptz,
                   COALESCE($9,'Asia/Kolkata'),
                   -- ops_status is set for every event now. It used to be left
                   -- NULL until an admin pressed "Enable operations", which
                   -- gated an edition out of the staff screens; field ops keeps
                   -- no per-event record of its own any more, so there is
                   -- nothing left for that switch to turn on.
                   'upcoming','none','draft',
                   'hyfit')
           RETURNING *`,
          [
            name,
            edition,
            city,
            String(body.venue ?? '').trim() || null,
            eventDate,
            body.reg_opens_at || null,
            body.reg_closes_at || null,
            body.starts_at || null,
            body.timezone || null,
          ],
        );
        const event = rows[0];

        // The operational event, in hyfit_v2 (080), created in the same
        // transaction and pointed back at this listing.
        //
        // This is the ONLY place an event is created from the console, so it is
        // the only place that can guarantee the invariant everything downstream
        // assumes: a listing always has an operational row. Without it the event
        // would exist publicly and nowhere else — Operations would refuse to
        // attach RaceResult endpoints to it, no counter could be opened for it,
        // and it would never appear on a judge tablet.
        //
        // `ops_status` above stays for the platform's own reads; the field apps
        // read the hyfit_v2 row's `status`.
        await client.query(
          `INSERT INTO hyfit_v2.events
             (name, venue, starts_at, timezone, event_date, status, platform_event_id)
           VALUES ($1, $2, $3::timestamptz, COALESCE($4,'Asia/Kolkata'), $5::date, 'draft', $6)`,
          [
            name,
            String(body.venue ?? '').trim() || null,
            body.starts_at || null,
            body.timezone || null,
            eventDate,
            event.id,
          ],
        );

        for (let i = 0; i < stations.length; i++)
          await client.query(
            `INSERT INTO stations (event_id, seq, name) VALUES ($1,$2,$3)`,
            [event.id, i + 1, stations[i]],
          );

        for (const c of categories) {
          const v = this.categoryValues(c);
          await client.query(
            `INSERT INTO categories (event_id, name, format, gender_rule,
                                     min_age, max_age, team_size_min, team_size_max,
                                     price_inr, entry_cap, schedule_block)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (event_id, name) DO NOTHING`,
            [
              event.id,
              v.name,
              v.format,
              v.gender_rule,
              v.min_age,
              v.max_age,
              v.team_size_min,
              v.team_size_max,
              v.price_inr,
              v.entry_cap,
              v.schedule_block,
            ],
          );
        }
        return event;
      })
      .then(async (event) => {
        await this.cache.invalidateEvent(event.id);
        return event;
      })
      .catch((err) => {
        throw this.explainEvent(err, city, edition);
      });
  }

  async updateEvent(id: string, body: Record<string, unknown>) {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const push = (col: string, value: unknown, cast = '') => {
      params.push(value);
      sets.push(`${col} = $${params.length}${cast}`);
    };

    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
    const text = (k: string) => String(body[k] ?? '').trim();

    if (has('name')) {
      if (text('name').length < 3)
        throw new BadRequestException('Event name is too short');
      push('name', text('name'));
    }
    if (has('venue')) push('venue', text('venue') || null);
    if (has('city')) {
      // The public block travels together (hyfit_events_public_block), so these
      // three can be corrected but never emptied — clearing one would unlist
      // the event through a validation error nobody asked for.
      if (text('city').length < 2)
        throw new BadRequestException('City cannot be empty');
      push('city', text('city'));
    }
    if (has('edition')) {
      const edition = Number(body.edition);
      if (!Number.isInteger(edition) || edition <= 0)
        throw new BadRequestException(
          'Edition must be a positive whole number',
        );
      push('edition', edition);
    }
    if (has('event_date')) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text('event_date')))
        throw new BadRequestException('Event date must be YYYY-MM-DD');
      push('event_date', text('event_date'), '::date');
    }
    if (has('status')) {
      if (!PUBLIC_STATUSES.includes(text('status')))
        throw new BadRequestException(
          `Status must be one of ${PUBLIC_STATUSES.join(', ')}`,
        );
      push('status', text('status'));
    }
    if (has('ops_status')) {
      if (!OPS_STATUSES.includes(text('ops_status')))
        throw new BadRequestException(
          `Ops status must be one of ${OPS_STATUSES.join(', ')}`,
        );
      push('ops_status', text('ops_status'));
    }
    if (has('timezone')) push('timezone', text('timezone') || 'Asia/Kolkata');
    for (const k of ['reg_opens_at', 'reg_closes_at', 'starts_at', 'ends_at'])
      if (has(k)) push(k, body[k] || null, '::timestamptz');

    if (!sets.length) throw new BadRequestException('Nothing to update');
    sets.push('updated_at = now()');

    const { rows } = await this.db
      .q(
        `UPDATE events SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        params,
      )
      .catch((err) => {
        throw this.explainEvent(
          err,
          String(body.city ?? ''),
          Number(body.edition),
        );
      });
    if (!rows[0]) throw new NotFoundException('Event not found');
    await this.cache.invalidateEvent(id);
    return rows[0];
  }

  private explainEvent(err: unknown, city: string, edition: number) {
    const e = err as { code?: string; constraint?: string };
    if (e?.code === '23505' && e.constraint?.includes('city_edition'))
      return new ConflictException(
        `${city} edition ${edition} already exists — every edition of a city is numbered once`,
      );
    return err as Error;
  }

  // =============================================================== stations

  // Replaces the course in one call: the payload is the stations in order, each
  // either an existing id (kept, possibly renamed or moved) or a new name.
  //
  // A station that already has splits recorded against it is never deleted —
  // `splits.station_id` cascades, so removing station 3 on race morning would
  // silently delete every split recorded at it. Those are refused by name.
  async replaceStations(
    eventId: string,
    stations: { id?: string | null; name?: string }[],
  ) {
    const wanted = (stations ?? []).map((s) => ({
      id: s.id || null,
      name: String(s.name ?? '').trim(),
    }));
    if (!wanted.length || wanted.length > 12)
      throw new BadRequestException('An event needs between 1 and 12 stations');
    if (wanted.some((s) => s.name.length < 2))
      throw new BadRequestException('Every station needs a name');

    return this.db.tx(async (client) => {
      const { rows: current } = await client.query<{
        id: string;
        name: string;
        splits: number;
      }>(
        `SELECT s.id, s.name,
                (SELECT count(*)::int FROM splits sp WHERE sp.station_id = s.id) AS splits
           FROM stations s WHERE s.event_id = $1`,
        [eventId],
      );

      const keep = new Set(wanted.map((s) => s.id).filter(Boolean) as string[]);
      const doomed = current.filter((s) => !keep.has(s.id));
      const timed = doomed.filter((s) => s.splits > 0);
      if (timed.length)
        throw new ConflictException(
          `Cannot remove ${timed
            .map(
              (s) =>
                `"${s.name}" (${s.splits} split${s.splits === 1 ? '' : 's'} recorded)`,
            )
            .join(', ')} — deleting a station deletes the times recorded at it`,
        );
      if (doomed.length)
        await client.query(`DELETE FROM stations WHERE id = ANY($1::uuid[])`, [
          doomed.map((s) => s.id),
        ]);

      // hyfit_stations_event_seq is unique, so reordering has to move the kept
      // rows out of the way before it can put them back — seq must stay > 0, so
      // the parking space is above the range rather than negative.
      if (keep.size)
        await client.query(
          `UPDATE stations SET seq = seq + 1000 WHERE event_id = $1 AND id = ANY($2::uuid[])`,
          [eventId, [...keep]],
        );

      for (const [i, s] of wanted.entries()) {
        if (s.id)
          await client.query(
            `UPDATE stations SET seq = $3, name = $4 WHERE id = $2 AND event_id = $1`,
            [eventId, s.id, i + 1, s.name],
          );
        else
          await client.query(
            `INSERT INTO stations (event_id, seq, name) VALUES ($1,$2,$3)`,
            [eventId, i + 1, s.name],
          );
      }

      await this.cache.invalidateEvent(eventId);
      const { rows } = await client.query(
        `SELECT id, seq, name FROM stations WHERE event_id = $1 ORDER BY seq`,
        [eventId],
      );
      return rows;
    });
  }

  // ============================================================= categories

  async listCategories(eventId: string) {
    const { rows } = await this.db.q(
      // Teams are not stored, they are derived: one per club whose entry count
      // lands inside this category's own size band (migration 065). "Unpaired"
      // is the complement — no club, or a club group that is the wrong size to
      // race as a team. A singles category has neither, hence the CASE.
      `SELECT c.*,
              (SELECT count(*)::int FROM category_entries e WHERE e.category_id = c.id) AS entries,
              CASE WHEN c.team_size_max > 1 THEN (
                SELECT count(*)::int FROM (
                  SELECT 1 FROM category_entries e
                   WHERE e.category_id = c.id AND club_key(e.club) <> ''
                   GROUP BY club_key(e.club)
                  HAVING count(*) BETWEEN c.team_size_min AND c.team_size_max
                ) built
              ) ELSE 0 END AS teams,
              CASE WHEN c.team_size_max > 1 THEN (
                SELECT count(*)::int FROM category_entries e
                 WHERE e.category_id = c.id
                   AND (club_key(e.club) = ''
                        OR (SELECT count(*) FROM category_entries pe
                             WHERE pe.category_id = c.id
                               AND club_key(pe.club) = club_key(e.club))
                           NOT BETWEEN c.team_size_min AND c.team_size_max)
              ) ELSE 0 END AS unpaired
         FROM categories c
        WHERE c.event_id = $1
        ORDER BY c.name`,
      [eventId],
    );
    // What an admin still owes on each category. 056 leaves price, cap and
    // eligibility NULL on purpose — they are not derivable from a roster — and
    // a NULL gender_rule means undecided, NOT "anyone may enter", so the screen
    // has to be able to say which ones are still blank.
    return rows.map((c: any) => ({
      ...c,
      setup_gaps: [
        c.price_inr === null ? 'price' : null,
        c.entry_cap === null ? 'entry cap' : null,
        c.gender_rule === null ? 'gender rule' : null,
        c.min_age === null && c.max_age === null ? 'age limits' : null,
      ].filter(Boolean),
    }));
  }

  // Normalises a category payload against 056's constraints, so the format and
  // the team sizes cannot disagree — `hyfit_categories_format_sizes` would
  // reject that, and an admin should not have to know the rule to save a form.
  private categoryValues(c: CategoryInput) {
    const name = String(c.name ?? '').trim();
    if (name.length < 1)
      throw new BadRequestException('A category needs a name');

    let format = String(c.format ?? '').trim();
    if (!format) format = inferFormat(name).format;
    if (!FORMATS.includes(format))
      throw new BadRequestException(
        `Format must be one of ${FORMATS.join(', ')}`,
      );

    let min = 1;
    let max = 1;
    if (format === 'doubles' || format === 'mixed_doubles') {
      min = 2;
      max = 2;
    } else if (format === 'team') {
      // 8, not 4. The old cap was `hyfit.teams.expected_size`, whose CHECK
      // stopped at 4 — a category configured for 5 could never have a team
      // built in it, so the tighter of the two rules was enforced here. That
      // table is gone (migration 065) and a team is now however many entries
      // share a club, so `hyfit.categories`' own 1..8 is the only rule left.
      min = Math.min(Math.max(Number(c.team_size_min ?? 2), 2), 8);
      max = Math.min(Math.max(Number(c.team_size_max ?? min), min), 8);
    }

    const gender_rule = c.gender_rule ? String(c.gender_rule) : null;
    if (gender_rule && !GENDER_RULES.includes(gender_rule))
      throw new BadRequestException(
        `Gender rule must be one of ${GENDER_RULES.join(', ')}`,
      );

    const num = (v: unknown) =>
      v === null || v === undefined || v === '' ? null : Number(v);
    const min_age = num(c.min_age);
    const max_age = num(c.max_age);
    if (min_age !== null && max_age !== null && min_age > max_age)
      throw new BadRequestException('Minimum age is above the maximum age');

    return {
      name,
      format,
      gender_rule,
      min_age,
      max_age,
      team_size_min: min,
      team_size_max: max,
      price_inr: num(c.price_inr),
      entry_cap: num(c.entry_cap),
      schedule_block: String(c.schedule_block ?? '').trim() || null,
      is_active: c.is_active ?? true,
    };
  }

  async createCategory(eventId: string, body: CategoryInput) {
    const v = this.categoryValues(body);
    const { rows } = await this.db
      .q(
        `INSERT INTO categories (event_id, name, format, gender_rule, min_age, max_age,
                                 team_size_min, team_size_max, price_inr, entry_cap,
                                 schedule_block, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          eventId,
          v.name,
          v.format,
          v.gender_rule,
          v.min_age,
          v.max_age,
          v.team_size_min,
          v.team_size_max,
          v.price_inr,
          v.entry_cap,
          v.schedule_block,
          v.is_active,
        ],
      )
      .catch((err) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException(
            `This event already has a category called "${v.name}"`,
          );
        throw err;
      });
    await this.cache.invalidateEvent(eventId);
    return rows[0];
  }

  async updateCategory(id: string, body: CategoryInput) {
    const { rows: existing } = await this.db.q(
      `SELECT * FROM categories WHERE id = $1`,
      [id],
    );
    if (!existing[0]) throw new NotFoundException('Category not found');

    // Merge onto the stored row so a partial edit cannot reset a format or a
    // price nobody touched.
    const v = this.categoryValues({ ...existing[0], ...body });

    // Changing the format used to be blocked while teams existed in the
    // category, because a stored team had been built to the old size and the
    // new one might not admit it. Teams are derived from the club now
    // (migration 065), so there is nothing to invalidate — the same roster
    // simply regroups under the new size band. What DOES go stale is the
    // scoring: any team placing already computed was ranked against the old
    // grouping, so recompute the event after a format change.
    const { rows } = await this.db.q(
      `UPDATE categories SET name = $2, format = $3, gender_rule = $4, min_age = $5,
              max_age = $6, team_size_min = $7, team_size_max = $8, price_inr = $9,
              entry_cap = $10, schedule_block = $11, is_active = $12, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [
        id,
        v.name,
        v.format,
        v.gender_rule,
        v.min_age,
        v.max_age,
        v.team_size_min,
        v.team_size_max,
        v.price_inr,
        v.entry_cap,
        v.schedule_block,
        v.is_active,
      ],
    );
    await this.cache.invalidateEvent(existing[0].event_id);
    return rows[0];
  }

  async deleteCategory(id: string) {
    const { rows } = await this.db.q(
      `SELECT c.event_id, c.name,
              (SELECT count(*)::int FROM category_entries e WHERE e.category_id = c.id) AS entries
         FROM categories c WHERE c.id = $1`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException('Category not found');
    if (rows[0].entries > 0)
      throw new ConflictException(
        `"${rows[0].name}" has ${rows[0].entries} entr${rows[0].entries === 1 ? 'y' : 'ies'} — move or remove them first`,
      );
    await this.db.q(`DELETE FROM categories WHERE id = $1`, [id]);
    await this.cache.invalidateEvent(rows[0].event_id);
    return { ok: true };
  }

  // ================================================================= roster

  async listRoster(eventId: string, search?: string) {
    const like = search ? `%${search}%` : '%';
    const { rows } = await this.db.q(
      `SELECT e.id AS entry_id, e.bib, e.wave, e.timeslot,
              to_char(e.contest_date, 'YYYY-MM-DD') AS contest_date,
              e.club, e.race_status, e.entry_status,
              e.start_time, e.origin,
              c.id AS category_id, c.name AS category, c.format,
              a.id AS athlete_id, a.athlete_code, a.full_name, a.gender, a.dob,
              a.city, a.claim_status, a.profile_complete,
              a.mobile,
              r.id AS registration_id, r.status AS registration_status,
              ${teamNameColumn('e')},
              ${teammatesColumn('e', { withBib: true })}
         FROM category_entries e
         JOIN registrations r ON r.id = e.registration_id
         JOIN athletes a ON a.id = r.athlete_id
         LEFT JOIN categories c ON c.id = e.category_id
        WHERE e.event_id = $1
          AND (a.full_name ILIKE $2 OR e.bib ILIKE $2 OR a.mobile ILIKE $2
               OR c.name ILIKE $2 OR e.club ILIKE $2)
        ORDER BY length(e.bib), e.bib`,
      [eventId, like],
    );
    return rows;
  }

  // Adds one athlete by hand — the same four rows an import writes, so a
  // walk-up entry and an imported one are indistinguishable afterwards.
  async addEntry(
    eventId: string,
    body: {
      full_name?: string;
      mobile?: string;
      bib?: string;
      category_id?: string;
      category?: string;
      wave?: string;
      timeslot?: string;
      contest_date?: string;
      club?: string;
      gender?: string;
      dob?: string;
    },
  ) {
    const full_name = String(body.full_name ?? '').trim();
    const bib = String(body.bib ?? '').trim();
    if (full_name.length < 2)
      throw new BadRequestException('A name is required');
    if (!/^\d+$/.test(bib))
      throw new BadRequestException('A bib must be a number');
    if (!body.category_id && !String(body.category ?? '').trim())
      throw new BadRequestException('A category is required');

    // An import warns on a number it cannot read and carries on, because there
    // are thirty-nine other rows. One typed entry has no such report to read, so
    // it is rejected rather than saved as an athlete who cannot sign in.
    const rawMobile = String(body.mobile ?? '').trim();
    const mobile = normalizeMobile(rawMobile);
    if (rawMobile && !mobile)
      throw new BadRequestException(
        `"${rawMobile}" is not a mobile number an OTP can be sent to — 10 digits, or a country code and up to 15`,
      );

    // Same reasoning as the mobile above: one typed entry has no import report
    // to read, so an unreadable date is said now rather than silently dropped.
    const rawContestDate = String(body.contest_date ?? '').trim();
    const contestDate = rawContestDate ? parseContestDate(rawContestDate) : null;
    if (rawContestDate && !contestDate)
      throw new BadRequestException(
        `"${rawContestDate}" is not a date — use YYYY-MM-DD, DD/MM/YYYY or DD.MM.YYYY`,
      );

    const counts = {
      athletesCreated: 0,
      athletesUpdated: 0,
      entriesCreated: 0,
      entriesUpdated: 0,
      categoriesCreated: new Set<string>(),
    };

    const entryId = await this.db
      .tx(async (client) => {
        const id = await this.roster.upsertRow(
          client,
          eventId,
          {
            full_name,
            mobile,
            gender: normalizeGender(body.gender),
            dob: parseDob(body.dob),
            bib,
            category_id: body.category_id || null,
            category: body.category || null,
            wave: String(body.wave ?? '').trim() || null,
            timeslot: String(body.timeslot ?? '').trim() || null,
            contest_date: contestDate,
            club: String(body.club ?? '').trim() || null,
          },
          'hyfit',
          counts,
          new Map(),
        );

        return id;
      })
      .catch((err) => {
        const e = err as { code?: string; constraint?: string };
        if (e?.code === '23505' && e.constraint?.includes('event_bib'))
          throw new ConflictException(
            `Bib ${bib} already belongs to another athlete at this event`,
          );
        if (e?.code === '23505')
          throw new ConflictException(
            'That athlete is already entered in this category',
          );
        throw err;
      });

    await this.cache.invalidateEvent(eventId);
    return { entry_id: entryId, created: counts.entriesCreated > 0 };
  }

  async updateEntry(entryId: string, body: Record<string, unknown>) {
    const sets: string[] = [];
    const params: unknown[] = [entryId];
    const push = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

    if (has('bib')) {
      const bib = String(body.bib ?? '').trim();
      if (!/^\d+$/.test(bib))
        throw new BadRequestException('A bib must be a number');
      push('bib', bib);
    }
    if (has('wave')) push('wave', String(body.wave ?? '').trim() || null);
    if (has('timeslot'))
      push('timeslot', String(body.timeslot ?? '').trim() || null);
    if (has('contest_date')) {
      const raw = String(body.contest_date ?? '').trim();
      const parsed = raw ? parseContestDate(raw) : null;
      // Typed by hand, so it is rejected rather than quietly dropped: unlike an
      // import there is no warning list for the organiser to read afterwards.
      if (raw && !parsed)
        throw new BadRequestException(
          `"${raw}" is not a date — use YYYY-MM-DD, DD/MM/YYYY or DD.MM.YYYY`,
        );
      push('contest_date', parsed);
    }
    if (has('club')) push('club', String(body.club ?? '').trim() || null);
    if (has('category_id')) push('category_id', body.category_id || null);
    if (has('race_status')) {
      if (!RACE_STATUSES.includes(String(body.race_status)))
        throw new BadRequestException(
          `Race status must be one of ${RACE_STATUSES.join(', ')}`,
        );
      push('race_status', body.race_status);
    }
    if (has('entry_status')) {
      if (!ENTRY_STATUSES.includes(String(body.entry_status)))
        throw new BadRequestException(
          `Entry status must be one of ${ENTRY_STATUSES.join(', ')}`,
        );
      push('entry_status', body.entry_status);
    }
    if (has('start_time')) push('start_time', body.start_time || null);

    // The number is validated before anything is written, so a typo cannot
    // half-apply the row: `normalizeMobile` answers null both for "cleared" and
    // for "nine digits", and silently storing null for the second is how an
    // edit looks like it did nothing.
    let mobile: string | null = null;
    if (has('mobile')) {
      const raw = String(body.mobile ?? '').trim();
      mobile = normalizeMobile(raw);
      if (raw && !mobile)
        throw new BadRequestException(
          `"${raw}" is not a mobile number an OTP can be sent to — 10 digits, or a country code and up to 15`,
        );
    }

    const entry = await this.db.tx(async (client) => {
      // Mobile lives on `athletes`, not `category_entries`, so it needs a
      // separate update reached through the registration — and the number IS
      // the login (066), so the claim state has to move with it or
      // `hyfit_athletes_claim_agrees` rejects the row. Giving a start-list
      // person a number is the organiser handing them a way in; taking it away
      // hands the profile back to the organiser to maintain.
      if (has('mobile')) {
        const { rows: who } = await client.query<{
          id: string;
          reachable: boolean;
        }>(
          `SELECT a.id, (a.person_source_id IS NOT NULL) AS reachable
             FROM category_entries e
             JOIN registrations r ON r.id = e.registration_id
             JOIN athletes a      ON a.id = r.athlete_id
            WHERE e.id = $1`,
          [entryId],
        );
        if (!who[0]) throw new NotFoundException('Entry not found');
        // hyfit_athletes_identity: somebody has to be able to find this person.
        if (!mobile && !who[0].reachable)
          throw new BadRequestException(
            'This athlete has no timing-system id, so the mobile is the only way to reach them — it cannot be cleared',
          );
        await client.query(
          `UPDATE athletes
              SET mobile       = $2,
                  claim_status = CASE WHEN $2::text IS NULL
                                      THEN 'unclaimed' ELSE 'claimed' END,
                  is_managed   = $2::text IS NULL,
                  updated_at   = now()
            WHERE id = $1`,
          [who[0].id, mobile],
        );
      }

      // Wristband and transponder are deliberately NOT settable here. They are
      // check-in facts, and check-in records them in RaceResult — a console
      // edit that wrote them to Postgres would be a second source of truth that
      // the counter and the judge app never see. Change them in RaceResult.
      if (has('wristband') || has('transponder') || has('transponder1')) {
        throw new BadRequestException(
          'Wristband and transponder codes are held in RaceResult, not here. Change them in RaceResult.',
        );
      }

      if (!sets.length) {
        if (has('mobile')) {
          const { rows } = await client.query(
            `SELECT id, event_id, bib, category_id, race_status, entry_status
               FROM category_entries WHERE id = $1`,
            [entryId],
          );
          if (!rows[0]) throw new NotFoundException('Entry not found');
          return rows[0];
        }
        throw new BadRequestException('Nothing to update');
      }
      sets.push('updated_at = now()');

      const { rows } = await client
        .query(
          `UPDATE category_entries SET ${sets.join(', ')} WHERE id = $1
           RETURNING id, event_id, bib, category_id, race_status, entry_status`,
          params,
        )
        .catch((err) => {
          if ((err as { code?: string }).code === '23505')
            throw new ConflictException(
              'That bib or category is already taken at this event',
            );
          throw err;
        });
      if (!rows[0]) throw new NotFoundException('Entry not found');
      return rows[0];
    });

    // After the commit, so a read between the two cannot re-cache the old row.
    await this.cache.invalidateEvent(entry.event_id);
    return entry;
  }

  // Removes one entry — the person and their other entries stay. The
  // registration goes only when it has no entries left, because a registration
  // with none is an athlete listed at an event they are not in.
  async deleteEntry(entryId: string) {
    return this.db.tx(async (client) => {
      const { rows } = await client.query(
        `DELETE FROM category_entries WHERE id = $1
         RETURNING event_id, registration_id`,
        [entryId],
      );
      if (!rows[0]) throw new NotFoundException('Entry not found');
      await client.query(
        `DELETE FROM registrations r
          WHERE r.id = $1
            AND NOT EXISTS (SELECT 1 FROM category_entries e WHERE e.registration_id = r.id)`,
        [rows[0].registration_id],
      );
      await this.cache.invalidateEvent(rows[0].event_id);
      return { ok: true };
    });
  }

  // ================================================================== teams
  //
  // There are none to manage. A team is the entries sharing a club inside one
  // group-format category (migration 065), so it is created by editing an
  // entry's club and disbanded by clearing it — `updateEntry` below is the
  // whole API. The build/disband endpoints that used to live here maintained a
  // second, contradictory answer to "who is this athlete racing with": the
  // check-in and judge apps never read them, and grouped by club regardless.

  // =========================================================== integration
  //
  // The RaceResult participant endpoint lives on `event_configs` — the SAME row
  // the check-in and judge apps read. It deliberately does not get a copy of its
  // own on the platform side: two endpoints for one event is the split the
  // schema merge exists to remove, and they would disagree silently about which
  // roster is real.
  //
  // The last-pull summary comes from `sync_runs`, which is also where the field
  // module's own sync records itself, so the Roster tab and the Operations
  // screen report the same history.

  async getIntegration(eventId: string) {
    // The endpoint row lives in `hyfit_v2.raceresults_endpoints` (080), reached
    // through the field event that points at this platform event. Still ONE row
    // shared with the field apps — see the note above. `eventId` here is a
    // platform event id, which is why the join runs through platform_event_id
    // rather than reading the table directly.
    //
    // A missing table or a field-only event both come back as null, which is
    // the right answer for the console in both cases.
    const config = await this.db
      .q(
        `SELECT c.id, c.version, c.state,
                c.bib_lookup_url AS participant_api_url,
                c.participant_mapping
           FROM hyfit_v2.events e
           JOIN hyfit_v2.raceresults_endpoints c ON c.event_id = e.id
          WHERE e.platform_event_id = $1
          ORDER BY (c.state = 'published') DESC, c.version DESC
          LIMIT 1`,
        [eventId],
      )
      .catch(() => ({ rows: [] as any[] }));
    if (!config.rows[0]) return null;

    const sync = await this.db
      .q(
        `SELECT state, error, COALESCE(finished_at, started_at) AS at
           FROM sync_runs
          WHERE event_id = $1 AND kind = 'participants'
          ORDER BY started_at DESC LIMIT 1`,
        [eventId],
      )
      .catch(() => ({ rows: [] as any[] }));

    return {
      event_id: eventId,
      config_version: config.rows[0].version,
      config_state: config.rows[0].state,
      participant_api_url: config.rows[0].participant_api_url || null,
      participant_mapping: config.rows[0].participant_mapping ?? {},
      last_sync_at: sync.rows[0]?.at ?? null,
      last_sync_state: sync.rows[0]?.state ?? null,
      last_sync_error: sync.rows[0]?.error ?? null,
    };
  }

  // Saving publishes a new config version rather than editing the live one, so
  // the field apps' draft/publish contract still holds and a change is
  // attributable. Everything not being edited is carried forward from the
  // current version — an organiser setting a roster URL must not silently reset
  // the photo policy or the media retention window.
  async saveIntegration(
    eventId: string,
    body: { participant_api_url?: string; participant_mapping?: unknown },
    adminId: string | null,
  ) {
    const url = String(body.participant_api_url ?? '').trim();
    if (url && !/^https?:\/\//i.test(url))
      throw new BadRequestException(
        'The participant endpoint must be a complete http(s) URL',
      );
    let mapping: unknown = body.participant_mapping ?? {};
    if (typeof mapping === 'string') {
      try {
        mapping = JSON.parse(mapping || '{}');
      } catch {
        throw new BadRequestException('The field mapping is not valid JSON');
      }
    }

    await this.db.tx(async (client) => {
      // The field event this listing is run as. Without one there is nothing to
      // hang an endpoint off — an event has to exist operationally before it can
      // have a roster pulled into it.
      const { rows: fieldRows } = await client.query<{ id: string }>(
        `SELECT id FROM hyfit_v2.events WHERE platform_event_id = $1`,
        [eventId],
      );
      const fieldEventId = fieldRows[0]?.id;
      if (!fieldEventId)
        throw new BadRequestException(
          'This event has no operational record yet. Create it in Event Control before setting a roster endpoint.',
        );

      const { rows: prev } = await client.query(
        `SELECT * FROM hyfit_v2.raceresults_endpoints WHERE event_id = $1
          ORDER BY version DESC LIMIT 1`,
        [fieldEventId],
      );
      const p = prev[0] ?? {};

      // Retire first: hyfit_v2_endpoints_one_published permits a single
      // published row, so this cannot be reordered with the insert below.
      await client.query(
        `UPDATE hyfit_v2.raceresults_endpoints SET state = 'retired', updated_at = now()
          WHERE event_id = $1 AND state = 'published'`,
        [fieldEventId],
      );
      // Everything not being edited here is carried forward: an organiser
      // setting a roster URL must not silently reset the update endpoint, the
      // transponder lookup or the check-in window.
      await client.query(
        `INSERT INTO hyfit_v2.raceresults_endpoints (
           event_id, version, state, bib_lookup_url, update_url,
           map_lookup_url, map_lookup_param, map_lookup_key,
           results_url,
           participant_mapping, update_mapping, results_mapping,
           declaration_text, declaration_version,
           checkin_window_enabled, checkin_opens_before_minutes,
           checkin_closes_after_minutes, published_at, published_by)
         VALUES ($1,
                 COALESCE((SELECT max(version) FROM hyfit_v2.raceresults_endpoints WHERE event_id = $1), 0) + 1,
                 'published', $2, COALESCE($3,''),
                 COALESCE($4,''), COALESCE($5,''), COALESCE($6,'transponder'),
                 COALESCE($15,''),
                 $7::jsonb, COALESCE($8::jsonb,'{}'::jsonb), COALESCE($16::jsonb,'{}'::jsonb),
                 COALESCE($9, 'I confirm that my participant details are correct and that I have received the assigned race equipment.'),
                 COALESCE($10, 1), COALESCE($11, false), COALESCE($12, 240), $13,
                 now(),
                 -- adminId IS a hyfit_v2.users id: the console authenticates
                 -- against that table too since 080, so no translation is
                 -- needed and published_by takes it directly.
                 $14)`,
        [
          fieldEventId,
          url,
          p.update_url ?? null,
          p.map_lookup_url ?? null,
          p.map_lookup_param ?? null,
          p.map_lookup_key ?? null,
          JSON.stringify(mapping ?? {}),
          p.update_mapping ? JSON.stringify(p.update_mapping) : null,
          p.declaration_text ?? null,
          p.declaration_version ?? null,
          p.checkin_window_enabled ?? null,
          p.checkin_opens_before_minutes ?? null,
          p.checkin_closes_after_minutes ?? null,
          adminId,
          // Carried forward like the rest: setting a roster URL here must not
          // retire the standings endpoint somebody published on Operations.
          p.results_url ?? null,
          p.results_mapping ? JSON.stringify(p.results_mapping) : null,
        ],
      );
    });

    return this.getIntegration(eventId);
  }
}
