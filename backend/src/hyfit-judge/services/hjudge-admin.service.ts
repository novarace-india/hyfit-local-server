import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { HjudgeDbService } from '../hjudge-db.service';
import { HjudgeUser } from '../hjudge-auth.guard';
import {
  HJUDGE_APP_ROLES,
  HJUDGE_CHECKIN_STAGES,
  HJUDGE_PIN_PATTERN,
  HJUDGE_STAFF_ROLES,
  HJUDGE_STAGE_ROLES,
} from '../hjudge-session.util';
import { HjudgeRaceResultService } from './hjudge-raceresult.service';
import { HjudgeResultsService } from './hjudge-results.service';
import { HjudgeCacheService } from '../hjudge-cache.service';
import { normaliseEndDate } from '../hjudge-event-dates.util';
import { hjudgeSyncConfig } from '../hjudge-sync.config';
import {
  resolveUpdateField,
  updateMappingProblems,
} from '../hjudge-update-mapping.util';

@Injectable()
export class HjudgeAdminService {
  private readonly logger = new Logger(HjudgeAdminService.name);

  constructor(
    private readonly db: HjudgeDbService,
    private readonly raceResult: HjudgeRaceResultService,
    private readonly results: HjudgeResultsService,
    private readonly cache: HjudgeCacheService,
  ) {}

