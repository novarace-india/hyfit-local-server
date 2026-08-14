import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { HfgDbService } from '../hfg-db.service';
import { HfgCacheService } from '../hfg-cache.service';
import { HfgCertificateService } from '../services/hfg-certificate.service';
import { HfgLiveResultsService } from '../services/hfg-live-results.service';
import { HfgAthleteGuard } from '../guards/hfg-athlete.guard';
import { HfgAthleteId } from '../decorators/hfg-user.decorator';
import { TEAM_COLUMNS } from '../hfg.util';

// Public event data: listing, detail, live leaderboard, results, scorecard, and
// the finisher certificate PDF (athlete-only). Ported from routes/events.js.
// Read responses are cached in Valkey under the `hyfitgames:` namespace.
@Public()
@Controller('hyfitgames/events')
export class HfgEventsController {
  constructor(
    private readonly db: HfgDbService,
    private readonly cache: HfgCacheService,
    private readonly certificate: HfgCertificateService,
    private readonly live: HfgLiveResultsService,
  ) {}

  // Advertise whether a response was served from the Valkey cache. `HIT` means
  // it came from the `hyfitgames:` cache namespace; `MISS` means it was just
  // computed from the database (and freshly cached). Visible via `curl -i` or
  // the Network tab; it never alters the JSON body.
  private mark(res: Response, hit: boolean) {
    res.setHeader('X-HFG-Cache', hit ? 'HIT' : 'MISS');
  }

  /* GET /api/hyfitgames/events — all editions, newest first */
  @Get()
  async list(@Res({ passthrough: true }) res: Response) {
    const key = this.cache.eventsListKey();
    const cached = await this.cache.get(key);
    if (cached) {
      this.mark(res, true);
      return cached;
    }

    // The participant count is a correlated subquery rather than a
    // LEFT JOIN + GROUP BY e.id. Grouping by the key alone relies on
    // primary-key functional dependency to license the bare e.* columns, and
    // `events` is a view over hyfit.events since migration 046 — a view has no
    // primary key, so Postgres rejects that form with "column e.name must
    // appear in the GROUP BY clause".
    const { rows } = await this.db.q(
      `SELECT e.*,
              (SELECT count(*)::int FROM registrations r WHERE r.event_id = e.id) AS participants
         FROM events e ORDER BY e.event_date DESC`,
    );
    await this.cache.set(key, rows, this.cache.ttl().EVENTS_LIST);
    this.mark(res, false);
    return rows;
  }

  /* GET /api/hyfitgames/events/:id */
  @Get(':id')
  async detail(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = this.cache.eventKey(id);
    const cached = await this.cache.get(key);
    if (cached) {
      this.mark(res, true);
      return cached;
    }

    const { rows } = await this.db.q('SELECT * FROM events WHERE id = $1', [
      id,
    ]);
    if (!rows[0]) throw new NotFoundException('Event not found');
    const { rows: stations } = await this.db.q(
      'SELECT id, seq, name FROM stations WHERE event_id = $1 ORDER BY seq',
      [id],
    );
    const { rows: announcements } = await this.db.q(
      'SELECT id, title, body, created_at FROM announcements WHERE event_id = $1 ORDER BY created_at DESC LIMIT 20',
      [id],
    );
    const out = { ...rows[0], stations, announcements };
    await this.cache.set(key, out, this.cache.ttl().EVENT);
    this.mark(res, false);
    return out;
  }

