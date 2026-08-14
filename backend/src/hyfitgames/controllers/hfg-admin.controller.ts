import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { HfgDbService } from '../hfg-db.service';
import { HfgCacheService } from '../hfg-cache.service';
import { HfgResultsService } from '../services/hfg-results.service';
import { HfgLiveResultsService } from '../services/hfg-live-results.service';
import { HfgAdminGuard } from '../guards/hfg-admin.guard';
import { teamNameColumn, teammatesColumn } from '../hfg.util';

// Organiser operations: the athlete directory, announcements, scoring, the
// results lifecycle and protests. Mounted under /api/hyfitgames/admin.
// @Public() bypasses the host global guards; the module's own HfgAdminGuard
// enforces the admin session.
//
// Event setup — creating and editing an event, its stations and categories,
// importing and editing its roster — lives in
// HfgSetupController, which shares this prefix.
@Public()
@UseGuards(HfgAdminGuard)
@Controller('hyfitgames/admin')
export class HfgAdminController {
  constructor(
    private readonly db: HfgDbService,
    private readonly cache: HfgCacheService,
    private readonly results: HfgResultsService,
    private readonly live: HfgLiveResultsService,
  ) {}

  /* GET /api/hyfitgames/admin/athletes?search=&eventId= */
  // One endpoint, two scopes, because the console has one Athletes screen.
  //
  // Without eventId it is the athlete directory — every profile, with the
  // number of events each has entered. With one it is that event's roster:
  // the same people, plus the columns that only exist for a person AT an
  // event (bib, category, wave, status).
  //
  // Written against the normalised roster (migration 057): the profile is on
  // `athletes`, the phone number is on the `accounts` row that owns it, and a
  // bib belongs to a `category_entries` row reached through `registrations`.
  // The response keeps the old field names — `registration_id` is the entry id,
  // `status` is the race status — so the console's Athletes screen reads a
  // roster row exactly as it did before the merge.
  @Get('athletes')
  async athletes(
    @Query('search') search?: string,
    @Query('eventId') eventId?: string,
  ) {
    const like = search ? `%${search}%` : '%';

    if (eventId) {
      const { rows } = await this.db.q(
        `SELECT e.id   AS registration_id,
                e.bib, e.wave, e.timeslot,
                to_char(e.contest_date, 'YYYY-MM-DD') AS contest_date,
                e.club, e.start_time,
                e.race_status AS status, e.entry_status,
                c.name AS category, c.format,
                a.id   AS athlete_id,
                a.full_name, a.mobile, a.gender, a.city, a.dob,
                a.profile_complete, a.claim_status,
                ${teamNameColumn('e')},
                ${teammatesColumn('e')}
           FROM category_entries e
           JOIN registrations r ON r.id = e.registration_id
           JOIN athletes a ON a.id = r.athlete_id
           LEFT JOIN categories c ON c.id = e.category_id
          WHERE e.event_id = $1
            AND (a.full_name ILIKE $2 OR a.mobile ILIKE $2 OR e.bib ILIKE $2
                 OR e.club ILIKE $2)
          ORDER BY length(e.bib), e.bib`,
        [eventId, like],
      );
      return rows;
    }

    // The full profile, not a subset. All eleven required fields travel with
    // the row so the console can show what is missing — five of them
    // (email, emergency name/phone, blood group, t-shirt) are unfilled for
    // every athlete in dev, and a list that omits them hides that.
    //
    // `entries` counts category entries and `events` counts registrations,
    // which is now the same distinction 057 made structural: entering two
    // categories at one event is one event entered, not two.
    //
    // A club is a property of an entry, not of a person — someone can enter
    // one event for their gym and the next for a team of friends. The
    // directory has no event to scope it to, so it carries the club from the
    // most recent event entered, plus how many distinct clubs the athlete has
    // appeared for, so a row that says "CrossFit Bengaluru" cannot silently
    // stand in for three different affiliations.
    const { rows } = await this.db.q(
      `SELECT a.id, a.full_name, a.mobile, a.email, a.dob, a.gender,
              a.city, a.state, a.emergency_name, a.emergency_phone,
              a.blood_group, a.tshirt_size, a.profile_complete,
              a.athlete_code, a.claim_status,
              cl.club, COALESCE(cl.clubs, 0) AS clubs,
              (SELECT count(*)::int
                 FROM registrations r WHERE r.athlete_id = a.id) AS events,
              (SELECT count(*)::int
                 FROM category_entries e
                 JOIN registrations r ON r.id = e.registration_id
                WHERE r.athlete_id = a.id) AS entries
         FROM athletes a
         LEFT JOIN LATERAL (
           SELECT (array_agg(x.club ORDER BY x.last_date DESC NULLS LAST))[1] AS club,
                  count(*)::int AS clubs
             FROM (SELECT nullif(btrim(e.club), '') AS club,
                          max(ev.event_date) AS last_date
                     FROM category_entries e
                     JOIN registrations r ON r.id = e.registration_id
                     JOIN events ev ON ev.id = e.event_id
                    WHERE r.athlete_id = a.id
                      AND nullif(btrim(e.club), '') IS NOT NULL
                    GROUP BY 1) x
         ) cl ON true
        WHERE a.merged_into IS NULL
          AND (a.full_name ILIKE $1 OR a.mobile ILIKE $1 OR a.athlete_code ILIKE $1
               -- Any club the athlete has ever entered for, not just the one
               -- shown: searching a gym should return its whole squad.
               OR EXISTS (SELECT 1
                            FROM category_entries e
                            JOIN registrations r ON r.id = e.registration_id
                           WHERE r.athlete_id = a.id AND e.club ILIKE $1))
        ORDER BY a.full_name LIMIT 200`,
      [like],
    );
    return rows;
  }