  /**
   * The field event id, given either id for the same event.
   *
   * `/hyfitgames/admin/events/:id/...` is one URL serving screens on both sides
   * of the split: the event page reads the athlete platform (roster,
   * categories, entries), while Operations and Team read field ops. Since 080
   * those are two rows with two ids, and the id in the URL is whichever one the
   * link that got you there happened to know — the platform's, for an event
   * reached from the athlete console; the field's, for one reached from the
   * event picker.
   *
   * Rather than make every link agree, both are accepted here and resolved to
   * the one this module works in. Returns null for an id that is neither, which
   * the caller reports as a missing event rather than silently widening to the
   * session's own event — the failure that would otherwise write one event's
   * configuration onto another.
   */
  async resolveEventId(id: string): Promise<string | null> {
    const candidate = String(id ?? '').trim();
    // Checked before it reaches Postgres: a non-uuid is a 400 from the driver
    // rather than a row that does not exist, and the two want different answers.
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        candidate,
      )
    )
      return null;

    const found = await this.db.q<{ id: string }>(
      // Its own id first: a field event always answers as itself, so an id that
      // is somehow both can never resolve to the wrong row.
      `SELECT id FROM events WHERE id = $1
       UNION ALL
       SELECT id FROM events WHERE platform_event_id = $1
       LIMIT 1`,
      [candidate],
    );
    return found.rows[0]?.id ?? null;
  }

  async getOverview(eventId: string) {
    const result = await this.db.q(
      `SELECT e.id, e.name, e.venue, e.status,
        (SELECT version FROM raceresults_endpoints
          WHERE event_id = e.id AND state = 'published') AS "configVersion",
        (SELECT count(*)::int FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE u.event_id = e.id AND u.role = 'judge' AND s.revoked_at IS NULL
            AND s.expires_at > now() AND s.last_seen_at > now() - interval '5 minutes') AS "activeJudges"
       FROM events e WHERE e.id = $1`,
      [eventId],
    );
    const overview = result.rows[0] ?? null;
    if (!overview) return { overview: null };

    // Both athlete counts come from the start list, in one read.
    //
    // The roster used to be counted in Postgres, off the platform's imported
    // entries — a different number from the one the counters and tablets are
    // actually working against, and the one that would be wrong on the day. The
    // feed is the field's roster, so the field's dashboard counts it.
    //
    // Null rather than 0 when the feed cannot be read: "nobody yet" and "we
    // could not ask" are different things on an ops dashboard, and only one of
    // them means somebody should go and look at the integration.
    overview.participants = null;
    overview.checkedIn = null;
    try {
      const config = await this.raceResult.loadConfig(eventId);
      if (this.raceResult.isConfigured(config)) {
        const roster = await this.raceResult.fetchFullRoster(config, eventId);
        overview.participants = roster.entries.length;
        overview.checkedIn = roster.entries.filter(
          (entry) => entry.stages.STAGE_1_WRISTBAND,
        ).length;
      }
    } catch {
      /* Reported as unknown; the rest of the strip is still worth showing. */
    }
    return { overview };
  }

  // Event Control manages the OPERATIONAL event, in hyfit_v2.events. An event
  // that is also listed publicly has a second row on the athlete platform, in
  // hyfit.events, joined by platform_event_id — two rows because the two
  // schemas are separable and most operational events are never listed at all.
  //
  // They are not a copy of each other, and this returns only the operational
  // one. The public face — city, edition, results status, the entry count — is
  // the athlete platform's, and the console fetches it from the platform's own
  // endpoint and merges the two lists on platform_event_id. Joining across the
  // schemas here would have been a second way to read the same facts, answering
  // slightly differently, which is the thing this whole cutover is removing.
  //
  // `name` is on both rows, deliberately: an ops label ("KTPO Day 1") and a
  // public title ("HYFIT Bengaluru 2026") are different sentences.
  async listEvents() {
    const result = await this.db.q(
      // `results_mode` rides along so the list can show — and change — what
      // each event is publishing without a call per row. It is read here and
      // written only through PUT /admin/results/mode, which owns the column.
      // The two dates leave here as plain `YYYY-MM-DD` strings, for the same
      // reason the public route does it (see HjudgePublicController.events):
      // node-pg turns a `date` into a JS Date at LOCAL midnight, JSON writes
      // that as a UTC instant, and every reader in India is shown the day
      // before the event. `to_char` keeps a calendar day a calendar day.
      `SELECT id, name, COALESCE(venue,'') AS venue, starts_at, ends_at,
              timezone, status, is_active,
              to_char(event_date, 'YYYY-MM-DD') AS event_date,
              to_char(event_end_date, 'YYYY-MM-DD') AS event_end_date,
              results_mode, results_stored_at, delivery_mode,
              platform_event_id AS "platformEventId",
              created_at, updated_at
       FROM events
       ORDER BY is_active DESC, starts_at DESC NULLS LAST, created_at DESC`,
    );
    // `role` rides along because the Events screen shows a different primary
    // action on each deployment — prod CREATES an event, a venue laptop PAIRS
    // with one that already exists on prod — and the alternative is a second
    // round trip whose only purpose is to discover which button to draw. It is
    // a deployment constant, not a per-request fact.
    return {
      events: result.rows,
      role: hjudgeSyncConfig.nodeRole,
    };
  }

  /**
   * A field-only event: something the crew runs that is never listed publicly —
   * a test event, a training day, a closed heat.
   *
   * It creates the operational row and NOTHING else. An event the public can
   * enter is created from the console's own form (POST
   * /api/hyfitgames/admin/events), which writes the listing, its stations, its
   * categories AND the operational row together. Reproducing half of that here
   * would give one console two ways to make an event, one of which produces a
   * listing with no stations and no categories — and then two answers to which
   * of them is real. There is one creation path per kind of event, on purpose.
   */
  async createEvent(
    data: {
      name: string;
      venue?: string;
      startsAt?: string;
      endsAt?: string;
      timezone?: string;
      eventDate?: string;
      eventEndDate?: string;
      deliveryMode?: string;
    },
    user: HjudgeUser,
  ) {
    // Anything but a deliberate 'offline' is online. The column has a CHECK
    // that would reject a typo, but rejecting it HERE means the operator gets
    // "delivery mode must be…" rather than a constraint name, and a form that
    // simply does not send the field keeps working.
    const deliveryMode = data.deliveryMode === 'offline' ? 'offline' : 'online';

    const created = await this.db.q<{ id: string }>(
      `INSERT INTO events(
         name, venue, starts_at, ends_at, timezone,
         event_date, event_end_date, status, delivery_mode)
       VALUES($1, nullif($2,''), $3, $4, $5, $6::date, $7::date, 'draft', $8)
       RETURNING id`,
      [
        data.name,
        data.venue ?? '',
        data.startsAt || null,
        data.endsAt || null,
        data.timezone ?? 'Asia/Kolkata',
        // The check-in window needs a calendar day to anchor a timeslot to.
        data.eventDate || null,
        // Day 2 of a two-day edition, and NULL for a one-day one — including
        // when the form sends back the same day twice, because "ends on the
        // day it starts" is a single-day event and every reader is written to
        // treat NULL as exactly that.
        normaliseEndDate(data.eventDate, data.eventEndDate),
        deliveryMode,
      ],
    );
    const id = created.rows[0].id;

    await this.audit(user.id, id, 'event.create', 'event', id, data);
    return { id, deliveryMode };
  }

  async updateEvent(
    data: {
      id: string;
      name?: string;
      venue?: string;
      status?: string;
      activate?: boolean;
      startsAt?: string;
      endsAt?: string;
      eventDate?: string | null;
      eventEndDate?: string | null;
      resultsStatus?: string;
    },
    user: HjudgeUser,
  ) {
    await this.db.tx(async (client) => {
      if (data.activate === true) {
        // Which event the field apps are running. Stand every other event down
        // first: hyfit_events_one_active permits a single active row, and the
        // deactivate must land before the activate or the unique index rejects
        // the pair.
        await client.query(
          `UPDATE events SET is_active = false WHERE is_active`,
        );
        await client.query(
          `UPDATE events SET is_active = true, updated_at = now() WHERE id = $1`,
          [data.id],
        );
      } else {
        // The two calendar days are the one pair here that must be settable
        // back to nothing: every other field on this statement is COALESCEd,
        // so an omitted key keeps what is stored, but an organiser who put a
        // second day on the wrong event has to be able to take it off again.
        // `$7 = true` is the "the caller mentioned these" flag — without it,
        // clearing and not-mentioning are the same request.
        const datesTouched =
          data.eventDate !== undefined || data.eventEndDate !== undefined;
        await client.query(
          `UPDATE events SET
             name           = COALESCE($2, name),
             venue          = COALESCE(nullif($3,''), venue),
             status         = COALESCE($4, status),
             starts_at      = COALESCE($5::timestamptz, starts_at),
             ends_at        = COALESCE($6::timestamptz, ends_at),
             event_date     = CASE WHEN $7 THEN $8::date ELSE event_date END,
             event_end_date = CASE WHEN $7 THEN $9::date ELSE event_end_date END,
             updated_at     = now()
           WHERE id = $1`,
          [
            data.id,
            data.name || null,
            data.venue ?? null,
            data.status || null,
            data.startsAt || null,
            data.endsAt || null,
            datesTouched,
            data.eventDate || null,
            // A second day with no first day would fail
            // hyfit_v2_events_date_span_check, and rightly: the span it
            // describes has no beginning. Dropped here so the operator gets
            // "Day 1 is required" from the controller rather than a constraint
            // name from Postgres.
            data.eventDate ? normaliseEndDate(data.eventDate, data.eventEndDate) : null,
          ],
        );
        // resultsStatus is deliberately not handled here. Publishing results is
        // the athlete platform's act, on the athlete platform's row, and it has
        // its own route for it (PATCH /api/hyfitgames/admin/events/:id). This
        // module reaching across to set it was a second writer to a column it
        // does not own.
      }
    });
    await this.audit(
      user.id,
      data.id,
      data.activate ? 'event.activate' : 'event.update',
      'event',
      data.id,
      data,
    );
    return { ok: true };
  }

  /**
   * What deleting this event takes with it, counted before anything is removed.
   *
   * Read by the console so the confirmation says the actual numbers — "3 214
   * athletes, 3 190 results, 6 staff accounts" — rather than a generic warning.
   * An operator who is about to destroy a race day's work should be told what
   * that is, in rows, by the system that knows.
   *
   * Tables are counted only if they exist. `backend/sql` is applied by hand and
   * a deployment can legitimately be a few migrations behind (an offline venue
   * node most of all), and a preflight that 500s because one table is missing
   * would block the delete on a table that has nothing in it.
   */
  async eventDeleteImpact(eventId: string) {
    const event = await this.eventForDelete(eventId);

    const { rows: present } = await this.db.q<{ table_name: string }>(
      `SELECT t.table_name FROM unnest($1::text[]) AS t(table_name)
        WHERE to_regclass('hyfit_v2.' || t.table_name) IS NOT NULL`,
      [EVENT_OWNED_TABLES.map((t) => t.table)],
    );
    const live = EVENT_OWNED_TABLES.filter((t) =>
      present.some((p) => p.table_name === t.table),
    );

    // The table names are this file's own constants, never anything a caller
    // sent — the only interpolation into SQL here, and deliberately closed.
    const counts = live.length
      ? (
          await this.db.q<Record<string, number>>(
            `SELECT ${live
              .map(
                (t) =>
                  `(SELECT count(*)::int FROM ${t.table} WHERE event_id = $1) AS "${t.label}"`,
              )
              .join(', ')}`,
            [eventId],
          )
        ).rows[0]
      : {};

    // Named, not just counted. A staff account is a person who will try to sign
    // in on race morning and find themselves gone, and "6 accounts" does not
    // tell the operator whether one of them is the check-in lead.
    const { rows: staff } = await this.db.q<{ name: string; role: string }>(
      `SELECT name, role FROM users WHERE event_id = $1
        ORDER BY role, name LIMIT 10`,
      [eventId],
    );

    return { event, counts, staff };
  }

  /**
   * Delete an event and everything that belongs to it.
   *
   * PERMANENT, and there is no undo: the roster, the results, the certificate
   * designs, the RaceResult wiring, the sync credentials and the staff accounts
   * hired for this event all go with it. Most of that happens through
   * `ON DELETE CASCADE` in the schema rather than in statements here — the
   * database already knows what belongs to an event, and a hand-written list of
   * DELETEs would be a second answer to that question, drifting out of date
   * with every migration that adds a table.
   *
   * THREE THINGS ARE REFUSED rather than handled, because each is somebody
   * about to lose something they did not mean to:
   *
   *   - the ACTIVE event, which is what the tablets and counters are running.
   *     Standing it down is one press on this same screen, and doing it as a
   *     side effect of a delete would take a race off the air mid-morning.
   *   - a name that does not match. The confirmation is typed, not clicked:
   *     the rows are not recoverable and two adjacent editions of the same
   *     event look identical in a list.
   *   - deleting the event YOUR OWN account is bound to, which would delete you
   *     mid-request — `users.event_id` cascades — and leave the audit entry
   *     with no author.
   *
   * WHAT IS NOT TOUCHED: `platform_event_id`. It points at the athlete
   * platform's own row for the same race, in the `hyfit` schema this deployment
   * dropped — there is nothing on the other end to delete, and reaching across
   * a schema boundary from here is the coupling the cutover removed. If that
   * listing ever comes back, deleting its row becomes its own screen's job.
   */
  async deleteEvent(eventId: string, user: HjudgeUser, confirmName: string) {
    const { event, counts, staff } = await this.eventDeleteImpact(eventId);

    if (event.is_active)
      throw new BadRequestException(
        `"${event.name}" is the active event — the field apps are pointed at it. Make another event active first, then delete this one.`,
      );

    if (!namesMatch(confirmName, event.name))
      throw new BadRequestException(
        `Type the event's name exactly — "${event.name}" — to confirm the deletion.`,
      );

    const { rows: self } = await this.db.q<{ id: string }>(
      'SELECT id FROM users WHERE id = $1 AND event_id = $2',
      [user.id, eventId],
    );
    if (self.length)
      throw new BadRequestException(
        'Your own account is assigned to this event, so deleting it would delete you. Reassign yourself first.',
      );

    // The standings cache is keyed by the event's NAME, not its id, so it is
    // not covered by invalidateEvent below and cannot be cleared once the row
    // is gone. Best effort: a cache that cannot be reached is not a reason to
    // refuse the delete, and the public read resolves the event first and 404s
    // for a row that no longer exists.
    await this.results.discard(eventId).catch((e: Error) => {
      this.logger.warn(
        `Could not clear the standings cache for ${eventId} before deleting it: ${e.message}`,
      );
    });

    await this.db.tx(async (client) => {
      // audit_events.event_id has no ON DELETE action (080), so these rows
      // would block the delete outright. They are the history OF this event and
      // go with it; what survives is the one entry written below.
      await client.query('DELETE FROM audit_events WHERE event_id = $1', [
        eventId,
      ]);
      const deleted = await client.query('DELETE FROM events WHERE id = $1', [
        eventId,
      ]);
      if (!deleted.rowCount) throw new NotFoundException('Event not found');
    });

    await this.cache.invalidateEvent(eventId);

    // Written after the delete and with a NULL event_id — the FK would refuse
    // to point at a row that is gone. This entry is the only record that the
    // event ever existed, so it carries its name and everything that went with
    // it rather than just its id.
    await this.audit(user.id, null, 'event.delete', 'event', eventId, {
      name: event.name,
      venue: event.venue,
      event_date: event.event_date,
      status: event.status,
      removed: counts,
      staff: staff.map((s) => `${s.name} (${s.role})`),
    });

    this.logger.warn(
      `Event deleted: "${event.name}" (${eventId}) by ${user.id} — ${Object.entries(
        counts,
      )
        .map(([k, v]) => `${v} ${k}`)
        .join(', ')}`,
    );

    return { deleted: true, name: event.name, removed: counts };
  }

  /** The event, or a 404 — the one row every delete path starts from. */
  private async eventForDelete(eventId: string) {
    const { rows } = await this.db.q<{
      id: string;
      name: string;
      venue: string | null;
      status: string;
      is_active: boolean;
      event_date: string | null;
      results_mode: string;
    }>(
      `SELECT id, name, venue, status, is_active,
              to_char(event_date, 'YYYY-MM-DD') AS event_date, results_mode
         FROM events WHERE id = $1`,
      [eventId],
    );
    if (!rows[0]) throw new NotFoundException('Event not found');
    return rows[0];
  }

  // `users` resolves to hyfit_v2.users through the pool's search_path (080).
  //
  // `staff_id IS NOT NULL` filters out console operators, who reach the field
  // through platform_user_id and hold no PIN of their own; without it they
  // would appear in the Team roster as people with a blank staff ID.
  // Scoped to one event's staff, because Team is now a screen of an event.
  // Staff with no event of their own are included rather than hidden: a null
  // event_id means "works any event" — the roving super_admin — and dropping
  // them would leave an event whose only visible team member is whoever was
  // typed in most recently.
  async listUsers(eventId: string) {
    const result = await this.db.q(
      `SELECT id, staff_id AS "staffId", name, role, event_id AS "eventId",
        station_number AS "stationNumber", checkin_stage AS "checkinStage",
        enabled, created_at AS "createdAt"
       FROM users
       WHERE staff_id IS NOT NULL AND (event_id = $1 OR event_id IS NULL)
       ORDER BY enabled DESC, role, name`,
      [eventId],
    );
    return { users: result.rows };
  }

  /**
   * The shift a staff account is rostered onto, validated once.
   *
   * THREE RULES IN ONE PLACE, because they were previously in three and
   * disagreed. A check-in volunteer with no stage named defaults to Stage 1 —
   * an account that can sign in and do nothing is worse than one on the wrong
   * desk. A stage that is not one of the two is refused by name rather than by
   * the `hyfit_v2_users_checkin_stage_check` constraint. And a stage on a
   * JUDGE is refused outright: it files a judging account under a check-in
   * shift, which is a data-entry slip that the Team screen then renders as a
   * volunteer who never appears at any counter.
   *
   * The permitted roles are the same set `hyfit_v2_users_stage_role` allows —
   * an admin standing in at a desk is the Help Desk override.
   */
  private resolveCheckinStage(
    stage: string | null | undefined,
    role: string | null | undefined,
  ): string | null {
    const value = stage ? String(stage).trim().toUpperCase() : '';
    if (!value) return role === 'checkin' ? 'STAGE_1_WRISTBAND' : null;
    if (!HJUDGE_CHECKIN_STAGES.includes(value)) {
      throw new BadRequestException(
        `Invalid check-in stage '${stage}' — use STAGE_1_WRISTBAND or STAGE_2_TRANSPONDER`,
      );
    }
    if (!HJUDGE_STAGE_ROLES.includes(String(role ?? ''))) {
      throw new BadRequestException(
        `A ${role} cannot be given a check-in stage — only check-in volunteers staff a stage`,
      );
    }
    return value;
  }

  async createUser(
    data: {
      staffId: string;
      name?: string;
      pin: string;
      role: string;
      eventId?: string;
      stationNumber?: number;
      checkinStage?: string | null;
    },
    user: HjudgeUser,
    pinHashFn: (pin: string) => string,
  ) {
    const staffId = data.staffId.trim().toUpperCase();
    const name = data.name ? data.name.trim() : staffId;
    // A counter volunteer with no stage named can do nothing at all, so hiring
    // one defaults to Stage 1 rather than producing an account that signs in
    // and then reports that an admin has not finished setting it up.
    const checkinStage = this.resolveCheckinStage(data.checkinStage, data.role);

    const result = await this.db.q<{ id: string }>(
      // No `origin`: that column recorded which of the three merged legacy
      // systems a row came from, and hyfit_v2 has one source — this one.
      `INSERT INTO users(staff_id, name, pin_hash, role, event_id, station_number, checkin_stage)
       VALUES($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        staffId,
        name,
        pinHashFn(data.pin),
        data.role,
        data.eventId || user.eventId,
        data.stationNumber || null,
        checkinStage,
      ],
    );
    await this.audit(
      user.id,
      String(data.eventId || user.eventId || ''),
      'user.create',
      'user',
      result.rows[0].id,
      {
        staffId,
        name,
        role: data.role,
      },
    );
    return { id: result.rows[0].id };
  }

  async createUsersBatch(
    users: Array<{
      staffId?: string;
      name?: string;
      pin?: string;
      role?: string;
      stationNumber?: number;
      checkinStage?: string;
    }>,
    user: HjudgeUser,
    pinHashFn: (pin: string) => string,
  ) {
    let created = 0;
    const errors: string[] = [];

    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      const staffId = String(u.staffId ?? '')
        .trim()
        .toUpperCase();
      const pin = String(u.pin ?? '').trim();
      const role = String(u.role ?? 'judge')
        .trim()
        .toLowerCase();
      const name = String(u.name ?? '').trim() || staffId;
      const stationNumber = u.stationNumber
        ? Number(u.stationNumber)
        : undefined;

      if (!staffId) {
        errors.push(`Row ${i + 1}: Missing Staff ID`);
        continue;
      }
      if (!HJUDGE_PIN_PATTERN.test(pin)) {
        errors.push(`Row ${i + 1} (${staffId}): PIN must be 4–8 digits`);
        continue;
      }
      if (!HJUDGE_STAFF_ROLES.includes(role)) {
        errors.push(
          `Row ${i + 1} (${staffId}): Invalid role '${role}' — use judge or checkin`,
        );
        continue;
      }
      try {
        await this.createUser(
          {
            staffId,
            name,
            pin,
            role,
            stationNumber,
            // Validated by createUser's resolver rather than here. A second
            // copy of the rule is a second place for it to be wrong, and a
            // batch that accepted a stage the single-create path refuses was
            // exactly that.
            checkinStage: u.checkinStage,
          },
          user,
          pinHashFn,
        );
        created++;
      } catch (err: any) {
        if (err.code === '23505') {
          errors.push(`Row ${i + 1} (${staffId}): Staff ID already exists`);
        } else {
          errors.push(`Row ${i + 1} (${staffId}): ${err.message}`);
        }
      }
    }

    return { created, total: users.length, errors };
  }

  async updateUser(
    data: {
      id: string;
      enabled?: boolean;
      stationNumber?: number | null;
      checkinStage?: string | null;
      pin?: string;
      name?: string;
      staffId?: string;
      role?: string;
    },
    user: HjudgeUser,
    pinHashFn: (pin: string) => string,
  ) {
    if (data.role && !HJUDGE_APP_ROLES.includes(String(data.role))) {
      throw new BadRequestException('Invalid role specified');
    }
    const staffId = data.staffId ? data.staffId.trim().toUpperCase() : null;
    const name = data.name ? data.name.trim() : null;

    // Moving someone off a check-in role takes their stage with them, whether
    // or not the caller thought to clear it: leaving it behind fails the
    // `hyfit_v2_users_stage_role` constraint, and the person is off the desk
    // either way. `data.role` being present is a safe test for "the role is
    // being set" — every edit the Team screen posts carries the role it is
    // saving, and a PATCH that omits it is one that is not touching either.
    const leavingTheDesk =
      Boolean(data.role) && !HJUDGE_STAGE_ROLES.includes(String(data.role));
    const checkinStage = leavingTheDesk
      ? null
      : data.checkinStage === undefined
        ? undefined
        : this.resolveCheckinStage(data.checkinStage, data.role ?? 'checkin');

    const result = await this.db.q(
      `UPDATE users SET 
        enabled = COALESCE($2, enabled), 
        station_number = CASE WHEN $3::text = 'CLEAR' THEN NULL WHEN $3::int IS NOT NULL THEN $3::int ELSE station_number END,
        pin_hash = CASE WHEN $4::text IS NULL THEN pin_hash ELSE $4 END,
        name = COALESCE($5, name),
        staff_id = COALESCE($6, staff_id),
        role = COALESCE($7, role),
        checkin_stage = CASE WHEN $8::text = 'CLEAR' THEN NULL WHEN $8::text IS NOT NULL THEN $8::text ELSE checkin_stage END,
        updated_at = now()
       WHERE id = $1 AND staff_id IS NOT NULL RETURNING id`,
      [
        data.id,
        typeof data.enabled === 'boolean' ? data.enabled : null,
        data.stationNumber === null
          ? 'CLEAR'
          : data.stationNumber !== undefined
            ? String(data.stationNumber)
            : null,
        data.pin ? pinHashFn(data.pin) : null,
        name,
        staffId,
        data.role || null,
        // Same three-way as stationNumber: null clears, undefined leaves alone.
        // `checkinStage` here is the RESOLVED value, so a stage on a role that
        // may not hold one has already been refused, and a role change off the
        // desk has already turned into a clear.
        checkinStage === undefined ? null : (checkinStage ?? 'CLEAR'),
      ],
    );
    if (!result.rowCount) throw new BadRequestException('User not found');
    await this.audit(user.id, user.eventId, 'user.update', 'user', data.id, {
      enabled: data.enabled,
      stationNumber: data.stationNumber,
      pinReset: Boolean(data.pin),
      name: data.name,
      staffId: data.staffId,
      role: data.role,
    });
    return { ok: true };
  }

  // Removing a staff account used to mean unpicking them from a dozen field-ops
  // tables — every check-in they took, every split they timed, every station
  // they judged. None of that is recorded here any more, so the only thing left
  // holding a reference is the audit trail, which is kept and anonymised rather
  // than deleted: what happened at an event outlives whoever was rostered for it.
  async deleteUser(id: string, user: HjudgeUser) {
    return await this.db.tx(async (client) => {
      await client.query(
        `UPDATE audit_events SET actor_id = NULL WHERE actor_id = $1`,
        [id],
      );
      const res = await client.query(
        `DELETE FROM users WHERE id = $1 AND staff_id IS NOT NULL RETURNING staff_id, name`,
        [id],
      );
      if (!res.rowCount) throw new BadRequestException('User not found');
      await this.audit(user.id, user.eventId, 'user.delete', 'user', id, {
        staffId: res.rows[0].staff_id,
        name: res.rows[0].name,
      });
      return { ok: true, message: `Team member ${res.rows[0].name} deleted` };
    });
  }

  async getConfig(eventId: string) {
    const result = await this.db.q(
      `SELECT id, event_id AS "eventId", version, state,
        bib_lookup_url AS "participantApiUrl",
        update_url AS "updateApiUrl",
        map_lookup_url AS "mapLookupUrl",
        results_url AS "resultsUrl",
        participant_mapping AS "participantMapping",
        update_mapping AS "updateMapping",
        results_mapping AS "resultsMapping",
        declaration_text AS "declarationText",
        declaration_version AS "declarationVersion",
        checkin_window_enabled AS "checkinWindowEnabled",
        checkin_opens_before_minutes AS "checkinOpensBeforeMinutes",
        checkin_closes_after_minutes AS "checkinClosesAfterMinutes",
        published_at AS "publishedAt"
       FROM raceresults_endpoints WHERE event_id = $1 ORDER BY version DESC LIMIT 1`,
      [eventId],
    );
    return { config: result.rows[0] ?? null };
  }

  async saveConfig(data: Record<string, any>, user: HjudgeUser) {
    const eventId = String(data.eventId ?? user.eventId ?? '');
    // The check-in window. Both bounds are minutes relative to the entry's
    // timeslot; a blank close means the counter never closes, which is not the
    // same as closing at the slot itself and has to stay expressible.
    const opensBefore = Number(data.checkinOpensBeforeMinutes ?? 240);
    if (
      !Number.isInteger(opensBefore) ||
      opensBefore < 0 ||
      opensBefore > 10080
    ) {
      throw new BadRequestException(
        'Check-in must open between 0 minutes and 7 days before the timeslot',
      );
    }
    const closesRaw = data.checkinClosesAfterMinutes;
    const closesAfter =
      closesRaw === null || closesRaw === undefined || closesRaw === ''
        ? null
        : Number(closesRaw);
    if (
      closesAfter !== null &&
      (!Number.isInteger(closesAfter) || closesAfter < 0 || closesAfter > 10080)
    ) {
      throw new BadRequestException(
        'Check-in must close between 0 minutes and 7 days after the timeslot',
      );
    }

    const mappingProblems = updateMappingProblems(data.updateMapping);
    if (mappingProblems.length)
      throw new BadRequestException(
        `Update field mapping: ${mappingProblems.join('; ')}`,
      );
    const declarationText =
      String(data.declarationText ?? '').trim() ||
      'I confirm that my participant details are correct and that I have received the assigned race equipment.';

    // The wristband -> BIB mapping table. No parameter to validate: it takes
    // none, and is fetched whole.
    const mapUrl = String(data.mapLookupUrl ?? '').trim();

    // The standings feed. Validated only for being a URL — what it returns is
    // the results importer's problem, and it reports the columns it found so a
    // wrong key is diagnosable rather than merely refused here.
    const resultsUrl = String(data.resultsUrl ?? '').trim();
    if (resultsUrl && !/^https?:\/\//i.test(resultsUrl))
      throw new BadRequestException(
        'The results endpoint must be a complete http(s) URL',
      );

    const result = await this.db.q<{ id: string; version: number }>(
      `INSERT INTO raceresults_endpoints(event_id, version, state,
        bib_lookup_url, update_url, map_lookup_url, results_url,
        participant_mapping, update_mapping, results_mapping,
        declaration_text, declaration_version,
        checkin_window_enabled, checkin_opens_before_minutes, checkin_closes_after_minutes)
       VALUES($1,
         COALESCE((SELECT max(version) + 1 FROM raceresults_endpoints WHERE event_id = $1), 1),
         'draft', $2, $3, $4, $11, $5::jsonb, $6::jsonb, $12::jsonb, $7,
         COALESCE((SELECT max(declaration_version) + 1 FROM raceresults_endpoints
           WHERE event_id = $1 AND declaration_text <> $7), 1), $8, $9, $10)
       RETURNING id, version`,
      [
        eventId,
        String(data.participantApiUrl ?? ''),
        String(data.updateApiUrl ?? ''),
        mapUrl,
        JSON.stringify(data.participantMapping ?? {}),
        JSON.stringify(data.updateMapping ?? {}),
        declarationText,
        Boolean(data.checkinWindowEnabled),
        opensBefore,
        closesAfter,
        resultsUrl,
        JSON.stringify(data.resultsMapping ?? {}),
      ],
    );
    await this.audit(
      user.id,
      eventId,
      'config.save_draft',
      'event_config',
      result.rows[0].id,
      { version: result.rows[0].version },
    );
    return { id: result.rows[0].id, version: result.rows[0].version };
  }

  async publishConfig(data: { id: string; eventId: string }, user: HjudgeUser) {
    await this.db.tx(async (client) => {
      // Retire the incumbent first: hyfit_v2_endpoints_one_published permits a
      // single published row per event, so the two updates cannot be reordered.
      await client.query(
        "UPDATE raceresults_endpoints SET state = 'retired', updated_at = now() WHERE event_id = $1 AND state = 'published'",
        [data.eventId],
      );
      const published = await client.query(
        `UPDATE raceresults_endpoints
            SET state = 'published', published_at = now(), published_by = $2, updated_at = now()
         WHERE id = $1 AND state = 'draft' RETURNING version`,
        [data.id, user.id],
      );
      if (!published.rowCount) throw new Error('Draft configuration not found');
      await client.query('UPDATE events SET updated_at = now() WHERE id = $1', [
        data.eventId,
      ]);
    });
    await this.audit(
      user.id,
      data.eventId,
      'config.publish',
      'event_config',
      data.id,
      {},
    );
    return { ok: true };
  }

  // Roster imports are the athlete platform's, recorded on the platform's own
  // row, and shown on the console's Roster tab — which is where Operations
  // already sends you to run one. This module reported that history by reaching
  // into the other schema for it; it now reports nothing, rather than being the
  // second place the same history is read from.
  //
  // The route is kept so the console's Operations screen keeps its shape while
  // it is updated. It answers empty, not an error: an event with no import
  // history and an event whose history lives elsewhere look the same from here,
  // and the screen renders both the same way.
  listSyncRuns(_eventId: string) {
    return Promise.resolve({ syncRuns: [] as unknown[] });
  }

  private async audit(
    actorId: string,
    eventId: string | null,
    action: string,
    entityType: string,
    // Null when the action is about a set of rows rather than one of them —
    // a queue replay names the event, not a single operation.
    entityId: string | null,
    details?: unknown,
  ) {
    return this.db.q(
      `INSERT INTO audit_events(actor_id, event_id, action, entity_type, entity_id, details)
       VALUES($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        actorId,
        eventId,
        action,
        entityType,
        entityId,
        JSON.stringify(details ?? {}),
      ],
    );
  }
}

