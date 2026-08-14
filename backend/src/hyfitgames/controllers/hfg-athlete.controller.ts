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
import { publicAthlete, TEAM_COLUMNS } from '../hfg.util';
import { HfgLiveResultsService } from '../services/hfg-live-results.service';

// Athlete self-service: profile, my events, cross-edition stats, my result,
// protests, and the rich performance dashboard (full-stats).
// Ported from routes/athlete.js and routes/fullstats.js. Mounted under
// /api/hyfitgames/me. @Public() bypasses the host global guards; the module's
// own HfgAthleteGuard enforces the athlete session.
@Public()
@UseGuards(HfgAthleteGuard)
@Controller('hyfitgames/me')
export class HfgAthleteController {
  constructor(
    private readonly db: HfgDbService,
    private readonly live: HfgLiveResultsService,
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
    const { rows } = await this.db.q('SELECT * FROM athletes WHERE id = $1', [
      athleteId,
    ]);
    if (!rows[0]) throw new NotFoundException('Profile not found');
    return publicAthlete(rows[0]);
  }

  /* PATCH /api/hyfitgames/me — mobile is NOT editable here (identity anchor;
     changing it is an organiser-verified support flow). */
  @Patch()
  async updateMe(
    @HfgAthleteId() athleteId: string,
    @Body() body: Record<string, unknown>,
  ) {
    // Whitelist known fields; treat '' as NULL (mirrors the original zod schema).
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body || {})) {
      if (HfgAthleteController.PROFILE_FIELDS.has(k)) fields[k] = v;
    }
    const keys = Object.keys(fields);
    if (!keys.length) throw new BadRequestException('Nothing to update');

    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const complete = `profile_complete = (
        COALESCE(gender,'') <> '' AND dob IS NOT NULL AND
        COALESCE(emergency_phone,'') <> '' AND COALESCE(city,'') <> '')`;
    const { rows } = await this.db.q(
      `UPDATE athletes SET ${sets}, updated_at = now() WHERE id = $1
       RETURNING *`,
      [athleteId, ...keys.map((k) => (fields[k] === '' ? null : fields[k]))],
    );
    await this.db.q(`UPDATE athletes SET ${complete} WHERE id = $1`, [
      athleteId,
    ]);
    return publicAthlete(rows[0]);
  }

  /* GET /api/hyfitgames/me/events — everything I'm part of, past and upcoming */
  @Get('events')
  async myEvents(@HfgAthleteId() athleteId: string) {
    const { rows } = await this.db.q(
      `SELECT e.id AS event_id, e.name, e.edition, e.city, e.venue, e.event_date,
              e.status, e.results_status, e.protest_deadline,
              r.id AS registration_id, ce.bib, c.name AS category, ce.wave, ce.timeslot, ce.start_time, r.status AS reg_status,
              ce.race_status, res.total_ms, res.overall_rank, res.gender_rank, res.age_group, res.age_group_rank,
              ${TEAM_COLUMNS}
         FROM registrations r
         JOIN events e ON e.id = r.event_id
         JOIN category_entries ce ON ce.registration_id = r.id
         LEFT JOIN categories c ON c.id = ce.category_id
         LEFT JOIN results res ON res.entry_id = ce.id
        WHERE r.athlete_id = $1
        ORDER BY e.event_date DESC`,
      [athleteId],
    );
    return {
      upcoming: rows.filter(
        (x) => x.status === 'upcoming' || x.status === 'live',
      ),
      past: rows.filter(
        (x) => x.status === 'completed' || x.status === 'cancelled',
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
    const { rows: ev } = await this.db.q(
      'SELECT results_status, protest_deadline FROM events WHERE id = $1',
      [eventId],
    );
    if (!ev[0]) throw new NotFoundException('Event not found');
    if (ev[0].results_status === 'none') {
      // Nothing published, but the organiser may be serving a live RaceResult
      // feed. Narrowed to this athlete by registration id, NOT by bib: a bib is
      // unique within an event and an athlete could believe otherwise, but the
      // registration id is the identity the roster resolved the bib to, and it
      // is the only one that cannot hand somebody else's row to this caller.
      const live = await this.live.liveRowsFor(eventId);
      if (live) {
        const { rows: mine } = await this.db.q(
          `SELECT r.id AS registration_id FROM registrations r
            WHERE r.event_id = $1 AND r.athlete_id = $2`,
          [eventId, athleteId],
        );
        const ids = new Set(mine.map((m) => m.registration_id));
        return {
          results_status: 'live',
          protest_deadline: null,
          updated_at: live.fetched_at,
          rows: live.rows.filter(
            (r) => r.registration_id && ids.has(r.registration_id),
          ),
        };
      }
      return { results_status: 'none', rows: [] };
    }

    const { rows } = await this.db.q(
      `SELECT ce.id AS entry_id, r.id AS registration_id, ce.bib, ce.race_status AS status, c.name AS category,
              a.full_name, a.gender, a.city,
              res.total_ms, res.overall_rank, res.gender_rank, res.age_group, res.age_group_rank,
              -- How big the contest was. A bare "3rd" means nothing without it,
              -- and it is the one thing the athlete loses by not being shown the
              -- whole field — so it is counted here rather than inferred from a
              -- list the page no longer has.
              (SELECT count(*)::int FROM category_entries ce2
                WHERE ce2.event_id = ce.event_id AND ce2.category_id = ce.category_id) AS field_size,
              ${TEAM_COLUMNS}
         FROM category_entries ce
         JOIN registrations r ON r.id = ce.registration_id
         JOIN athletes a ON a.id = r.athlete_id
         LEFT JOIN categories c ON c.id = ce.category_id
         LEFT JOIN results res ON res.entry_id = ce.id
        WHERE ce.event_id = $1 AND r.athlete_id = $2
        ORDER BY c.name, ce.bib`,
      [eventId, athleteId],
    );

    return {
      results_status: ev[0].results_status,
      protest_deadline: ev[0].protest_deadline,
      rows,
    };
  }

  /* GET /api/hyfitgames/me/stats — cross-edition performance */
  @Get('stats')
  async myStats(@HfgAthleteId() athleteId: string) {
    const { rows: agg } = await this.db.q(
      `SELECT count(*) FILTER (WHERE ce.race_status = 'FIN')                    AS finishes,
              count(DISTINCT e.id)                                             AS editions,
              min(res.total_ms) FILTER (WHERE e.results_status = 'final')      AS pb_ms,
              min(res.overall_rank) FILTER (WHERE e.results_status = 'final')  AS best_rank
         FROM category_entries ce
         JOIN registrations r ON r.id = ce.registration_id
         JOIN events e ON e.id = ce.event_id
         LEFT JOIN results res ON res.entry_id = ce.id
        WHERE r.athlete_id = $1`,
      [athleteId],
    );

    const { rows: stationBests } = await this.db.q(
      `SELECT st.name, min(s.split_ms) AS best_ms
         FROM splits s
         JOIN stations st ON st.id = s.station_id
         JOIN category_entries ce ON ce.id = s.entry_id
         JOIN registrations r ON r.id = ce.registration_id
        WHERE r.athlete_id = $1
        GROUP BY st.name ORDER BY st.name`,
      [athleteId],
    );

    const { rows: progression } = await this.db.q(
      `SELECT e.name, e.city, e.edition, e.event_date, res.total_ms, res.overall_rank
         FROM category_entries ce
         JOIN registrations r ON r.id = ce.registration_id
         JOIN events e ON e.id = ce.event_id
         JOIN results res ON res.entry_id = ce.id
        WHERE r.athlete_id = $1 AND e.results_status = 'final' AND res.total_ms IS NOT NULL
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

  /* GET /api/hyfitgames/me/full-stats — comprehensive performance dashboard */
  @Get('full-stats')
  async fullStats(@HfgAthleteId() aid: string) {
    const { rows: core } = await this.db.q(
      `SELECT
        count(DISTINCT e.id)::int AS total_events,
        count(*) FILTER (WHERE ce.race_status='FIN')::int AS finishes,
        count(*) FILTER (WHERE ce.race_status='DNF')::int AS dnfs,
        count(*) FILTER (WHERE ce.race_status='DNS')::int AS dns,
        min(res.total_ms) FILTER (WHERE e.results_status='final') AS pb_ms,
        max(res.total_ms) FILTER (WHERE e.results_status='final') AS worst_ms,
        avg(res.total_ms) FILTER (WHERE e.results_status='final')::int AS avg_ms,
        count(*) FILTER (WHERE res.overall_rank=1 AND e.results_status='final')::int AS wins,
        count(*) FILTER (WHERE res.overall_rank<=3 AND e.results_status='final')::int AS podiums,
        count(*) FILTER (WHERE res.overall_rank<=10 AND e.results_status='final')::int AS top10,
        min(res.overall_rank) FILTER (WHERE e.results_status='final') AS best_rank,
        avg(res.overall_rank) FILTER (WHERE e.results_status='final')::numeric(5,1) AS avg_rank,
        count(DISTINCT e.city)::int AS cities_visited
      FROM category_entries ce
      JOIN registrations r ON r.id = ce.registration_id
      JOIN events e ON e.id = ce.event_id
      LEFT JOIN results res ON res.entry_id = ce.id
      WHERE r.athlete_id = $1`,
      [aid],
    );

    const { rows: cityBreakdown } = await this.db.q(
      `SELECT e.city, count(DISTINCT e.id)::int AS events,
             min(res.total_ms) AS best_ms,
             avg(res.total_ms)::int AS avg_ms,
             count(*) FILTER (WHERE res.overall_rank=1)::int AS wins,
             count(*) FILTER (WHERE res.overall_rank<=3)::int AS podiums,
             avg(res.overall_rank)::numeric(5,1) AS avg_rank
        FROM category_entries ce
        JOIN registrations r ON r.id = ce.registration_id
        JOIN events e ON e.id = ce.event_id
        LEFT JOIN results res ON res.entry_id = ce.id
        WHERE r.athlete_id = $1 AND ce.race_status='FIN' AND e.results_status='final'
        GROUP BY e.city ORDER BY events DESC`,
      [aid],
    );

    const { rows: progression } = await this.db.q(
      `SELECT e.name, e.city, e.edition, e.event_date, e.event_date AS date,
             res.total_ms, res.overall_rank, res.gender_rank
        FROM category_entries ce
        JOIN registrations r ON r.id = ce.registration_id
        JOIN events e ON e.id = ce.event_id
        LEFT JOIN results res ON res.entry_id = ce.id
        WHERE r.athlete_id = $1 AND ce.race_status='FIN' AND e.results_status='final'
        ORDER BY e.event_date`,
      [aid],
    );

    const { rows: stationPerf } = await this.db.q(
      `SELECT st.name, st.seq,
             min(s.split_ms) AS best_ms,
             max(s.split_ms) AS worst_ms,
             avg(s.split_ms)::int AS avg_ms,
             count(*)::int AS attempts,
             rank() OVER (PARTITION BY st.seq ORDER BY min(s.split_ms)) AS best_rank_in_station,
             count(*) OVER (PARTITION BY st.seq) AS total_athletes_at_station
        FROM splits s
        JOIN stations st ON st.id = s.station_id
        JOIN category_entries ce ON ce.id = s.entry_id
        JOIN registrations r ON r.id = ce.registration_id
        JOIN events e ON e.id = ce.event_id AND e.results_status='final'
        WHERE r.athlete_id = $1 AND ce.race_status='FIN'
        GROUP BY st.seq, st.name ORDER BY st.seq`,
      [aid],
    );

    const { rows: stationTrend } = await this.db.q(
      `SELECT st.seq, st.name, e.event_date, s.split_ms
        FROM splits s
        JOIN stations st ON st.id = s.station_id
        JOIN category_entries ce ON ce.id = s.entry_id
        JOIN registrations r ON r.id = ce.registration_id
        JOIN events e ON e.id = ce.event_id
        WHERE r.athlete_id = $1 AND ce.race_status='FIN' AND e.results_status='final'
        ORDER BY e.event_date, st.seq`,
      [aid],
    );

    const { rows: monthlyPerf } = await this.db.q(
      `SELECT to_char(e.event_date, 'YYYY-MM') AS month,
             count(DISTINCT e.id)::int AS events,
             avg(res.total_ms)::int AS avg_ms,
             min(res.total_ms) AS best_ms
        FROM category_entries ce
        JOIN registrations r ON r.id = ce.registration_id
        JOIN events e ON e.id = ce.event_id
        LEFT JOIN results res ON res.entry_id = ce.id
        WHERE r.athlete_id = $1 AND ce.race_status='FIN' AND e.results_status='final'
        GROUP BY to_char(e.event_date, 'YYYY-MM')
        ORDER BY to_char(e.event_date, 'YYYY-MM')`,
      [aid],
    );

    const { rows: pctl } = await this.db.q(
      `WITH all_finishers AS (
        SELECT res.total_ms, res.entry_id
          FROM results res
          JOIN category_entries ce ON ce.id = res.entry_id
          JOIN registrations r ON r.id = ce.registration_id
          JOIN events e ON e.id = ce.event_id
          WHERE e.results_status='final' AND ce.race_status='FIN'
      ),
      my_times AS (
        SELECT res.total_ms FROM results res
          JOIN category_entries ce ON ce.id = res.entry_id
          JOIN registrations r ON r.id = ce.registration_id
          WHERE r.athlete_id = $1 AND ce.race_status='FIN'
      )
      SELECT
        round(100.0 * count(*) FILTER (WHERE af.total_ms > mt.total_ms) /
              nullif(count(*), 0), 1) AS percentile
      FROM my_times mt, all_finishers af`,
      [aid],
    );

    const { rows: consistency } = await this.db.q(
      `SELECT stddev_samp(res.total_ms)::int AS std_dev,
             count(*)::int AS n
        FROM results res
        JOIN category_entries ce ON ce.id = res.entry_id
        JOIN registrations r ON r.id = ce.registration_id
        WHERE r.athlete_id = $1 AND ce.race_status='FIN' AND res.total_ms IS NOT NULL`,
      [aid],
    );

    const { rows: allDates } = await this.db.q(
      `SELECT e.event_date, ce.race_status AS status
        FROM category_entries ce
        JOIN registrations r ON r.id = ce.registration_id
        JOIN events e ON e.id = ce.event_id
        WHERE r.athlete_id = $1 ORDER BY e.event_date`,
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

    const { rows: genderRank } = await this.db.q(
      `SELECT avg(res.gender_rank)::numeric(5,1) AS avg_gender_rank,
             count(*) FILTER (WHERE res.gender_rank=1)::int AS gender_wins
        FROM results res
        JOIN category_entries ce ON ce.id = res.entry_id
        JOIN registrations r ON r.id = ce.registration_id
        JOIN events e ON e.id = ce.event_id
        WHERE r.athlete_id = $1 AND e.results_status='final'`,
      [aid],
    );

    const athlete = (
      await this.db.q('SELECT * FROM athletes WHERE id=$1', [aid])
    ).rows[0];

    return {
      athlete,
      core: core[0],
      cityBreakdown,
      progression,
      stationPerf,
      stationTrend,
      monthlyPerf,
      percentile: pctl[0]?.percentile || 0,
      consistency: consistency[0],
      streaks: { current: ongoingStreak, longest: longestStreak },
      genderRank: genderRank[0],
    };
  }
}
