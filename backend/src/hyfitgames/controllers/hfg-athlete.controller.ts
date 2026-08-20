import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { HfgDbService } from '../hfg-db.service';
import { HfgAthleteGuard } from '../guards/hfg-athlete.guard';
import { HfgAthleteId } from '../decorators/hfg-user.decorator';
import { publicAthleteV2, TEAM_COLUMNS } from '../hfg.util';
import {
  HjudgeResultsService,
  entryKey,
} from '../../hyfit-judge/services/hjudge-results.service';

// Athlete self-service: profile, my events, cross-edition stats, my result,
// protests, and the rich performance dashboard (full-stats).
// Mounted under /api/hyfitgames/me. @Public() bypasses the host global guards;
// the module's own HfgAthleteGuard enforces the athlete session.
//
// HALF THIS CONTROLLER IS LIVE AND HALF IS NOT, and the line between them is
// which schema it names. `me`, `updateMe`, `events` and `stats` were re-homed
// onto `hyfit_v2` (migrations 083–085) and work: they read the athlete's rows
// and the results imported from RaceResult.
//
// WHO AN ATHLETE IS, since 085: `hyfit_v2.athletes` holds one row per athlete
// per category per event, so a person is the SET of rows sharing a phone and a
// name. The token names one of those rows; every route below that shows a
// history joins the table to itself on the two key functions to find the rest.
// Reading the token's row alone would show somebody a single event and call it
// their record.
//
// `full-stats` was re-homed too (2026-08-16) — see the note on it for the
// table-by-table translation and for the two facts it can no longer report.
//
// What is still NOT ported: `myRegistration` and `submitProtest`. Both address
// `category_entries`, `registrations`, `splits`, `stations` and `protests`
// through this pool's search_path, which points at the dropped `hyfit` schema,
// so both answer 500 and have done since the cutover. They are left rather than
// half-ported: protests have no home in hyfit_v2 at all, and inventing one to
// make a route return 200 would be worse than the 500 that says the feature is
// not there.
@Public()
@UseGuards(HfgAthleteGuard)
@Controller('hyfitgames/me')
export class HfgAthleteController {
  constructor(
    private readonly db: HfgDbService,
    // The hyfit_v2 live feed, borrowed from the field module rather than
    // reimplemented: it owns the Valkey key and the mode check. The athlete
    // platform's own HfgLiveResultsService is NOT injected here any more — it
    // reads the dropped `hyfit` schema, and the one handler that used it now
    // reads this one.
    private readonly liveResults: HjudgeResultsService,
  ) {}

  private static readonly PROFILE_FIELDS = new Set([
    'full_name',
    'email',
    'gender',
    'dob',
    'city',
    'state',
    'blood_group',
    'tshirt_size',
    'emergency_name',
    'emergency_phone',
  ]);

  /* GET /api/hyfitgames/me */
  @Get()
  async me(@HfgAthleteId() athleteId: string) {
    const { rows } = await this.db.q(
      'SELECT * FROM hyfit_v2.athletes WHERE id = $1 AND is_active',
      [athleteId],
    );
    if (!rows[0]) throw new NotFoundException('Profile not found');
    return publicAthleteV2(rows[0]);
  }