  /* GET /api/hyfitgames/admin/athletes/:id */
  // One person, in full — what the console's athlete drawer shows.
  //
  // The directory endpoint above already carries the eleven required fields,
  // but only for the no-event scope: a roster row is an ENTRY and knows almost
  // nothing about the human behind it. Rather than widen the roster query for
  // every row so that one row can be inspected, the drawer asks for the person
  // it is opening. It costs one request per person opened, and the roster stays
  // as narrow as the table it fills.
  //
  // The account facts travel with the profile because they are what an
  // organiser is actually checking when they open somebody: whether this
  // person can sign in (`claim_status`, `mobile`), whether the organiser is
  // holding the profile for them (`is_managed`), and where the record came from
  // (`created_via`) — a start-list import and a self-signup are different
  // answers to "why is this profile half empty".
  @Get('athletes/:id')
  async athlete(@Param('id') id: string) {
    const { rows } = await this.db.q(
      `SELECT a.id, a.full_name, a.mobile, a.email, a.dob, a.gender,
              a.city, a.state, a.emergency_name, a.emergency_phone,
              a.blood_group, a.tshirt_size, a.profile_complete,
              a.athlete_code, a.claim_status, a.is_managed, a.created_via,
              a.photo_url, a.created_at, a.last_login_at, a.merged_into,
              m.full_name AS merged_into_name,
              cl.club, COALESCE(cl.clubs, 0) AS clubs,
              (SELECT count(*)::int
                 FROM registrations r WHERE r.athlete_id = a.id) AS events,
              (SELECT count(*)::int
                 FROM category_entries e
                 JOIN registrations r ON r.id = e.registration_id
                WHERE r.athlete_id = a.id) AS entries
         FROM athletes a
         LEFT JOIN athletes m ON m.id = a.merged_into
         LEFT JOIN LATERAL (
           SELECT (array_agg(x.club ORDER BY x.last_date DESC NULLS LAST))[1] AS club,
                  count(*)::int AS clubs
             FROM (SELECT nullif(btrim(e.club), '') AS club,
                          max(ev.event_date) AS last_date
                     FROM category_entries e
                     JOIN registrations r ON r.id = e.registration_id
                     JOIN events ev ON ev.id = e.event_id
                    WHERE r.athlete_id = a.id
                      AND nullif(btrim(e.club), '') IS NOT NULL
                    GROUP BY 1) x
         ) cl ON true
        WHERE a.id = $1`,
      [id],
    );
    // A merged-away duplicate still resolves (the tombstone is deliberate), so
    // the drawer can be opened from an old link and say where the person went
    // rather than 404.
    if (!rows[0]) throw new NotFoundException('No such athlete');
    return rows[0];
  }