  /* GET /api/hyfitgames/events/:id/contests — contest-level summary.
   * Returns each contest with participant count, finishers, and age group breakdown. */
  @Get(':id/contests')
  async contests(@Param('id') id: string) {
    const { rows: ev } = await this.db.q(
      'SELECT status, results_status FROM events WHERE id = $1',
      [id],
    );
    if (!ev[0]) throw new NotFoundException('Event not found');

    const { rows: contestRows } = await this.db.q(
      `SELECT c.name AS category,
              count(*)::int AS total,
              count(*) FILTER (WHERE ce.race_status = 'FIN')::int AS finishers,
              count(*) FILTER (WHERE ce.race_status = 'DNF')::int AS dnfs,
              count(*) FILTER (WHERE ce.race_status = 'DNS')::int AS dns,
              min(res.total_ms) AS best_time,
              count(DISTINCT a.gender)::int AS genders,
              array_agg(DISTINCT a.gender) AS gender_list
         FROM category_entries ce
         JOIN registrations r ON r.id = ce.registration_id
         JOIN athletes a ON a.id = r.athlete_id
         JOIN categories c ON c.id = ce.category_id
         LEFT JOIN results res ON res.entry_id = ce.id
        WHERE ce.event_id = $1
        GROUP BY c.name
        ORDER BY c.name`,
      [id],
    );

    // Age group breakdown per contest
    const { rows: ageBreakdown } = await this.db.q(
      `SELECT c.name AS category, res.age_group,
              count(*)::int AS athletes,
              min(res.total_ms) AS best_time
         FROM category_entries ce
         JOIN registrations r ON r.id = ce.registration_id
         JOIN categories c ON c.id = ce.category_id
         LEFT JOIN results res ON res.entry_id = ce.id
        WHERE ce.event_id = $1 AND res.age_group IS NOT NULL
        GROUP BY c.name, res.age_group
        ORDER BY c.name, res.age_group`,
      [id],
    );

    // Group age breakdown by contest
    const ageByContest: Record<
      string,
      { age_group: string; athletes: number; best_time: number | null }[]
    > = {};
    for (const row of ageBreakdown) {
      (ageByContest[row.category] ||= []).push({
        age_group: row.age_group,
        athletes: row.athletes,
        best_time: row.best_time,
      });
    }

    return {
      status: ev[0].status,
      results_status: ev[0].results_status,
      contests: contestRows.map((c: any) => ({
        category: c.category,
        total: c.total,
        finishers: c.finishers,
        dnfs: c.dnfs,
        dns: c.dns,
        best_time: c.best_time,
        age_groups: ageByContest[c.category] || [],
      })),
    };
  }

  /* GET /api/hyfitgames/events/:id/leaderboard?gender=&age_group=&category=&limit=&search= */
  @Get(':id/leaderboard')
  async leaderboard(
    @Param('id') id: string,
    @Query('gender') gender?: string,
    @Query('age_group') age_group?: string,
    @Query('category') category?: string,
    @Query('search') search?: string,
    @Query('limit') limitRaw?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const limit = Math.min(parseInt(limitRaw || '100', 10), 500);
    const qs = JSON.stringify({ gender, age_group, category, search, limit });

    // A live RaceResult feed replaces the split-derived board outright rather
    // than merging with it. The two answer the same question from different
    // sources — the feed IS the timing system's view of the race — and showing
    // both would put an athlete's RaceResult time next to a partial time
    // assembled from whichever splits happened to be recorded.
    const live = await this.live.liveRowsFor(id);
    if (live) {
      if (res) this.mark(res, false);
      return this.liveLeaderboard(live, {
        gender,
        age_group,
        category,
        search,
        limit,
      });
    }

    const key = this.cache.leaderboardKey(id, qs);
    const cached = await this.cache.get(key);
    if (cached) {
      if (res) this.mark(res, true);
      return cached;
    }

    const params: unknown[] = [id];
    let where = `ce.event_id = $1 AND ce.race_status NOT IN ('DNS','DQ')`;
    if (gender) {
      params.push(gender);
      where += ` AND a.gender = $${params.length}`;
    }
    if (category) {
      params.push(category);
      where += ` AND c.name = $${params.length}`;
    }
    if (age_group) {
      params.push(age_group);
      where += ` AND res.age_group = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (a.full_name ILIKE $${params.length} OR ce.bib ILIKE $${params.length})`;
    }
    params.push(limit);

    const { rows } = await this.db.q(
      `SELECT ce.id AS entry_id, r.id AS registration_id, ce.bib, ce.race_status AS status, c.name AS category, ce.wave, ce.timeslot,
              a.full_name, a.gender, a.city,
              count(s.id)::int AS stations_done,
              COALESCE(sum(s.split_ms), 0)::int AS cum_ms,
              max(s.recorded_at) AS last_seen,
              res.total_ms, res.overall_rank, res.gender_rank, res.age_group, res.age_group_rank,
              ${TEAM_COLUMNS}
         FROM category_entries ce
         JOIN registrations r ON r.id = ce.registration_id
         JOIN athletes a ON a.id = r.athlete_id
         LEFT JOIN categories c ON c.id = ce.category_id
         LEFT JOIN splits s ON s.entry_id = ce.id
         LEFT JOIN results res ON res.entry_id = ce.id
        WHERE ${where}
        GROUP BY ce.id, r.id, a.id, c.name, res.entry_id, res.total_ms, res.overall_rank,
                 res.gender_rank, res.age_group, res.age_group_rank
        ORDER BY (ce.race_status = 'DNF') ASC, stations_done DESC, cum_ms ASC NULLS LAST
        LIMIT $${params.length}`,
      params,
    );

    const { rows: catRows } = await this.db.q(
      `SELECT DISTINCT c.name AS category FROM category_entries ce
         JOIN categories c ON c.id = ce.category_id
        WHERE ce.event_id = $1 ORDER BY c.name`,
      [id],
    );
    const categories = catRows.map((c: any) => c.category);

    // Carried on the board itself so the page does not have to correlate it
    // with a separately-fetched event: the live path below returns 'live' here,
    // and that is the one value the event detail endpoint can never report,
    // because a live feed leaves `events.results_status` at 'none' by design.
    const { rows: ev0 } = await this.db.q(
      'SELECT results_status FROM events WHERE id = $1',
      [id],
    );

    const out = {
      updatedAt: new Date().toISOString(),
      results_status: ev0[0]?.results_status ?? 'none',
      categories,
      rows,
    };
    await this.cache.set(key, out, this.cache.ttl().LEADERBOARD);
    if (res) this.mark(res, false);
    return out;
  }