  /* PATCH /api/hyfitgames/me
   *
   * Neither the mobile NOR the name is editable here: they are two thirds of
   * the key (085), so letting an athlete rename themselves is letting them
   * become a different person — or collide with one, and silently adopt their
   * results. Both are organiser-verified support flows. What is left is the
   * profile the athlete genuinely owns.
   *
   * It edits ONE row, the token's. A profile field written across every row
   * sharing the phone and name would be the better behaviour and is not built:
   * say so rather than pretending the single-row edit is the whole answer. */
  @Patch()
  async updateMe(
    @HfgAthleteId() athleteId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body || {})) {
      if (HfgAthleteController.PROFILE_FIELDS.has(k)) fields[k] = v;
    }
    const keys = Object.keys(fields);
    if (!keys.length) throw new BadRequestException('Nothing to update');

    // The column names differ from the API's: the app has always said `dob`,
    // the table says `date_of_birth`. Mapped here rather than renamed either
    // side, because the API shape is what every athlete screen reads.
    const COLUMN: Record<string, string> = {
      email: 'email',
      gender: 'gender',
      dob: 'date_of_birth',
      city: 'city',
    };
    const usable = keys.filter((k) => COLUMN[k]);
    if (!usable.length)
      throw new BadRequestException(
        'Only email, gender, date of birth and city can be changed here',
      );

    const sets = usable.map((k, i) => `${COLUMN[k]} = $${i + 2}`).join(', ');
    const { rows } = await this.db.q(
      `UPDATE hyfit_v2.athletes SET ${sets} WHERE id = $1 RETURNING *`,
      [athleteId, ...usable.map((k) => (fields[k] === '' ? null : fields[k]))],
    );
    if (!rows[0]) throw new NotFoundException('Profile not found');
    return publicAthleteV2(rows[0]);
  }

  /* GET /api/hyfitgames/me/events — everything I'm part of, past and upcoming.
   *
   * One row per ENTRY, not per event: an athlete can hold several bibs at one
   * event, one per category, and collapsing them would hide all but the first.
   * The client groups by event_id where it needs to.
   *
   * Results are joined per row, and only for an event that has actually
   * published them: `results_mode = 'stored'` is the organiser saying
   * these numbers are real, and showing a mid-import row before that would put
   * a time in front of an athlete that can still change. */
  @Get('events')
  async myEvents(@HfgAthleteId() athleteId: string) {
    const { rows } = await this.db.q(
      // WHO THIS ATHLETE IS, since 085: the rows sharing their phone and name.
      // The token names one row; the person is all of them. Matching on the
      // token's row alone would show an athlete only the single event that row
      // belongs to, which is the opposite of a history.
      `SELECT e.id AS event_id, e.name, e.venue, e.event_date, e.status,
              e.results_mode, e.timezone,
              a.id AS entry_id, a.bib, a.category, a.club, a.wave, a.timeslot,
              a.contest_date,
              res.status AS race_status, res.total_ms, res.team_time_ms,
              res.rank AS overall_rank, res.age_group_rank
         FROM hyfit_v2.athletes me
         JOIN hyfit_v2.athletes a
           ON hyfit_v2.mobile_key(a.mobile) = hyfit_v2.mobile_key(me.mobile)
          AND hyfit_v2.name_key(a.name) = hyfit_v2.name_key(me.name)
         JOIN hyfit_v2.events e ON e.id = a.event_id
         LEFT JOIN hyfit_v2.results res
                ON res.athlete_id = a.id AND e.results_mode = 'stored'
        WHERE me.id = $1
        ORDER BY e.event_date DESC NULLS LAST, e.created_at DESC`,
      [athleteId],
    );

    /* The live overlay.
     *
     * An event running right now has no rows in `results` — that is the whole
     * design: a pull writes to Valkey and nothing else until somebody stores
     * it. So an athlete mid-race would see their entry with an empty time,
     * while the same standings were on the venue screen. This puts the cached
     * feed in front of them.
     *
     * It is a read of the SAME key the public board serves, through the same
     * service, so the number an athlete sees on their phone and the number on
     * the screen behind them cannot disagree. Only events actually in live mode
     * are fetched — one Valkey GET each, and none at all for the usual case of
     * an athlete whose races are all finished.
     */
    const liveEventIds: string[] = [
      ...new Set<string>(
        rows
          .filter((r) => r.results_mode === 'live')
          .map((r) => String(r.event_id)),
      ),
    ];
    for (const eventId of liveEventIds) {
      const payload = await this.liveResults
        .publicResults(eventId)
        .catch(() => null);
      if (!payload) continue;
      // Matched on bib AND category. An athlete racing two contests under one
      // number has two entries here and two rows in the feed, and matching on
      // the bib alone would put the same time and placing on both — telling
      // them they finished their doubles race in their solo time.
      const byEntry = new Map(
        payload.rows.map((r) => [entryKey(r.bib, r.category), r]),
      );
      for (const row of rows) {
        if (String(row.event_id) !== eventId) continue;
        const live = byEntry.get(entryKey(String(row.bib), row.category));
        if (!live) continue;
        // Written into the same fields the stored path fills, so every screen
        // renders one shape and does not have to know where the numbers came
        // from. `is_live` is the one addition: whether a time is provisional is
        // something the athlete is entitled to be told.
        row.race_status = live.status;
        row.total_ms = live.total_ms;
        row.team_time_ms = live.team_time_ms;
        row.overall_rank = live.rank;
        row.age_group_rank = live.age_group_rank;
        row.is_live = true;
      }
    }

    // hyfit_v2 statuses are operational (draft/ready/live/closed/archived), not
    // the athlete-facing ones the old schema had. An event is in your future
    // until it closes — 'draft' included, because an athlete on the start list
    // of an event still being set up is still racing it.
    return {
      upcoming: rows.filter((x) =>
        ['draft', 'ready', 'live'].includes(String(x.status)),
      ),
      past: rows.filter((x) =>
        ['closed', 'archived'].includes(String(x.status)),
      ),
    };
  }

  /* GET /api/hyfitgames/me/events/:eventId/results — MY results at one event.
   *
   * The same shape as the public GET /events/:id/results, restricted to this
   * athlete's own entries. It is a separate route rather than a `mine=1` flag on
   * the public one because that route is unauthenticated and its response is
   * cached under a key derived only from the event and the query string —
   * folding a per-athlete filter into it would either fragment that cache per
   * athlete or, worse, serve one athlete's rows to the next caller.
   *
   * A doubles entry still carries its whole team: the partner's leg is part of
   * the result this athlete owns, not somebody else's data.
   */
  @Get('events/:eventId/results')
  async myEventResults(
    @HfgAthleteId() athleteId: string,
    @Param('eventId') eventId: string,
  ) {
    // MY bibs at this event, from the map. This is the filter, and it is done
    // against the roster rather than against anything in the feed: the bib is
    // what the two sides share, and taking it from the athlete's own entries is
    // what makes it impossible for this route to hand back somebody else's row.
    const { rows: entries } = await this.db.q<{
      entry_id: string;
      bib: string;
      category: string | null;
      club: string | null;
    }>(
      `SELECT a.id AS entry_id, a.bib, a.category, a.club
         FROM hyfit_v2.athletes me
         JOIN hyfit_v2.athletes a
           ON hyfit_v2.mobile_key(a.mobile) = hyfit_v2.mobile_key(me.mobile)
          AND hyfit_v2.name_key(a.name) = hyfit_v2.name_key(me.name)
        WHERE me.id = $2 AND a.event_id = $1
        ORDER BY a.category, a.bib`,
      [eventId, athleteId],
    );
    if (!entries.length)
      return { results_status: 'none', mine: [], rows: [], field: {} };

    // The same payload the public board is built from, through the same
    // service, so an athlete's own row and the row with their name on it in the
    // leaderboard are literally the same object. `publicResults` honours the
    // event's mode: the cache while it is live, the stored results once they
    // are, and null when the organiser publishes neither.
    const payload = await this.liveResults
      .publicResults(eventId)
      .catch(() => null);
    if (!payload)
      return {
        results_status: 'none',
        mine: entries.map((e) => ({ ...e, row: null })),
        rows: [],
        field: {},
      };

    const byEntry = new Map(
      payload.rows.map((r) => [entryKey(r.bib, r.category), r]),
    );

    // How big each of my contests is. A bare "3rd" means nothing without it,
    // and it is exactly what an athlete loses by being shown only their own
    // row — so it is counted from the full payload here, on the server, rather
    // than making the page download the whole field to work it out.
    const field: Record<string, number> = {};
    for (const r of payload.rows)
      if (r.category) field[r.category] = (field[r.category] ?? 0) + 1;

    return {
      results_status: payload.source === 'live' ? 'live' : 'final',
      updated_at: payload.fetched_at,
      event_name: payload.event_name,
      // One per entry: an athlete holding three bibs at one event has three
      // results, and showing the first would hide two races they ran.
      mine: entries.map((e) => ({
        ...e,
        // Each entry finds ITS OWN row. Two contests under one bib are two
        // races with two times, and both belong to this athlete.
        row: byEntry.get(entryKey(e.bib, e.category)) ?? null,
      })),
      field,
      // Deliberately empty. The leaderboard is a separate, unauthenticated read
      // (GET /api/hyfit-judge/public/events/:id/results) that the page fetches
      // only when somebody asks for it — an athlete opening their own result on
      // venue wifi should not be made to download a thousand strangers first.
      rows: [],
    };
  }

  /* GET /api/hyfitgames/me/stats — cross-edition performance */
  @Get('stats')
  async myStats(@HfgAthleteId() athleteId: string) {
    // `editions` counts DISTINCT events, not entries: three categories at one
    // event is one edition raced, and counting rows would tell an athlete they
    // had done three.
    const { rows: agg } = await this.db.q(
      `SELECT count(*) FILTER (WHERE res.status = 'FIN')::int AS finishes,
              count(DISTINCT a.event_id)::int                AS editions,
              min(res.total_ms)                              AS pb_ms,
              min(res.rank)                                  AS best_rank
         FROM hyfit_v2.athletes me
         JOIN hyfit_v2.athletes a
           ON hyfit_v2.mobile_key(a.mobile) = hyfit_v2.mobile_key(me.mobile)
          AND hyfit_v2.name_key(a.name) = hyfit_v2.name_key(me.name)
         JOIN hyfit_v2.events e ON e.id = a.event_id
         LEFT JOIN hyfit_v2.results res
                ON res.athlete_id = a.id AND e.results_mode = 'stored'
        WHERE me.id = $1`,
      [athleteId],
    );

    // The circuit, best leg by leg, straight off the stored columns. It used to
    // come from `splits`/`stations`, which the field apps stopped writing when
    // check-in and judging moved onto RaceResult (079) — these six pairs are
    // where that data lives now.
    const { rows: stationBests } = await this.db.q(
      `SELECT label, min(ms) AS best_ms FROM (
         SELECT unnest(ARRAY['Run 1','Station 1','Run 2','Station 2','Run 3','Station 3',
                             'Run 4','Station 4','Run 5','Station 5','Run 6','Station 6']) AS label,
                unnest(ARRAY[res.run1_ms, res.st1_ms, res.run2_ms, res.st2_ms,
                             res.run3_ms, res.st3_ms, res.run4_ms, res.st4_ms,
                             res.run5_ms, res.st5_ms, res.run6_ms, res.st6_ms]) AS ms,
                unnest(ARRAY[1,2,3,4,5,6,7,8,9,10,11,12]) AS ord
           FROM hyfit_v2.athletes me
           JOIN hyfit_v2.athletes a
             ON hyfit_v2.mobile_key(a.mobile) = hyfit_v2.mobile_key(me.mobile)
            AND hyfit_v2.name_key(a.name) = hyfit_v2.name_key(me.name)
           JOIN hyfit_v2.events e ON e.id = a.event_id AND e.results_mode = 'stored'
           JOIN hyfit_v2.results res ON res.athlete_id = a.id
          WHERE me.id = $1
       ) legs
        WHERE ms IS NOT NULL
        GROUP BY label, ord ORDER BY ord`,
      [athleteId],
    );

    const { rows: progression } = await this.db.q(
      `SELECT e.name, e.venue AS city, e.event_date,
              res.total_ms, res.rank AS overall_rank
         FROM hyfit_v2.athletes me
         JOIN hyfit_v2.athletes a
           ON hyfit_v2.mobile_key(a.mobile) = hyfit_v2.mobile_key(me.mobile)
          AND hyfit_v2.name_key(a.name) = hyfit_v2.name_key(me.name)
         JOIN hyfit_v2.events e ON e.id = a.event_id AND e.results_mode = 'stored'
         JOIN hyfit_v2.results res ON res.athlete_id = a.id
        WHERE me.id = $1 AND res.total_ms IS NOT NULL
        ORDER BY e.event_date`,
      [athleteId],
    );

    return { ...agg[0], stationBests, progression };
  }

  /* GET /api/hyfitgames/me/registrations/:regId — my full result */
  @Get('registrations/:regId')
  async myRegistration(
    @HfgAthleteId() athleteId: string,
    @Param('regId') regId: string,
  ) {
    const { rows } = await this.db.q(
      `SELECT ce.*, e.name AS event_name, e.city, e.edition, e.event_date, e.status AS event_status,
              e.results_status, e.protest_deadline,
              r.id AS registration_id,
              c.name AS category_name,
              res.total_ms, res.overall_rank, res.gender_rank, res.age_group, res.age_group_rank,
              -- The doubles half. Without it this page shows a pair's own leg as
              -- if it were their result, and names one of the two people who
              -- raced it.
              ${TEAM_COLUMNS}
         FROM category_entries ce
         JOIN registrations r ON r.id = ce.registration_id
         JOIN athletes a ON a.id = r.athlete_id
         JOIN events e ON e.id = ce.event_id
         LEFT JOIN categories c ON c.id = ce.category_id
         LEFT JOIN results res ON res.entry_id = ce.id
        WHERE ce.id = $1 AND r.athlete_id = $2`,
      [regId, athleteId],
    );
    if (!rows[0]) throw new NotFoundException('Registration not found');

    const { rows: splits } = await this.db.q(
      `SELECT st.seq, st.name, s.split_ms,
              sum(s.split_ms) OVER (ORDER BY st.seq) AS cum_ms
         FROM splits s JOIN stations st ON st.id = s.station_id
        WHERE s.entry_id = $1 ORDER BY st.seq`,
      [regId],
    );

    const { rows: protests } = await this.db.q(
      `SELECT id, message, status, response, created_at
         FROM protests WHERE entry_id = $1 ORDER BY created_at DESC`,
      [regId],
    );

    return { ...rows[0], splits, protests };
  }

  /* POST /api/hyfitgames/me/registrations/:regId/protest — only while open */
  @Post('registrations/:regId/protest')
  async submitProtest(
    @HfgAthleteId() athleteId: string,
    @Param('regId') regId: string,
    @Body() body: { message?: string },
  ) {
    const message = String(body.message || '').trim();
    if (message.length < 10)
      throw new BadRequestException(
        'Describe the issue in a few words (min 10 characters)',
      );

    const { rows } = await this.db.q(
      `SELECT ce.id, e.results_status, e.protest_deadline
         FROM category_entries ce
         JOIN registrations r ON r.id = ce.registration_id
         JOIN events e ON e.id = ce.event_id
        WHERE ce.id = $1 AND r.athlete_id = $2`,
      [regId, athleteId],
    );
    const reg = rows[0];
    if (!reg) throw new NotFoundException('Registration not found');
    if (reg.results_status !== 'provisional')
      throw new BadRequestException(
        'Protests are open only while results are provisional',
      );
    if (reg.protest_deadline && new Date(reg.protest_deadline) < new Date())
      throw new BadRequestException('The protest window has closed');

    const { rows: p } = await this.db.q(
      `INSERT INTO protests (entry_id, message) VALUES ($1, $2) RETURNING *`,
      [reg.id, message],
    );
    return p[0];
  }

  /* GET /api/hyfitgames/me/full-stats — comprehensive performance dashboard.
   *
   * Re-homed onto hyfit_v2 (083–085). It used to read `category_entries`,
   * `registrations`, `splits` and `stations` — four tables the cutover dropped —
   * and had answered 500 on every load since.
   *
   * The translation, once, because every query below shares it:
   *
   *   category_entries + registrations  →  hyfit_v2.athletes, which since 085 IS
   *                                        the entry. A PERSON is the set of rows
   *                                        sharing a phone and a name, so each
   *                                        query joins the table to itself on the
   *                                        two key functions — reading the
   *                                        token's row alone would show somebody
   *                                        one event and call it their record.
   *   ce.race_status                    →  res.status. An entry with no result
   *                                        row has no status at all, which is
   *                                        "not scored", NOT a DNS.
   *   e.results_status = 'final'        →  e.results_mode = 'stored'. The same
   *                                        distinction `myStats` already draws:
   *                                        a live pull lives in Valkey and is
   *                                        provisional, and a career statistic
   *                                        built on it would change under the
   *                                        athlete as the cache expired.
   *   e.city                            →  e.venue
   *   res.overall_rank                  →  res.rank
   *   splits + stations                 →  the twelve run/station columns on the
   *                                        result row, which is where the circuit
   *                                        lives since the field apps stopped
   *                                        writing splits (079).
   *
   * TWO FACTS ARE GONE and are reported as absent rather than approximated:
   * `gender_rank` (hyfit_v2.results does not carry one, and most feeds send no
   * gender at all) and an event `edition` number. The page renders "—" for both.
   */
  @Get('full-stats')
  async fullStats(@HfgAthleteId() aid: string) {
    // Every row this person owns, with its event and its result. The rest of
    // this method is aggregates over exactly this set.
    const MINE = `
         FROM hyfit_v2.athletes me
         JOIN hyfit_v2.athletes a
           ON hyfit_v2.mobile_key(a.mobile) = hyfit_v2.mobile_key(me.mobile)
          AND hyfit_v2.name_key(a.name) = hyfit_v2.name_key(me.name)
         JOIN hyfit_v2.events e ON e.id = a.event_id
         LEFT JOIN hyfit_v2.results res
                ON res.athlete_id = a.id AND e.results_mode = 'stored'
        WHERE me.id = $1`;

    const { rows: core } = await this.db.q(
      // `total_events` counts DISTINCT events: three categories at one event is
      // one event raced, and counting entries would tell an athlete they had
      // done three.
      `SELECT
        count(DISTINCT a.event_id)::int                         AS total_events,
        count(*) FILTER (WHERE res.status = 'FIN')::int         AS finishes,
        count(*) FILTER (WHERE res.status = 'DNF')::int         AS dnfs,
        count(*) FILTER (WHERE res.status = 'DNS')::int         AS dns,
        min(res.total_ms)                                       AS pb_ms,
        max(res.total_ms)                                       AS worst_ms,
        avg(res.total_ms)::int                                  AS avg_ms,
        count(*) FILTER (WHERE res.rank = 1)::int               AS wins,
        count(*) FILTER (WHERE res.rank <= 3)::int              AS podiums,
        count(*) FILTER (WHERE res.rank <= 10)::int             AS top10,
        min(res.rank)                                           AS best_rank,
        avg(res.rank)::numeric(5,1)                             AS avg_rank,
        count(DISTINCT e.venue) FILTER (WHERE e.venue IS NOT NULL)::int
                                                                AS cities_visited
        ${MINE}`,
      [aid],
    );

    const { rows: cityBreakdown } = await this.db.q(
      `SELECT e.venue AS city, count(DISTINCT a.event_id)::int AS events,
              min(res.total_ms) AS best_ms,
              avg(res.total_ms)::int AS avg_ms,
              count(*) FILTER (WHERE res.rank = 1)::int AS wins,
              count(*) FILTER (WHERE res.rank <= 3)::int AS podiums,
              avg(res.rank)::numeric(5,1) AS avg_rank
         ${MINE} AND res.status = 'FIN' AND e.venue IS NOT NULL
        GROUP BY e.venue ORDER BY events DESC`,
      [aid],
    );

    const { rows: progression } = await this.db.q(
      // `edition` is not a fact hyfit_v2 holds; the column is kept in the shape
      // so the page's chart labels have somewhere to look, and it is honestly
      // null rather than a guessed sequence number.
      `SELECT e.name, e.venue AS city, NULL::int AS edition,
              e.event_date, e.event_date AS date,
              res.total_ms, res.rank AS overall_rank, NULL::int AS gender_rank
         ${MINE} AND res.status = 'FIN' AND res.total_ms IS NOT NULL
        ORDER BY e.event_date`,
      [aid],
    );

    /* The circuit, from the twelve typed columns rather than from `splits`.
     *
     * `best_rank_in_station` / `total_athletes_at_station` are NOT carried over.
     * The old query ranked these rows against each other — one athlete's own
     * legs — so it answered "1 of 1" for every station and told nobody
     * anything. Ranking a leg against the whole field is a real question and a
     * different query; leaving the keys out lets the page fall back to its
     * neutral 50% rather than print a fabricated placing. */
    const legs = (select: string, extra = '') => `
      SELECT ${select} FROM (
        SELECT unnest(ARRAY['Run 1','Station 1','Run 2','Station 2','Run 3','Station 3',
                            'Run 4','Station 4','Run 5','Station 5','Run 6','Station 6']) AS name,
               unnest(ARRAY[1,2,3,4,5,6,7,8,9,10,11,12]) AS seq,
               unnest(ARRAY[res.run1_ms, res.st1_ms, res.run2_ms, res.st2_ms,
                            res.run3_ms, res.st3_ms, res.run4_ms, res.st4_ms,
                            res.run5_ms, res.st5_ms, res.run6_ms, res.st6_ms]) AS ms,
               e.event_date
          ${MINE} AND res.status = 'FIN'
      ) legs
       WHERE ms IS NOT NULL ${extra}`;

    const { rows: stationPerf } = await this.db.q(
      legs(
        `name, seq, min(ms) AS best_ms, max(ms) AS worst_ms,
         avg(ms)::int AS avg_ms, count(*)::int AS attempts`,
      ) + ' GROUP BY seq, name ORDER BY seq',
      [aid],
    );

    const { rows: stationTrend } = await this.db.q(
      legs('seq, name, event_date, ms AS split_ms') +
        ' ORDER BY event_date, seq',
      [aid],
    );

    const { rows: monthlyPerf } = await this.db.q(
      `SELECT to_char(e.event_date, 'YYYY-MM') AS month,
              count(DISTINCT a.event_id)::int AS events,
              avg(res.total_ms)::int AS avg_ms,
              min(res.total_ms) AS best_ms
         ${MINE} AND res.status = 'FIN' AND e.event_date IS NOT NULL
        GROUP BY to_char(e.event_date, 'YYYY-MM')
        ORDER BY to_char(e.event_date, 'YYYY-MM')`,
      [aid],
    );

    /* Where this athlete's times sit in the whole published field.
     *
     * Every one of their finishes against every stored finish anywhere — the
     * same cross join the old query did — so somebody who has raced three times
     * is measured on all three rather than on their best. */
    const { rows: pctl } = await this.db.q(
      `WITH all_finishers AS (
         SELECT res.total_ms
           FROM hyfit_v2.results res
           JOIN hyfit_v2.events e ON e.id = res.event_id AND e.results_mode = 'stored'
          WHERE res.status = 'FIN' AND res.total_ms IS NOT NULL
       ),
       my_times AS (
         SELECT res.total_ms
           ${MINE} AND res.status = 'FIN' AND res.total_ms IS NOT NULL
       )
       SELECT round(100.0 * count(*) FILTER (WHERE af.total_ms > mt.total_ms) /
                    nullif(count(*), 0), 1) AS percentile
         FROM my_times mt, all_finishers af`,
      [aid],
    );

    const { rows: consistency } = await this.db.q(
      `SELECT stddev_samp(res.total_ms)::int AS std_dev, count(*)::int AS n
         ${MINE} AND res.status = 'FIN' AND res.total_ms IS NOT NULL`,
      [aid],
    );

    // In date order, because a streak is a run of consecutive finishes and an
    // event with no result breaks it — the same rule as before, now reading the
    // status off the result row.
    const { rows: allDates } = await this.db.q(
      `SELECT e.event_date, res.status
         ${MINE}
        ORDER BY e.event_date`,
      [aid],
    );

    let currentStreak = 0,
      longestStreak = 0;
    for (const row of allDates) {
      if (row.status === 'FIN') {
        currentStreak++;
        longestStreak = Math.max(longestStreak, currentStreak);
      } else currentStreak = 0;
    }
    let ongoingStreak = 0;
    for (let i = allDates.length - 1; i >= 0; i--) {
      if (allDates[i].status === 'FIN') ongoingStreak++;
      else break;
    }

    const { rows: athleteRows } = await this.db.q(
      'SELECT * FROM hyfit_v2.athletes WHERE id = $1',
      [aid],
    );
    if (!athleteRows[0]) throw new NotFoundException('Profile not found');

    return {
      // The same projection `GET /me` returns, so the page reads one shape:
      // `full_name` and `dob` are the API's names for `name` and
      // `date_of_birth`.
      athlete: publicAthleteV2(athleteRows[0]),
      core: core[0],
      cityBreakdown,
      progression,
      stationPerf,
      stationTrend,
      monthlyPerf,
      percentile: pctl[0]?.percentile || 0,
      // std_dev is null until there are two finishes to vary between, and the
      // page divides by it — so it leaves here as a number.
      consistency: {
        std_dev: consistency[0]?.std_dev ?? 0,
        n: consistency[0]?.n ?? 0,
      },
      streaks: { current: ongoingStreak, longest: longestStreak },
      // Absent, not zero-with-confidence: hyfit_v2 publishes no gender ranking.
      genderRank: { avg_gender_rank: null, gender_wins: null },
    };
  }
}