  /* GET /api/hyfitgames/admin/athletes/:id/events */
  // The other direction of the same map: every event one athlete has entered.
  // Reached from a row in the directory, so "can an athlete be in multiple
  // events" is answerable in the UI rather than only in the schema.
  @Get('athletes/:id/events')
  async athleteEvents(@Param('id') id: string) {
    const { rows } = await this.db.q(
      `SELECT en.id AS registration_id, en.bib, c.name AS category, en.wave, en.timeslot,
              en.race_status AS status, en.club,
              -- Whether the entry is paid and confirmed. Whether they turned up
              -- at the desk is a check-in fact and lives in RaceResult now, so
              -- it is not answered here.
              en.entry_status,
              to_char(en.contest_date, 'YYYY-MM-DD') AS contest_date,
              en.start_time,
              e.id AS event_id, e.name, e.city, e.event_date, e.status AS event_status,
              e.results_status,
              -- The drill-down listed entries but no performance, so it could
              -- say an athlete raced somewhere and not how it went.
              res.total_ms, res.overall_rank AS category_rank,
              res.gender_rank, res.age_group, res.age_group_rank,
              res.computed_at,
              -- A placing is unreadable without the field it was won in: "#7"
              -- is a different result in a category of nine than in one of two
              -- hundred. Counted over the category the entry sits in, which is
              -- the scope overall_rank is ranked within (054).
              fld.field_size, fld.finishers,
              -- ...and for a doubles entry the individual figures are only half
              -- of it: the team's time and placing are what the pair scored.
              ${teamNameColumn('en')},
              res.team_total_ms, res.team_rank,
              ${teammatesColumn('en', { withBib: true, as: 'partners' })},
              -- The leg-by-leg timing, carried with the entry rather than
              -- fetched per row: an athlete with a dozen events would otherwise
              -- be a dozen more round trips for a drawer that opens once.
              COALESCE(sp.splits, '[]'::jsonb) AS splits
         FROM category_entries en
         JOIN registrations r ON r.id = en.registration_id
         JOIN events e ON e.id = en.event_id
         LEFT JOIN categories c ON c.id = en.category_id
         LEFT JOIN results res ON res.entry_id = en.id
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS field_size,
                  count(fr.total_ms)::int AS finishers
             FROM category_entries fe
             LEFT JOIN results fr ON fr.entry_id = fe.id
            WHERE fe.category_id = en.category_id
         ) fld ON en.category_id IS NOT NULL
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
                    'seq', x.seq, 'name', x.name, 'split_ms', x.split_ms,
                    'cum_ms', x.cum_ms, 'source', x.source
                  ) ORDER BY x.seq) AS splits
             FROM (SELECT st.seq, st.name, s.split_ms, s.source,
                          -- ::int because the window sum is a bigint, which
                          -- would travel as a string and land in the JSON as
                          -- one; the client formats it as a number.
                          sum(s.split_ms) OVER (ORDER BY st.seq)::int AS cum_ms
                     FROM splits s
                     JOIN stations st ON st.id = s.station_id
                    WHERE s.entry_id = en.id) x
         ) sp ON true
        WHERE r.athlete_id = $1
        ORDER BY e.event_date DESC NULLS LAST`,
      [id],
    );
    return rows;
  }

  /* POST /api/hyfitgames/admin/events/:id/announcements */
  @Post('events/:id/announcements')
  async announce(
    @Param('id') id: string,
    @Body() body: { title?: string; body?: string },
  ) {
    if (!body.title || !body.body)
      throw new BadRequestException('title and body are required');
    const { rows } = await this.db.q(
      `INSERT INTO announcements (event_id, title, body) VALUES ($1,$2,$3) RETURNING *`,
      [id, body.title, body.body],
    );
    await this.cache.invalidateEvent(id);
    return rows[0];
  }