  /* The same board, built from a cached RaceResult feed instead of splits.
   *
   * The filters are applied here rather than in SQL for the obvious reason —
   * there is no query — but the semantics are kept identical to the database
   * path above, including dropping DNS and DQ entries, because a board that
   * quietly changed which athletes it contained when the organiser flipped a
   * switch would be worse than one that changed where the numbers came from.
   *
   * `cum_ms` mirrors `total_ms`: the page reads `cum_ms` for an unofficial
   * board, and for a live feed the finish time IS the running total. There are
   * no splits behind it, so `stations_done` is null and the page shows the
   * live status line instead of "n/6 stations".
   */
  private liveLeaderboard(
    live: { fetched_at: string; rows: any[] },
    f: {
      gender?: string;
      age_group?: string;
      category?: string;
      search?: string;
      limit: number;
    },
  ) {
    const needle = (f.search || '').trim().toLowerCase();
    const rows = live.rows
      .filter((r) => !r.unmatched)
      .filter((r) => r.status !== 'DNS' && r.status !== 'DQ')
      .filter((r) => !f.gender || r.gender === f.gender)
      .filter((r) => !f.category || r.category === f.category)
      .filter((r) => !f.age_group || r.age_group === f.age_group)
      .filter(
        (r) =>
          !needle ||
          r.bib.toLowerCase().includes(needle) ||
          (r.full_name ?? '').toLowerCase().includes(needle),
      )
      .map((r) => ({
        ...r,
        cum_ms: r.total_ms,
        stations_done: null,
        wave: null,
        timeslot: null,
      }))
      .sort((a, b) => {
        // DNF last, then fastest first, then anyone still without a time.
        const dnf = Number(a.status === 'DNF') - Number(b.status === 'DNF');
        if (dnf) return dnf;
        if (a.total_ms === null) return b.total_ms === null ? 0 : 1;
        if (b.total_ms === null) return -1;
        return a.total_ms - b.total_ms;
      })
      .slice(0, f.limit);

    const categories = [
      ...new Set(live.rows.map((r) => r.category).filter(Boolean)),
    ].sort();

    return {
      updatedAt: live.fetched_at,
      results_status: 'live',
      categories,
      rows,
    };
  }

