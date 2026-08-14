import { BadRequestException, Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { HjudgeDbService } from '../hjudge-db.service';
import { HjudgeUser } from '../hjudge-auth.guard';
import {
  HJUDGE_APP_ROLES,
  HJUDGE_PIN_PATTERN,
  HJUDGE_STAFF_ROLES,
} from '../hjudge-session.util';
import { HjudgeRaceResultService } from './hjudge-raceresult.service';
import {
  resolveUpdateField,
  updateMappingProblems,
} from '../hjudge-update-mapping.util';

@Injectable()
export class HjudgeAdminService {
  constructor(
    private readonly db: HjudgeDbService,
    private readonly raceResult: HjudgeRaceResultService,
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
      `SELECT id, name, COALESCE(venue,'') AS venue, starts_at, ends_at,
              timezone, status, is_active, event_date,
              platform_event_id AS "platformEventId",
              created_at, updated_at
       FROM events
       ORDER BY is_active DESC, starts_at DESC NULLS LAST, created_at DESC`,
    );
    return { events: result.rows };
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
    },
    user: HjudgeUser,
  ) {
    const created = await this.db.q<{ id: string }>(
      `INSERT INTO events(
         name, venue, starts_at, ends_at, timezone, event_date, status)
       VALUES($1, nullif($2,''), $3, $4, $5, $6, 'draft')
       RETURNING id`,
      [
        data.name,
        data.venue ?? '',
        data.startsAt || null,
        data.endsAt || null,
        data.timezone ?? 'Asia/Kolkata',
        // The check-in window needs a calendar day to anchor a timeslot to.
        data.eventDate || null,
      ],
    );
    const id = created.rows[0].id;

    await this.audit(user.id, id, 'event.create', 'event', id, data);
    return { id };
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
        await client.query(`UPDATE events SET is_active = false WHERE is_active`);
        await client.query(
          `UPDATE events SET is_active = true, updated_at = now() WHERE id = $1`,
          [data.id],
        );
      } else {
        await client.query(
          `UPDATE events SET
             name       = COALESCE($2, name),
             venue      = COALESCE(nullif($3,''), venue),
             status     = COALESCE($4, status),
             starts_at  = COALESCE($5::timestamptz, starts_at),
             ends_at    = COALESCE($6::timestamptz, ends_at),
             updated_at = now()
           WHERE id = $1`,
          [
            data.id,
            data.name || null,
            data.venue ?? null,
            data.status || null,
            data.startsAt || null,
            data.endsAt || null,
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
        station_number AS "stationNumber",
        enabled, created_at AS "createdAt"
       FROM users
       WHERE staff_id IS NOT NULL AND (event_id = $1 OR event_id IS NULL)
       ORDER BY enabled DESC, role, name`,
      [eventId],
    );
    return { users: result.rows };
  }

  async createUser(
    data: {
      staffId: string;
      name?: string;
      pin: string;
      role: string;
      eventId?: string;
      stationNumber?: number;
    },
    user: HjudgeUser,
    pinHashFn: (pin: string) => string,
  ) {
    const staffId = data.staffId.trim().toUpperCase();
    const name = data.name ? data.name.trim() : staffId;

    const result = await this.db.q<{ id: string }>(
      // No `origin`: that column recorded which of the three merged legacy
      // systems a row came from, and hyfit_v2 has one source — this one.
      //
      // No `checkin_stage` either. A counter is no longer a Stage 1 desk or a
      // Stage 2 desk — it runs whichever stage the athlete in front of it is
      // due — so there is nothing about a stage to record against a volunteer.
      // The column is left in place, and left NULL.
      `INSERT INTO users(staff_id, name, pin_hash, role, event_id, station_number)
       VALUES($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        staffId,
        name,
        pinHashFn(data.pin),
        data.role,
        data.eventId || user.eventId,
        data.stationNumber || null,
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
    }>,
    user: HjudgeUser,
    pinHashFn: (pin: string) => string,
  ) {
    let created = 0;
    const errors: string[] = [];

    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      const staffId = String(u.staffId ?? '').trim().toUpperCase();
      const pin = String(u.pin ?? '').trim();
      const role = String(u.role ?? 'judge').trim().toLowerCase();
      const name = String(u.name ?? '').trim() || staffId;
      const stationNumber = u.stationNumber ? Number(u.stationNumber) : undefined;

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
          { staffId, name, pin, role, stationNumber },
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

    const result = await this.db.q(
      `UPDATE users SET 
        enabled = COALESCE($2, enabled), 
        station_number = CASE WHEN $3::text = 'CLEAR' THEN NULL WHEN $3::int IS NOT NULL THEN $3::int ELSE station_number END,
        pin_hash = CASE WHEN $4::text IS NULL THEN pin_hash ELSE $4 END,
        name = COALESCE($5, name),
        staff_id = COALESCE($6, staff_id),
        role = COALESCE($7, role),
        updated_at = now()
       WHERE id = $1 AND staff_id IS NOT NULL RETURNING id`,
      [
        data.id,
        typeof data.enabled === 'boolean' ? data.enabled : null,
        data.stationNumber === null ? 'CLEAR' : (data.stationNumber !== undefined ? String(data.stationNumber) : null),
        data.pin ? pinHashFn(data.pin) : null,
        name,
        staffId,
        data.role || null,
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
        participant_mapping AS "participantMapping",
        update_mapping AS "updateMapping",
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
    if (!Number.isInteger(opensBefore) || opensBefore < 0 || opensBefore > 10080) {
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

    const result = await this.db.q<{ id: string; version: number }>(
      `INSERT INTO raceresults_endpoints(event_id, version, state,
        bib_lookup_url, update_url, map_lookup_url,
        participant_mapping, update_mapping, declaration_text, declaration_version,
        checkin_window_enabled, checkin_opens_before_minutes, checkin_closes_after_minutes)
       VALUES($1,
         COALESCE((SELECT max(version) + 1 FROM raceresults_endpoints WHERE event_id = $1), 1),
         'draft', $2, $3, $4, $5::jsonb, $6::jsonb, $7,
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
      await client.query(
        'UPDATE events SET updated_at = now() WHERE id = $1',
        [data.eventId],
      );
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