  /* POST /api/hyfitgames/admin/events/:id/splits
     { entries: [{ bib, station_seq, split_ms }] } */
  @Post('events/:id/splits')
  async splits(
    @Param('id') id: string,
    @Body()
    body: {
      entries?: { bib?: string; station_seq?: number; split_ms?: number }[];
    },
  ) {
    const entries = body.entries;
    if (!Array.isArray(entries) || !entries.length)
      throw new BadRequestException('entries[] required');
    const report = {
      recorded: 0,
      errors: [] as { index: number; reason: string }[],
    };
    for (const [i, e] of entries.entries()) {
      const { rows } = await this.db.q(
        `SELECT ce.id AS entry_id, st.id AS station_id
           FROM category_entries ce
           JOIN registrations r ON r.id = ce.registration_id
           JOIN stations st ON st.event_id = ce.event_id AND st.seq = $3
          WHERE ce.event_id = $1 AND ce.bib = $2`,
        [id, String(e.bib), e.station_seq],
      );
      if (!rows[0]) {
        report.errors.push({
          index: i,
          reason: `Unknown bib ${e.bib} or station ${e.station_seq}`,
        });
        continue;
      }
      if (!Number.isInteger(e.split_ms) || (e.split_ms as number) <= 0) {
        report.errors.push({
          index: i,
          reason: 'split_ms must be a positive integer',
        });
        continue;
      }
      await this.db.q(
        `INSERT INTO splits (entry_id, station_id, split_ms)
         VALUES ($1,$2,$3)
         ON CONFLICT (entry_id, station_id) DO UPDATE SET split_ms = EXCLUDED.split_ms, recorded_at = now()`,
        [rows[0].entry_id, rows[0].station_id, e.split_ms],
      );
      report.recorded++;
    }
    await this.cache.invalidateEvent(id);
    return report;
  }

  /* POST /api/hyfitgames/admin/events/:id/compute-results */
  @Post('events/:id/compute-results')
  async computeResults(@Param('id') id: string) {
    const out = await this.results.computeResults(id);
    await this.cache.invalidateEvent(id);
    return out;
  }

  // ────────────────────────────────────────────────────────── live results
  //
  // A RaceResult feed served to athletes BEFORE anything is published. See
  // HfgLiveResultsService: a pull writes to Valkey and nothing else, and the
  // database learns about it only when this event is published.

  /* GET /api/hyfitgames/admin/events/:id/live-results — the switch, and
     whatever feed is currently cached behind it. */
  @Get('events/:id/live-results')
  liveResults(@Param('id') id: string) {
    return this.live.getState(id);
  }

  /* PUT /api/hyfitgames/admin/events/:id/live-results { enabled } */
  @Put('events/:id/live-results')
  setLiveResults(@Param('id') id: string, @Body() body: { enabled?: boolean }) {
    if (typeof body?.enabled !== 'boolean')
      throw new BadRequestException('enabled must be true or false');
    return this.live.setEnabled(id, body.enabled);
  }

  /* DELETE the cached feed without touching the switch — "that pull was wrong,
     throw it away". Kept separate from the toggle because turning live results
     off and discarding the standings are different intentions, and an operator
     who wanted the first should not silently get the second. */
  @Post('events/:id/live-results/discard')
  async discardLiveResults(@Param('id') id: string) {
    await this.live.clear(id);
    return { discarded: true };
  }

  /* POST /api/hyfitgames/admin/events/:id/results/raceresult
     { url?, mapping? } — pull standings from a RaceResult results endpoint into
     the cache. Nothing is written to the database.

     The endpoint is remembered on the cached feed itself (`payload.url`) and
     re-used when a later pull omits it, so re-pulling during a race is one
     click rather than a paste. It deliberately does NOT go into
     `event_configs.participant_api_url` alongside the roster feed: that column
     is what the check-in app resolves a bib against, and a results endpoint
     saved over it would 404 every scan at the counter.

     Unlike the roster import this answers synchronously — it writes one Valkey
     key rather than three tables for 2500 athletes, and the operator is waiting
     to look at the standings before deciding whether to switch them on. */
  @Post('events/:id/results/raceresult')
  async pullLiveResults(
    @Param('id') id: string,
    @Body() body: { url?: string; mapping?: Record<string, unknown> },
  ) {
    const cached = await this.live.read(id);
    const url = body?.url?.trim() || cached?.url;
    if (!url)
      throw new BadRequestException(
        'Paste the RaceResult results endpoint for this event',
      );
    return this.live.pull(id, { url, mapping: body?.mapping ?? {} });
  }