  /* GET /api/hyfitgames/events/:id/results?search= */
  @Get(':id/results')
  async results(
    @Param('id') id: string,
    @Query('search') search?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const qs = JSON.stringify({ search: search || '' });
    const key = this.cache.resultsKey(id, qs);
    const cached = await this.cache.get(key);
    if (cached) {
      if (res) this.mark(res, true);
      return cached;
    }

    const { rows: ev } = await this.db.q(
      'SELECT results_status, protest_deadline FROM events WHERE id = $1',
      [id],
    );
    if (!ev[0]) throw new NotFoundException('Event not found');
    if (ev[0].results_status === 'none') {
      // Nothing published — but the organiser may be serving a live RaceResult
      // feed. `results_status: 'live'` is its own value rather than a borrowed
      // 'provisional': provisional means published and open to protest, and
      // these numbers are neither. Deliberately not written to the results
      // cache; a live feed that sat there for 30s would be a leaderboard the
      // operator could not correct.
      const live = await this.live.liveRowsFor(id);
      if (res) this.mark(res, false);
      if (live) {
        const needle = (search || '').trim().toLowerCase();
        return {
          results_status: 'live',
          protest_deadline: null,
          updated_at: live.fetched_at,
          // An unmatched row is a bib the roster does not have. It is a real
          // signal for the operator and noise for everyone else — there is no
          // athlete here for it to be the result of.
          rows: live.rows.filter(
            (r) =>
              !r.unmatched &&
              (!needle ||
                r.bib.toLowerCase().includes(needle) ||
                (r.full_name ?? '').toLowerCase().includes(needle)),
          ),
        };
      }
      return { results_status: 'none', rows: [] };
    }

    const params: unknown[] = [id];
    let where = 'ce.event_id = $1';
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (a.full_name ILIKE $${params.length} OR ce.bib ILIKE $${params.length})`;
    }
    const { rows } = await this.db.q(
      `SELECT ce.id AS entry_id, r.id AS registration_id, ce.bib, ce.race_status AS status, c.name AS category,
              a.full_name, a.gender, a.city,
              res.total_ms, res.overall_rank, res.gender_rank, res.age_group, res.age_group_rank,
              ${TEAM_COLUMNS}
         FROM category_entries ce
         JOIN registrations r ON r.id = ce.registration_id
         JOIN athletes a ON a.id = r.athlete_id
         LEFT JOIN categories c ON c.id = ce.category_id
         LEFT JOIN results res ON res.entry_id = ce.id
        WHERE ${where}
        -- A team's placing is the one that counts for its members, so order by
        -- it when there is one and fall back to the individual placing.
        ORDER BY c.name, COALESCE(res.team_rank, res.overall_rank) ASC NULLS LAST, ce.bib`,
      params,
    );
    const out = {
      results_status: ev[0].results_status,
      protest_deadline: ev[0].protest_deadline,
      rows,
    };
    await this.cache.set(key, out, this.cache.ttl().RESULTS);
    if (res) this.mark(res, false);
    return out;
  }

  /* GET /api/hyfitgames/events/:eventId/scorecard/:regId — comprehensive
   * scorecard data. No auth (spectators can view too). */
  @Get(':eventId/scorecard/:regId')
  async scorecard(
    @Param('eventId') eventId: string,
    @Param('regId') regId: string,
  ) {
    const { rows } = await this.db.q(
      `SELECT ce.*, a.full_name, a.gender, a.city, a.dob,
              e.name AS event_name, e.city AS event_city, e.venue, e.event_date,
              e.status AS event_status, e.results_status,
              r.id AS registration_id,
              c.name AS category_name,
              res.total_ms, res.overall_rank, res.gender_rank, res.age_group, res.age_group_rank,
              ${TEAM_COLUMNS}
         FROM category_entries ce
         JOIN registrations r ON r.id = ce.registration_id
         JOIN athletes a ON a.id = r.athlete_id
         JOIN events e ON e.id = ce.event_id
         LEFT JOIN categories c ON c.id = ce.category_id
         LEFT JOIN results res ON res.entry_id = ce.id
        WHERE ce.id = $1 AND ce.event_id = $2`,
      [regId, eventId],
    );
    if (!rows[0]) throw new NotFoundException('Registration not found');
    const athlete = rows[0];

    const { rows: splits } = await this.db.q(
      `WITH all_splits AS (
         SELECT s.entry_id, st.seq, st.name, s.split_ms,
                rank() OVER (PARTITION BY st.seq ORDER BY s.split_ms) AS station_rank,
                count(*) OVER (PARTITION BY st.seq) AS station_total
           FROM splits s
           JOIN stations st ON st.id = s.station_id
           JOIN category_entries ce ON ce.id = s.entry_id
          WHERE ce.event_id = $2
            AND ce.race_status = 'FIN'
       )
       SELECT asl.seq, asl.name, asl.split_ms,
              sum(asl.split_ms) OVER (ORDER BY asl.seq) AS cum_ms,
              asl.station_rank, asl.station_total
         FROM all_splits asl
        WHERE asl.entry_id = $1
        ORDER BY asl.seq`,
      [regId, eventId],
    );

    const { rows: stationBests } = await this.db.q(
      `SELECT st.seq, st.name, min(s.split_ms) AS best_ms, max(s.split_ms) AS worst_ms,
              avg(s.split_ms)::int AS avg_ms
         FROM splits s
         JOIN stations st ON st.id = s.station_id
         JOIN category_entries ce ON ce.id = s.entry_id
        WHERE ce.event_id = $1
          AND ce.race_status = 'FIN'
        GROUP BY st.seq, st.name
        ORDER BY st.seq`,
      [eventId],
    );

    const { rows: winner } = await this.db.q(
      `SELECT res.total_ms, a.full_name
         FROM results res
         JOIN category_entries ce ON ce.id = res.entry_id
         JOIN registrations r ON r.id = ce.registration_id
         JOIN athletes a ON a.id = r.athlete_id
        WHERE ce.event_id = $1 AND res.overall_rank = 1`,
      [eventId],
    );

    const { rows: counts } = await this.db.q(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE ce.race_status = 'FIN')::int AS finishers
         FROM category_entries ce WHERE ce.event_id = $1`,
      [eventId],
    );