/* Everything that hangs off an event, as the delete preflight counts it.
 *
 * Every one of these carries `event_id` and is removed by the database's own
 * CASCADE when the event goes (except `audit_events`, which has no ON DELETE
 * action and is deleted by hand — see deleteEvent). The list exists to COUNT
 * them for the confirmation, not to delete them: a table missing from here
 * still goes, it just goes unannounced, which is the failure mode to prefer
 * over deleting something this list forgot to mention.
 *
 * `users` is the one that surprises people. `hyfit_v2.users.event_id` means
 * "hired for this event", and it cascades: deleting an event deletes the
 * volunteers and event admins bound to it, along with their sessions. Console
 * operators have a NULL event_id and are untouched.
 */
const EVENT_OWNED_TABLES: { table: string; label: string }[] = [
  { table: 'athletes', label: 'athletes' },
  { table: 'results', label: 'results' },
  { table: 'certificate_templates', label: 'certificateTemplates' },
  { table: 'raceresults_endpoints', label: 'raceResultConfigs' },
  { table: 'event_ingest_tokens', label: 'syncCredentials' },
  { table: 'event_push_targets', label: 'pushTargets' },
  { table: 'push_runs', label: 'pushRuns' },
  { table: 'users', label: 'staffAccounts' },
  { table: 'audit_events', label: 'auditEntries' },
];

/* The typed confirmation, compared the way a person types it.
 *
 * Case and surrounding space are forgiven; nothing else is. An organiser
 * copying "HYFIT GAMES BENGALURU" off the screen types it in whatever case
 * their keyboard is in, and refusing that teaches them to paste without
 * reading — which is the one habit this confirmation exists to prevent. */
function namesMatch(typed: string, actual: string): boolean {
  const norm = (v: string) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(typed) !== '' && norm(typed) === norm(actual);
}