  /* POST /api/hyfitgames/admin/events/:id/publish
     { stage: 'provisional'|'final', protest_hours?, force? } */
  @Post('events/:id/publish')
  async publish(
    @Param('id') id: string,
    @Body()
    body: { stage?: string; protest_hours?: number; force?: boolean },
  ) {
    const stage = body.stage;
    if (!['provisional', 'final'].includes(String(stage)))
      throw new BadRequestException("stage must be 'provisional' or 'final'");

    // The open-protest check runs BEFORE any numbers are written. It used to run
    // after `computeResults`, which meant a publish rejected for open protests
    // had already rewritten the results table on its way to the 409. That was
    // survivable when the numbers were recomputed from splits and the next
    // publish would rebuild them; it is not survivable now, because persisting a
    // live feed consumes the cached rows and they exist nowhere else. A refused
    // publish must leave everything exactly as it found it.
    if (stage === 'final') {
      const { rows: open } = await this.db.q(
        `SELECT count(*)::int AS n FROM protests p
           JOIN category_entries ce ON ce.id = p.entry_id
          WHERE ce.event_id = $1 AND p.status = 'open'`,
        [id],
      );
      if (open[0].n > 0 && !body.force)
        throw new ConflictException(
          `${open[0].n} open protest(s) — resolve them or pass force:true`,
        );
    }

    // Where the published numbers come from. A cached RaceResult feed wins,
    // because for an event scored by RaceResult there are no splits to compute
    // from — `computeResults` would find no finishers and publish an empty
    // result set over the standings the operator has been showing all day.
    // With no feed cached this is the unchanged behaviour: recompute from splits.
    const persisted = await this.live.persist(id);
    if (!persisted) await this.results.computeResults(id);

    const hours = Number(body.protest_hours ?? 48);
    const { rows } = await this.db.q(
      `UPDATE events SET results_status = $2::text,
              status = CASE WHEN $2::text = 'final' THEN 'completed' ELSE status END,
              protest_deadline = CASE WHEN $2::text = 'provisional' THEN now() + ($3::text || ' hours')::interval ELSE protest_deadline END
        WHERE id = $1 RETURNING *`,
      [id, stage, hours],
    );
    if (!rows[0]) throw new NotFoundException('Event not found');
    await this.cache.invalidateEvent(id);
    return { ...rows[0], live_persisted: persisted };
  }

  /* GET /api/hyfitgames/admin/protests?status= */
  @Get('protests')
  async protests(@Query('status') status?: string) {
    const { rows } = await this.db.q(
      `SELECT p.*, ce.bib, ce.event_id, a.full_name, e.name AS event_name
         FROM protests p
         JOIN category_entries ce ON ce.id = p.entry_id
         JOIN registrations r ON r.id = ce.registration_id
         JOIN athletes a ON a.id = r.athlete_id
         JOIN events e ON e.id = ce.event_id
        WHERE ($1::text IS NULL OR p.status = $1)
        ORDER BY p.created_at DESC LIMIT 200`,
      [status || null],
    );
    return rows;
  }

  /* PATCH /api/hyfitgames/admin/protests/:id  { status, response } */
  @Patch('protests/:id')
  async resolveProtest(
    @Param('id') id: string,
    @Body() body: { status?: string; response?: string },
  ) {
    if (!['resolved', 'rejected'].includes(String(body.status)))
      throw new BadRequestException('status must be resolved or rejected');
    const { rows } = await this.db.q(
      `UPDATE protests SET status = $2, response = $3, resolved_at = now()
        WHERE id = $1 RETURNING *`,
      [id, body.status, body.response || null],
    );
    if (!rows[0]) throw new NotFoundException('Protest not found');
    return rows[0];
  }
}