    return {
      athlete,
      splits,
      stationBests,
      winner: winner[0] || null,
      participants: counts[0],
    };
  }

  /* GET /api/hyfitgames/events/registrations/:regId/certificate — PDF
   * (auth: own only). Available only once results are FINAL and finished. */
  @UseGuards(HfgAthleteGuard)
  @Get('registrations/:regId/certificate')
  async certificatePdf(
    @HfgAthleteId() athleteId: string,
    @Param('regId') regId: string,
    @Res() res: Response,
  ) {
    const { rows } = await this.db.q(
      `SELECT ce.id, ce.bib, ce.race_status AS status, a.full_name, a.gender,
              e.name AS event_name, e.city, e.edition, e.event_date, e.results_status,
              r.id AS registration_id,
              res.total_ms, res.overall_rank, res.gender_rank, res.age_group, res.age_group_rank
         FROM category_entries ce
         JOIN registrations r ON r.id = ce.registration_id
         JOIN athletes a ON a.id = r.athlete_id
         JOIN events e ON e.id = ce.event_id
         LEFT JOIN results res ON res.entry_id = ce.id
        WHERE ce.id = $1 AND r.athlete_id = $2`,
      [regId, athleteId],
    );
    const d = rows[0];
    if (!d) throw new NotFoundException('Registration not found');
    if (d.results_status !== 'final')
      throw new BadRequestException(
        'Certificates unlock once results are final',
      );
    if (d.status !== 'FIN')
      throw new BadRequestException(
        'Certificates are issued to finishers only',
      );

    // idempotent serial
    const { rows: cert } = await this.db.q(
      `INSERT INTO certificates (entry_id, serial)
       VALUES ($1::uuid, 'HYFIT-' || upper(substr(md5($1::uuid::text), 1, 10)))
       ON CONFLICT (entry_id, type) DO UPDATE SET entry_id = EXCLUDED.entry_id
       RETURNING serial`,
      [d.id],
    );

    this.certificate.streamCertificate(res, { ...d, serial: cert[0].serial });
  }
}
