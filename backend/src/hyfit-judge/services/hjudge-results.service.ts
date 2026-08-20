import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { HjudgeDbService } from '../hjudge-db.service';
import { HjudgeCacheService } from '../hjudge-cache.service';
import { HjudgeRaceResultService } from './hjudge-raceresult.service';
import {
  findRows,
  parseResults,
  REJECTION_DETAIL_CAP,
  type ImportedResult,
  type ResultRejection,
} from '../hjudge-results-import.util';
import { parseParticipantImport } from '../hjudge-participant-import.util';

/**
 * Results, from RaceResult into whichever of the two places the event says.
 *
 * RaceResult scores the race; this service decides what becomes of the
 * standings it publishes. An event is in one of three states
 * (`events.results_mode`):
 *
 *   off     nothing is published — the public read answers 404
 *   live    the last pull is served out of Valkey. Provisional by construction:
 *           it expires, every pull replaces it, and nothing about it is kept.
 *   stored  `hyfit_v2.results` is served. Somebody consciously wrote it there.
 *
 * THE ONE RULE THIS SERVICE EXISTS TO KEEP: a live pull writes to the cache and
 * nothing else. The tables are touched by `store()` alone. An operator can pull
 * a mid-race feed twenty times and the database still holds exactly what they
 * last chose to keep — which is what makes putting an unfinished race in front
 * of athletes safe at all.
 *
 * Both paths shape their rows through `toRow`, so the live and stored answers
 * are the same object with a different provenance. Two shapes would mean two
 * renderers to keep in step, and the doubles half of that is precisely the code
 * that has needed three passes to get right before.
 */

/** How long a pull may be served. It is the source of truth for a race in
 *  progress, so it has to outlive the race: twelve hours covers the longest
 *  event day with the venue's wifi dropping in the middle of it, and every pull
 *  resets the clock. */
const LIVE_TTL_SECONDS = 12 * 60 * 60;

const FETCH_TIMEOUT_MS = 15_000;

export type ResultRow = {
  bib: string;
  name: string;
  /** The contest. The age band, when the feed names one, is `age_group`. */
  category: string | null;
  club: string | null;
  status: string;
  rank: number | null;
  /** The band `age_group_rank` counts within — "Next Gen Boys 12-15". Null when
   *  the feed publishes only one contest column. A placing with no band beside
   *  it reads as "#1" on every athlete in every band. */
  age_group: string | null;
  age_group_rank: number | null;
  /** The athlete's age ON RACE DAY, as the export gave it — the age
   *  `age_group` was judged against. Not read from the athlete row, which every
   *  later import overwrites. See migration 089. */
  age: number | null;
  total_ms: number | null;
  team_time_ms: number | null;
  /** The pair's placing, from the feed. Null for a solo entry — like
   *  `team_time_ms`, its presence is what says this row raced as a team. */
  team_rank: number | null;
  /** The circuit, in course order: the cognitive segment, then six run/station
   *  pairs. Null where the feed carried nothing — an athlete still out on
   *  course has most of this empty, which is the point of showing it. */
  cog_ms: number | null;
  run_ms: (number | null)[];
  station_ms: (number | null)[];
  penalties: Record<string, string>;
  /** Every other time the feed published for this row, by its own column name
   *  ({"HyZone": "2:46"}). Unparsed on purpose — see `collectExtraTimes`. */
  extra_times: Record<string, string>;
};

/** One `results` row, as its columns come out of Postgres or off the wire,
 *  turned into the shape every reader of this module expects. Shared by the
 *  stored read and by the ingest path so the two cannot drift. */
function rowFromColumns(r: Record<string, any>): ResultRow {
  return {
    bib: r.bib,
    name: r.name,
    category: r.category ?? null,
    club: r.club ?? null,
    status: r.status,
    rank: r.rank ?? null,
    age_group: r.age_group ?? null,
    age_group_rank: r.age_group_rank ?? null,
    age: r.age ?? null,
    total_ms: numeric(r.total_ms),
    team_time_ms: numeric(r.team_time_ms),
    team_rank: r.team_rank ?? null,
    cog_ms: numeric(r.cog_ms),
    run_ms: [
      r.run1_ms,
      r.run2_ms,
      r.run3_ms,
      r.run4_ms,
      r.run5_ms,
      r.run6_ms,
    ].map(numeric),
    station_ms: [
      r.st1_ms,
      r.st2_ms,
      r.st3_ms,
      r.st4_ms,
      r.st5_ms,
      r.st6_ms,
    ].map(numeric),
    penalties: r.penalties ?? {},
    extra_times: r.extra_times ?? {},
  };
}

export type ResultsPayload = {
  event_id: string;
  event_name: string;
  source: 'live' | 'stored';
  url: string | null;
  fetched_at: string;
  source_count: number;
  rejected: number;
  /* Which rows were dropped and why — see ResultRejection. Carried on the
   * payload rather than only logged, because the operator who can fix the
   * export is standing at the console, not reading the server's log. Optional:
   * a payload cached by an older build has none. */
  rejections?: ResultRejection[];
  rows: ResultRow[];
};

type EventRow = {
  id: string;
  name: string;
  results_mode: 'off' | 'live' | 'stored';
  results_stored_at: string | null;
  name_shared: boolean;
};

@Injectable()
export class HjudgeResultsService {
  private readonly logger = new Logger(HjudgeResultsService.name);

  constructor(
    private readonly db: HjudgeDbService,
    private readonly cache: HjudgeCacheService,
    private readonly raceResult: HjudgeRaceResultService,
  ) {}

  // ─────────────────────────────────────────────────────────────── the event

  private async event(eventId: string): Promise<EventRow> {
    const { rows } = await this.db.q<EventRow>(
      // `name_shared` decides the cache key below. The slug is computed in SQL
      // rather than by loading every event's name, and it must square exactly
      // with `slug()` in this file — same lowercase, same non-alphanumeric run
      // collapsed to one dash.
      `SELECT e.id, e.name, e.results_mode, e.results_stored_at,
              EXISTS (
                SELECT 1 FROM events x
                 WHERE x.id <> e.id
                   AND lower(btrim(regexp_replace(x.name, '[^a-zA-Z0-9]+', '-', 'g'), '-'))
                     = lower(btrim(regexp_replace(e.name, '[^a-zA-Z0-9]+', '-', 'g'), '-'))
              ) AS name_shared
         FROM events e WHERE e.id = $1`,
      [eventId],
    );
    if (!rows[0]) throw new NotFoundException('Event not found');
    return rows[0];
  }

  /** `hyfitgames:results:{event name}`, as asked for — the key is the event's
   *  name because that is what an operator looking into Valkey during a race
   *  will search for.
   *
   *  Two events may legitimately share a name (an edition run twice, a rename
   *  half-finished), and one silently serving the other's standings is the
   *  worst failure this feature has available to it. So a shared name — and
   *  only a shared name — gets the event id appended. The common case keeps the
   *  readable key. */
  /* The dropped rows, in the log, in the file's own order.
   *
   * The console shows the same list — this is for afterwards: the operator who
   * says "seven were rejected" a week later, or the run nobody was watching.
   * One line per row rather than a blob, because that is what grep is for, and
   * capped by the same cap the response carries so a broken export cannot fill
   * a disk with its own contents. */
  private logRejections(
    origin: string,
    rejections: ResultRejection[],
    total: number,
  ) {
    const shown = rejections.slice(0, REJECTION_DETAIL_CAP);
    this.logger.warn(
      `${origin}: ${total} row(s) rejected` +
        (total > shown.length ? `, first ${shown.length} listed` : '') +
        ' — ' +
        shown
          .map(
            (r) =>
              `${r.row ? `row ${r.row}` : 'row ?'} bib "${r.bib}"` +
              `${r.name ? ` (${r.name})` : ''}` +
              `${r.category ? ` in ${r.category}` : ''}: ${REJECTION_REASONS[r.reason]}`,
          )
          .join('; '),
    );
  }

  private liveKey(event: EventRow) {
    const base = `hyfitgames:results:${slug(event.name)}`;
    return event.name_shared ? `${base}:${event.id}` : base;
  }

  // ──────────────────────────────────────────────────────────── the console

  /** Everything the Results screen needs in one call: the mode, whether an
   *  endpoint is configured at all, what is in the cache, and what is in the
   *  tables. */
  async state(eventId: string) {
    const event = await this.event(eventId);
    const config = await this.raceResult.loadConfig(eventId);
    const cached = await this.readCache(event);

    const { rows: counts } = await this.db.q<{
      results: number;
      athletes: number;
    }>(
      `SELECT (SELECT count(*)::int FROM results  WHERE event_id = $1) AS results,
              (SELECT count(*)::int FROM athletes WHERE event_id = $1) AS athletes`,
      [eventId],
    );

    return {
      eventId,
      eventName: event.name,
      mode: event.results_mode,
      // The URL itself is a credential (it carries its own access key), so the
      // console is told whether one exists, not what it is. Editing it is the
      // Operations screen's job, where it is loaded deliberately.
      resultsConfigured: /^https?:\/\//i.test(config.resultsUrl),
      participantConfigured: /^https?:\/\//i.test(config.participantApiUrl),
      cacheKey: this.liveKey(event),
      live: cached
        ? {
            fetched_at: cached.fetched_at,
            rows: cached.rows.length,
            rejected: cached.rejected,
            // Still answerable an hour after the pull, which is when somebody
            // asks. A payload cached by a build before this shipped has none,
            // and reads as an empty list rather than a wrong one.
            rejections: cached.rejections ?? [],
          }
        : null,
      stored: {
        results: counts[0].results,
        athletes: counts[0].athletes,
        at: event.results_stored_at,
      },
    };
  }

  async setMode(eventId: string, mode: string) {
    if (!['off', 'live', 'stored'].includes(mode))
      throw new BadRequestException("mode must be 'off', 'live' or 'stored'");

    const { rows } = await this.db.q(
      `UPDATE events SET results_mode = $2, updated_at = now()
        WHERE id = $1 RETURNING results_mode`,
      [eventId, mode],
    );
    if (!rows[0]) throw new NotFoundException('Event not found');
    await this.cache.invalidateEvent(eventId);
    return { mode: rows[0].results_mode };
  }

  /** Throw the cached pull away without touching the mode. Kept separate on
   *  purpose: "that pull was wrong" and "stop showing results" are different
   *  intentions, and an operator who meant the first should not silently get
   *  the second. */
  async discard(eventId: string) {
    const event = await this.event(eventId);
    await this.cache.delete(this.liveKey(event));
    return { discarded: true };
  }

  // ───────────────────────────────────────────────────────────────── pulling

  /**
   * Pull the results endpoint and cache what comes back.
   *
   * Synchronous, unlike the athlete import: it writes one Valkey key rather
   * than a table's worth of rows, and the operator is standing at the console
   * waiting to look at the standings before deciding whether to show them.
   */
  async pull(eventId: string, override?: string): Promise<ResultsPayload> {
    const config = await this.raceResult.loadConfig(eventId);
    const url = resultsUrl(config.resultsUrl, override);
    const raw = await this.fetchJson(url);
    return this.cacheStandings(
      eventId,
      raw,
      config.resultsMapping,
      url,
      'RaceResult',
    );
  }

  /**
   * The same pull, from a file an operator picked instead of an endpoint.
   *
   * It exists for the event whose standings cannot be fetched: an offline
   * venue, a RaceResult server that is down, an export that arrived by email.
   * Everything after the file is read is the fetched path exactly — the same
   * parser, the same mapping, the same key, the same read-back check — because
   * a second way of reading a feed is a second way for it to be read WRONGLY,
   * and the file is usually the same export the endpoint would have served.
   */
  async pullUpload(
    eventId: string,
    raw: unknown,
    label: string,
  ): Promise<ResultsPayload> {
    const config = await this.raceResult.loadConfig(eventId);
    return this.cacheStandings(
      eventId,
      uploadedList(raw, config.resultsMapping, quoted(label)),
      withoutListPath(config.resultsMapping),
      // No URL: nothing was fetched from anywhere, and the field is a
      // credential the console would otherwise be handing back a fake of.
      null,
      quoted(label),
    );
  }

  private async cacheStandings(
    eventId: string,
    raw: unknown,
    mapping: Record<string, unknown>,
    url: string | null,
    origin: string,
  ): Promise<ResultsPayload> {
    const event = await this.event(eventId);
    const { results, rejectedCount, rejections, sourceColumns } = parseResults(
      raw,
      mapping,
    );
    if (!results.length)
      throw new BadRequestException(
        noUsableRows(origin, rejectedCount, sourceColumns),
      );

    if (rejections.length) this.logRejections(origin, rejections, rejectedCount);

    const payload: ResultsPayload = {
      event_id: eventId,
      event_name: event.name,
      source: 'live',
      url,
      fetched_at: new Date().toISOString(),
      source_count: results.length,
      rejected: rejectedCount,
      rejections,
      rows: results.map(toRow),
    };

    await this.cache.set(this.liveKey(event), payload, LIVE_TTL_SECONDS);

    // Read it back before calling this a success. CacheService.set SWALLOWS a
    // dead Valkey — it logs and returns — so without this check a pull with no
    // cache behind it reports "1087 rows cached", the operator switches live
    // results on, and the public page serves nothing. Live mode is entirely
    // Valkey; if it is not there, that has to be said out loud here.
    const stored = await this.cache
      .get<ResultsPayload>(this.liveKey(event))
      .catch(() => null);
    if (!stored?.rows?.length)
      throw new BadRequestException(
        `Parsed ${results.length} rows, but the cache did not accept them — Valkey looks unavailable. Import into the database instead, or fix the cache before switching live results on.`,
      );

    await this.cache.invalidateEvent(eventId);
    this.logger.log(
      `Results pull for ${event.name} from ${origin}: ${results.length} rows, ${rejectedCount} rejected → ${this.liveKey(event)}`,
    );
    return payload;
  }

  /**
   * Pull the results endpoint and write it to `athletes` + `results`.
   *
   * The tables are REPLACED for this event, not merged: an import is the
   * standings as RaceResult holds them, and a bib that has left the feed has
   * left the results. Athletes are upserted rather than replaced — the start
   * list outlives any one scoring run, and a person who did not finish still
   * entered.
   *
   * A bib in the standings with no start-list row behind it gets an athlete
   * created from the result row itself, marked `source = 'results'`. The
   * alternative — dropping it — loses a real finisher because an import ran in
   * the wrong order.
   */
  async store(
    eventId: string,
    override?: string,
  ): Promise<{
    imported: number;
    athletesCreated: number;
    rejected: number;
    at: string;
  }> {
    const config = await this.raceResult.loadConfig(eventId);
    const url = resultsUrl(config.resultsUrl, override);
    const raw = await this.fetchJson(url);
    return this.writeStandings(
      eventId,
      raw,
      config.resultsMapping,
      url,
      'RaceResult',
    );
  }

  /**
   * The same import, from a file. See `pullUpload` for why this exists; the
   * only difference here is what `results.source_url` records — `upload:<file>`
   * rather than an endpoint, so an operator reading the table months later can
   * tell standings that were fetched from standings that were carried in.
   */
  async storeUpload(eventId: string, raw: unknown, label: string) {
    const config = await this.raceResult.loadConfig(eventId);
    return this.writeStandings(
      eventId,
      uploadedList(raw, config.resultsMapping, quoted(label)),
      withoutListPath(config.resultsMapping),
      `upload:${label}`,
      quoted(label),
    );
  }

  private async writeStandings(
    eventId: string,
    raw: unknown,
    mapping: Record<string, unknown>,
    sourceUrl: string,
    origin: string,
  ): Promise<{
    imported: number;
    athletesCreated: number;
    rejected: number;
    rejections: ResultRejection[];
    at: string;
  }> {
    const { results, rejectedCount, rejections, sourceColumns } = parseResults(
      raw,
      mapping,
    );
    if (!results.length)
      throw new BadRequestException(
        noUsableRows(origin, rejectedCount, sourceColumns),
      );

    const outcome = await this.db.tx(async (client) => {
      let athletesCreated = 0;
      // The join between the two passes below. Keyed by bib AND category,
      // because a bib is not unique within a pull — one athlete can race two
      // contests under one number — and keying on the bib alone would give both
      // of their results the same athlete row, so the second insert would fail
      // the one-result-per-athlete constraint.
      const athleteIdByRow = new Map<string, string>();

      for (const r of results) {
        // FILL BLANKS ONLY — see `upsertAthlete`. The start list is the
        // roster: it decides who is in which contest and which club, and it
        // carries fuller names ("Ishita Sharma", where the standings export
        // prints "Ishita").
        //
        // What this pass is FOR is the other case: an athlete who finished and
        // is not on the imported start list at all. Their row is created here,
        // from the only description of them anybody has.
        const resolved = await this.upsertAthlete(client, eventId, {
          bib: r.bib,
          name: r.name,
          mobile: r.mobile,
          gender: r.gender,
          age: r.age,
          category: r.category,
          // The band the standings named. On the athlete row it is the band the
          // entry is in; the placing's own band stays on the result (091).
          ageGroup: r.ageGroup,
          club: r.club,
          source: 'results',
          raw: r.raw,
          authoritative: false,
        });
        if (resolved.created) athletesCreated++;
        athleteIdByRow.set(entryKey(r.bib, r.category), resolved.athleteId);
      }

      /* TWO KEYS, AND THEY DO NOT AGREE.
       *
       * The parser keeps one row per BIB IN A CONTEST — a bib is not unique in
       * a pull, since one athlete can race two contests under one number. The
       * athlete table keys an entry on WHO IN WHICH CONTEST: since 085 that is
       * (event, phone, name, contest). Those two disagree whenever one feed
       * carries the same person in the same contest under two bibs — a
       * reassigned number the export lists twice, an entry duplicated by hand,
       * or (the common one) two rows with no phone at all and the same name,
       * which `mobile_key('')` collapses into one person.
       *
       * When they disagree, both rows resolve to ONE athlete row, and
       * `hyfit_v2_results_athlete` — one result per athlete — rejects the
       * second insert. That aborted the transaction, so a single duplicated
       * entry anywhere in a file threw away the entire import: 73 seconds of
       * work and a 500, with nothing said about which row caused it.
       *
       * The rule is the parser's own, applied one key later: the FIRST row
       * wins and the rest are counted as rejected. It cannot be anything else —
       * a second result for one entry is the feed contradicting itself, and
       * letting the last write win would make the stored standings depend on
       * the order the rows happened to appear in. Which bibs collided is logged
       * rather than swallowed, because the answer is nearly always a duplicate
       * in the export that somebody needs to go and fix.
       */
      const insertable: typeof results = [];
      const claimedBy = new Map<string, string>();
      const collisions: string[] = [];
      // Reported beside the parser's own rejections: from where the operator is
      // standing these are the same event — a row in the file that is not on
      // the board — and which of the two keys dropped it is our detail, not
      // theirs. The reason still says which, because the fixes differ.
      const collisionDetails: ResultRejection[] = [];
      for (const r of results) {
        const athleteId = athleteIdByRow.get(entryKey(r.bib, r.category))!;
        const holder = claimedBy.get(athleteId);
        if (holder) {
          collisions.push(`${r.bib} (${r.category || 'no contest'}) → ${holder}`);
          if (collisionDetails.length < REJECTION_DETAIL_CAP)
            collisionDetails.push({
              // The file position is not knowable here — this pass runs over
              // parsed results, not raw rows — so it is 0, meaning "no line
              // number", and the bib and contest are what identify it.
              row: 0,
              bib: r.bib,
              name: r.name,
              category: r.category,
              reason: 'same-athlete-twice',
            });
          continue;
        }
        claimedBy.set(athleteId, `${r.bib} (${r.category || 'no contest'})`);
        insertable.push(r);
      }
      if (collisions.length)
        this.logger.warn(
          `Results for ${eventId}: ${collisions.length} row(s) skipped — the same entry twice: ${collisions.join(', ')}`,
        );

      // Replace, inside the same transaction as the insert, so a failed import
      // cannot leave an event with no results at all.
      await client.query('DELETE FROM results WHERE event_id = $1', [eventId]);

      for (const r of insertable) {
        await client.query(
          `INSERT INTO results (
             event_id, athlete_id, bib, name, category, club, status,
             rank, age_group_rank, total_ms, team_time_ms,
             cog_ms, run1_ms, st1_ms, run2_ms, st2_ms, run3_ms, st3_ms,
             run4_ms, st4_ms, run5_ms, st5_ms, run6_ms, st6_ms,
             penalties, raw, source_url, age_group, team_rank, extra_times,
             age)
           VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),$7,
                   $8,$9,$10,$11,
                   $12,$13,$14,$15,$16,$17,$18,
                   $19,$20,$21,$22,$23,$24,
                   $25::jsonb,$26::jsonb,$27,NULLIF($28,''),$29,$30::jsonb,
                   $31)`,
          [
            eventId,
            athleteIdByRow.get(entryKey(r.bib, r.category)),
            r.bib,
            r.name,
            r.category,
            r.club,
            r.status,
            r.rank,
            r.ageGroupRank,
            r.totalMs,
            r.teamTimeMs,
            r.cogMs,
            r.runMs[0],
            r.stationMs[0],
            r.runMs[1],
            r.stationMs[1],
            r.runMs[2],
            r.stationMs[2],
            r.runMs[3],
            r.stationMs[3],
            r.runMs[4],
            r.stationMs[4],
            r.runMs[5],
            r.stationMs[5],
            JSON.stringify(r.penalties),
            JSON.stringify(r.raw),
            sourceUrl,
            r.ageGroup,
            r.teamRank,
            JSON.stringify(r.extraTimes),
            r.age,
          ],
        );
      }

      const { rows: stamped } = await client.query<{ at: string }>(
        `UPDATE events SET results_stored_at = now(), updated_at = now()
          WHERE id = $1 RETURNING results_stored_at AS at`,
        [eventId],
      );

      return {
        // What is IN the table, not what was parsed. An operator who uploads
        // 512 rows and is told 512 were imported has no way to discover the
        // four the second key collapsed.
        imported: insertable.length,
        athletesCreated,
        rejected: rejectedCount + collisions.length,
        rejections: [...rejections, ...collisionDetails],
        at: stamped[0].at,
      };
    });

    await this.cache.invalidateEvent(eventId);
    this.logger.log(
      `Results stored for ${eventId}: ${outcome.imported} rows, ${outcome.athletesCreated} athletes created`,
    );
    if (outcome.rejections.length)
      this.logRejections(origin, outcome.rejections, outcome.rejected);
    return outcome;
  }

  // ────────────────────────────────────────────────────────── athlete import

  /**
   * The start list, from the participant endpoint into `athletes`.
   *
   * REPLACES this event's roster: after it runs, the event's entries are
   * exactly what the feed returned. An entry the feed no longer carries is
   * removed — the organiser's start list is the roster, and one this import
   * cannot account for is somebody who has withdrawn or a leftover from an
   * earlier, differently-keyed import.
   *
   * Scoped to the event and to entries. The PEOPLE are never deleted here
   * (except anonymous ones nothing references any more): an athlete withdrawn
   * from this race did not stop existing, and their entries at other editions
   * are not this import's business.
   */
  async importAthletes(eventId: string) {
    const config = await this.raceResult.loadConfig(eventId);
    this.raceResult.requireFeed(config);

    const raw = await this.fetchJson(config.participantApiUrl);
    return this.writeRoster(
      eventId,
      raw,
      config.participantMapping,
      'The participant endpoint',
      'raceresult',
    );
  }

  /**
   * The same start-list import, from a file an operator picked.
   *
   * It REPLACES the roster exactly as the endpoint version does — a file is the
   * start list, not an addition to it — so uploading a partial export drops
   * everybody it leaves out. That is the same rule the feed already obeys, and
   * the alternative (a file that merges, an endpoint that replaces) is two
   * meanings for one button.
   *
   * The rows are marked `source = 'upload'`, so a roster carried in by hand is
   * distinguishable from one the provider served — which matters when a later
   * feed import overwrites it.
   */
  async importAthletesUpload(eventId: string, raw: unknown, label: string) {
    const config = await this.raceResult.loadConfig(eventId);
    return this.writeRoster(
      eventId,
      uploadedList(raw, config.participantMapping, quoted(label)),
      withoutListPath(config.participantMapping),
      quoted(label),
      'upload',
    );
  }

  private async writeRoster(
    eventId: string,
    raw: unknown,
    mapping: Record<string, unknown>,
    origin: string,
    source: 'raceresult' | 'upload',
  ) {
    const { participants, rejectedCount } = parseParticipantImport(
      raw,
      mapping,
    );
    if (!participants.length)
      throw new BadRequestException(
        `${origin} returned no usable rows (${rejectedCount} rejected) — check the participant field mapping in Operations, especially the bib column.`,
      );

    const outcome = await this.db.tx(async (client) => {
      let created = 0;
      const keep: string[] = [];

      for (const p of participants) {
        // `authoritative` — the start list is the roster, so unlike the results
        // import this one overwrites the entry's category, club and timeslot.
        // An athlete moved between contests in RaceResult has to be moved here
        // too, and a blank-filling import could never do it.
        const resolved = await this.upsertAthlete(client, eventId, {
          bib: p.bib,
          name: p.name,
          mobile: p.mobile,
          gender: p.gender,
          dateOfBirth: p.dateOfBirth,
          category: p.category,
          ageGroup: p.ageGroup,
          club: p.club,
          contestId: p.contestId,
          wave: p.wave,
          timeslot: p.timeslot,
          contestDate: p.contestDate,
          sourceId: p.id,
          source,
          raw: p as unknown as Record<string, unknown>,
          authoritative: true,
        });
        if (resolved.created) created++;
        keep.push(resolved.athleteId);
      }

      /* THE EVENT'S ROSTER IS EXACTLY THE FEED, and this is the statement that
       * makes it true: everything for this event that this import did not
       * produce is gone.
       *
       * It is scoped by `event_id` and by nothing else. Other events' entries,
       * and the PEOPLE themselves, are untouched — an athlete withdrawn from
       * this race did not stop existing, and their history at other editions is
       * theirs.
       *
       * Written as a prune rather than a literal DELETE-then-INSERT so that an
       * athlete still on the start list keeps their row id. `results.athlete_id`
       * cascades: deleting and recreating every row would take that event's
       * stored results with it on each roster re-import, silently, which is not
       * something an operator pressing "Import athletes" is asking for. An
       * athlete who has genuinely left the feed still loses their result, and
       * should — they are not in the race any more.
       */
      const { rowCount } = await client.query(
        `DELETE FROM athletes
          WHERE event_id = $1 AND NOT (id = ANY($2::uuid[]))`,
        [eventId, keep],
      );

      return { imported: participants.length, created, removed: rowCount ?? 0 };
    });

    this.logger.log(
      `Athlete import for ${eventId} from ${origin}: ${outcome.imported} rows, ${outcome.created} new, ${outcome.removed} removed`,
    );
    return {
      ...outcome,
      updated: outcome.imported - outcome.created,
      rejected: rejectedCount,
    };
  }

  /**
   * Upsert one feed row into `athletes`, which since 085 IS the entry.
   *
   * The only place in this codebase that decides whether two feed rows are the
   * same athlete, and the rule is the organiser's: **phone + name + category,
   * within one event.** All four parts are compared through the SQL key
   * functions, never as raw strings, so "+91 90000 00131" and "9000000131" are
   * one number and "Male Open" and "MALE  open" are one contest.
   *
   * The bib is NOT part of it. It is what RaceResult labels a row with and it
   * changes between exports; the person does not. Two rows with one phone, one
   * name and one category are one entry however their bibs differ.
   *
   * Somebody with no usable number keys on (event, '', name, category). They
   * cannot log in — login is by number — but they are on the start list, which
   * is what the roster is for.
   */
  private async upsertAthlete(
    client: PoolClient,
    eventId: string,
    row: {
      bib: string;
      name: string;
      mobile?: string;
      gender?: string;
      dateOfBirth?: string;
      age?: number | null;
      category?: string;
      /** The age band the entry is in, when the feed names one (091). */
      ageGroup?: string;
      club?: string;
      contestId?: string;
      wave?: string;
      timeslot?: string;
      contestDate?: string;
      sourceId?: string;
      source: string;
      raw: Record<string, unknown>;
      /** True for the start list, which may overwrite what is there; false for
       *  the standings feed, which may only fill blanks. */
      authoritative: boolean;
    },
  ): Promise<{ athleteId: string; created: boolean }> {
    const { rows } = await client.query<{ id: string; inserted: boolean }>(
      // The conflict target is written exactly as `hyfit_v2_athletes_entry`
      // declares it (085) — an expression index can only be inferred by
      // repeating its expressions.
      // `age_group` is last rather than beside `category` so the existing
      // parameter numbers — and the $17 the CASE arms below read — stay where
      // they were. See migration 091.
      `INSERT INTO athletes (
         event_id, name, mobile, gender, date_of_birth, bib, category, club,
         contest_id, wave, timeslot, contest_date, age, source, source_id, raw,
         age_group)
       VALUES ($1,$2,NULLIF($3,''),NULLIF($4,''),NULLIF($5,'')::date,
               NULLIF($6,''),$7,NULLIF($8,''),NULLIF($9,''),NULLIF($10,''),
               NULLIF($11,''),NULLIF($12,'')::date,$13,$14,NULLIF($15,''),$16::jsonb,
               NULLIF($18,''))
       ON CONFLICT (event_id,
                    (hyfit_v2.mobile_key(mobile)),
                    (hyfit_v2.name_key(name)),
                    (hyfit_v2.contest_key(category))) DO UPDATE SET
         -- The bib is an attribute now, so the newest export wins it: a
         -- reassigned number has to be able to land.
         bib           = COALESCE(excluded.bib, athletes.bib),
         mobile        = COALESCE(excluded.mobile, athletes.mobile),
         gender        = CASE WHEN $17 THEN COALESCE(excluded.gender, athletes.gender)
                              ELSE COALESCE(athletes.gender, excluded.gender) END,
         date_of_birth = CASE WHEN $17 THEN COALESCE(excluded.date_of_birth, athletes.date_of_birth)
                              ELSE COALESCE(athletes.date_of_birth, excluded.date_of_birth) END,
         club          = CASE WHEN $17 THEN COALESCE(excluded.club, athletes.club)
                              ELSE COALESCE(athletes.club, excluded.club) END,
         contest_id    = COALESCE(excluded.contest_id, athletes.contest_id),
         wave          = COALESCE(excluded.wave, athletes.wave),
         timeslot      = COALESCE(excluded.timeslot, athletes.timeslot),
         contest_date  = COALESCE(excluded.contest_date, athletes.contest_date),
         age           = COALESCE(excluded.age, athletes.age),
         -- Newest non-null wins, the same rule as age: both feeds can carry the
         -- band, and an export that stops carrying it has moved nobody out of it.
         age_group     = COALESCE(excluded.age_group, athletes.age_group),
         -- A row first seen in the standings and now found on the start list is
         -- a start-list row: the better provenance wins. excluded.source, not
         -- a literal, so an uploaded start list records that it was uploaded —
         -- the insert branch already says so, and the two disagreeing would make
         -- the column mean "how it first arrived" on some rows and "how it last
         -- arrived" on others.
         source        = CASE WHEN $17 THEN excluded.source ELSE athletes.source END,
         source_id     = COALESCE(excluded.source_id, athletes.source_id),
         raw           = CASE WHEN $17 THEN excluded.raw ELSE athletes.raw END,
         updated_at    = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [
        eventId,
        row.name,
        row.mobile ?? '',
        row.gender ?? '',
        row.dateOfBirth ?? '',
        row.bib ?? '',
        // Empty string, never NULL: it is part of the key, and NULLs do not
        // collide with each other in a unique index.
        row.category ?? '',
        row.club ?? '',
        row.contestId ?? '',
        row.wave ?? '',
        row.timeslot ?? '',
        row.contestDate ?? '',
        row.age ?? null,
        row.source,
        row.sourceId ?? '',
        JSON.stringify(row.raw),
        row.authoritative,
        row.ageGroup ?? '',
      ],
    );
    return { athleteId: rows[0].id, created: rows[0].inserted };
  }

  /** The event's roster. One row per athlete per category — since 085 that IS
   *  the athletes table, so there is nothing to join.
   *
   *  `events_entered` is the athlete's own history, gathered the way the whole
   *  system now defines a person: the rows sharing their phone and name. It is
   *  counted only for somebody with a usable number, because without one there
   *  is nothing to recognise them by across events. */
  async listAthletes(eventId: string, search = '') {
    const term = search.trim();
    const { rows } = await this.db.q(
      `SELECT a.id, a.bib, a.name, a.gender, a.date_of_birth, a.age, a.mobile,
              a.club, a.category, a.age_group, a.contest_id, a.wave, a.timeslot,
              a.contest_date, a.source, a.updated_at,
              CASE WHEN hyfit_v2.mobile_key(a.mobile) = '' THEN 1 ELSE (
                SELECT count(DISTINCT x.event_id)::int FROM athletes x
                 WHERE hyfit_v2.mobile_key(x.mobile) = hyfit_v2.mobile_key(a.mobile)
                   AND hyfit_v2.name_key(x.name) = hyfit_v2.name_key(a.name)
              ) END AS events_entered
         FROM athletes a
        WHERE a.event_id = $1
          AND ($2::text = '' OR a.bib ILIKE '%' || $2 || '%'
                             OR a.name ILIKE '%' || $2 || '%'
                             OR COALESCE(a.mobile,'') ILIKE '%' || $2 || '%'
                             OR COALESCE(a.club,'') ILIKE '%' || $2 || '%'
                             -- Searchable for the same reason it is shown: an
                             -- organiser checking a band checks who is in it.
                             OR COALESCE(a.age_group,'') ILIKE '%' || $2 || '%')
        ORDER BY a.category, (a.bib ~ '^\\d+$') DESC,
                 CASE WHEN a.bib ~ '^\\d+$' THEN a.bib::bigint END, a.bib, a.name`,
      [eventId, term],
    );
    return { athletes: rows };
  }

  /** Delete every athlete this event has, and with them their results.
   *
   *  The whole roster, in one act, scoped by `event_id` and nothing else —
   *  other events are untouched. `results.athlete_id` cascades, so an event
   *  wiped here is wiped completely rather than left with standings pointing at
   *  people who are gone.
   *
   *  It exists because an import can go wrong in ways a re-import cannot fix:
   *  a mapping that put every athlete in one contest, a feed aimed at the wrong
   *  event. Starting again is then the shortest way back, and doing it by hand
   *  in SQL is worse than doing it here. */
  async deleteAthletes(eventId: string) {
    const removed = await this.db.tx(async (client) => {
      const results = await client.query(
        'DELETE FROM results WHERE event_id = $1',
        [eventId],
      );
      const athletes = await client.query(
        'DELETE FROM athletes WHERE event_id = $1',
        [eventId],
      );
      // The event no longer has stored results, so the stamp that says when it
      // last did would be a claim about rows that are not there.
      await client.query(
        `UPDATE events SET results_stored_at = NULL, updated_at = now()
          WHERE id = $1`,
        [eventId],
      );
      return {
        athletes: athletes.rowCount ?? 0,
        results: results.rowCount ?? 0,
      };
    });
    await this.cache.invalidateEvent(eventId);
    this.logger.log(
      `Roster deleted for ${eventId}: ${removed.athletes} athletes, ${removed.results} results`,
    );
    return removed;
  }

  // ─────────────────────────────────────────────────────────── serving reads

  /**
   * What a reader gets, decided by the event's mode and nothing else.
   *
   * Returns null when the event publishes nothing — including when the mode
   * says 'live' and the cache has since expired, which is a real state at the
   * end of an event day and must read as "not published" rather than as an
   * error.
   */
  async publicResults(eventId: string): Promise<ResultsPayload | null> {
    const event = await this.event(eventId);
    if (event.results_mode === 'off') return null;
    if (event.results_mode === 'live') return this.readCache(event);
    return this.readStored(event);
  }

  /** The same two reads as `publicResults`, but chosen by the caller instead of
   *  by the mode. The console has to be able to look at standings BEFORE
   *  deciding to publish them — that is the whole point of pulling into a cache
   *  first — and a preview that honoured the mode could only ever show what is
   *  already public. */
  async preview(
    eventId: string,
    source: 'live' | 'stored',
  ): Promise<ResultsPayload | null> {
    const event = await this.event(eventId);
    return source === 'stored' ? this.readStored(event) : this.readCache(event);
  }

  private async readCache(event: EventRow): Promise<ResultsPayload | null> {
    const payload = await this.cache
      .get<ResultsPayload>(this.liveKey(event))
      .catch(() => null);
    if (!payload?.rows?.length) return null;
    // A key is shared only between events that share a name, and even then the
    // id is appended — but the check costs nothing and the failure it guards
    // against is one event serving another's standings.
    if (payload.event_id !== event.id) return null;
    // The URL is a credential. It is kept ON the payload so a re-pull needs no
    // re-paste, and stripped on the way out.
    return { ...payload, url: null };
  }

  private async readStored(event: EventRow): Promise<ResultsPayload | null> {
    const { rows } = await this.db.q(
      `SELECT bib, name, category, club, status, rank, age_group, age_group_rank,
              age, total_ms, team_time_ms, team_rank, cog_ms, extra_times,
              run1_ms, st1_ms, run2_ms, st2_ms, run3_ms, st3_ms,
              run4_ms, st4_ms, run5_ms, st5_ms, run6_ms, st6_ms,
              penalties
         FROM results
        WHERE event_id = $1
        ORDER BY category NULLS LAST, rank NULLS LAST, total_ms NULLS LAST, bib`,
      [event.id],
    );
    if (!rows.length) return null;

    return {
      event_id: event.id,
      event_name: event.name,
      source: 'stored',
      url: null,
      fetched_at: event.results_stored_at ?? new Date().toISOString(),
      source_count: rows.length,
      rejected: 0,
      rows: rows.map(rowFromColumns),
    };
  }

  /**
   * Publish standings that arrived from somewhere other than RaceResult.
   *
   * This exists for ONE caller: `HjudgeIngestService`, receiving an offline
   * event's standings pushed up from the venue. It is here rather than there
   * because the live key belongs to this service — its name, its TTL, its
   * payload shape and the read-back check are four things that must agree, and
   * the last time this codebase kept one fact in two places it cost a cutover.
   *
   * The rows arrive in `results` COLUMN shape, which is what the venue's table
   * holds, and go through the same `rowFromColumns` the stored read uses. So a
   * pushed live payload and a locally stored one are the same object with a
   * different provenance, and the public read cannot tell them apart — which is
   * the whole point.
   */
  async publishLiveRows(
    eventId: string,
    rows: Record<string, any>[],
  ): Promise<{ key: string; rows: number; fetchedAt: string }> {
    const event = await this.event(eventId);
    const key = this.liveKey(event);
    const fetchedAt = new Date().toISOString();

    const payload: ResultsPayload = {
      event_id: eventId,
      event_name: event.name,
      source: 'live',
      // No URL: these standings were not fetched from anywhere by this server.
      url: null,
      fetched_at: fetchedAt,
      source_count: rows.length,
      rejected: 0,
      rows: rows.map(rowFromColumns),
    };

    await this.cache.set(key, payload, LIVE_TTL_SECONDS);

    // Read it back, for exactly the reason `pull()` does: CacheService.set
    // SWALLOWS a dead Valkey — it logs and returns — so without this a push
    // into a cache that is not there would report success, the venue would see
    // a green tick, and the public page would serve nothing at all. Live mode
    // is entirely Valkey; if the write did not land, the sender has to be told.
    const stored = await this.cache.get<ResultsPayload>(key).catch(() => null);
    if (!stored?.rows?.length) {
      throw new ServiceUnavailableException(
        `Standings were accepted but did not survive the cache at ${key} — Valkey is unreachable on this server, so live results cannot be published.`,
      );
    }

    this.logger.log(
      `Live standings published for ${event.name}: ${rows.length} rows -> ${key}`,
    );
    return { key, rows: rows.length, fetchedAt };
  }

  // ──────────────────────────────────────────────────────────────── plumbing

  private async fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!res.ok)
        throw new BadRequestException(
          `RaceResult returned HTTP ${res.status} for that endpoint`,
        );
      return await res.json();
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(
        (err as Error)?.name === 'AbortError'
          ? `RaceResult did not answer within ${FETCH_TIMEOUT_MS / 1000}s`
          : (err as Error).message,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** The one place a parsed row becomes an API row, used by the live path and by
 *  nothing else — the stored path builds the same shape out of its columns. */
function toRow(r: ImportedResult): ResultRow {
  return {
    bib: r.bib,
    name: r.name,
    category: r.category || null,
    club: r.club || null,
    status: r.status,
    rank: r.rank,
    age_group: r.ageGroup || null,
    age_group_rank: r.ageGroupRank,
    age: r.age,
    total_ms: r.totalMs,
    team_time_ms: r.teamTimeMs,
    team_rank: r.teamRank,
    cog_ms: r.cogMs,
    run_ms: r.runMs,
    station_ms: r.stationMs,
    penalties: r.penalties,
    extra_times: r.extraTimes,
  };
}

/** Why a feed produced nothing usable, said the same way whether it arrived off
 *  a URL or out of a file. The columns are named because the answer is almost
 *  always that the bib is under a heading the mapping does not know. */
/** What each rejection reason says in a sentence, for logs and for the console. */
export const REJECTION_REASONS: Record<ResultRejection['reason'], string> = {
  'no-bib': 'no usable bib number in that row',
  'duplicate-entry': 'the same bib in the same contest appeared earlier in the file',
  'same-athlete-twice':
    'the same athlete already has a result in this contest under another bib',
};

function noUsableRows(
  origin: string,
  rejected: number,
  sourceColumns: string[],
) {
  return `${origin} returned no usable rows (${rejected} rejected). Columns seen: ${
    sourceColumns.join(', ') || 'none'
  } — check which one holds the bib.`;
}

/**
 * The rows inside a file an operator picked.
 *
 * `findRows` walks the shapes this provider emits — a bare array, `{data:[…]}`,
 * `{Results:{List:[…]}}` — so a file saved from any of them lands the same way.
 * The results parser does that walk itself; the participant parser does NOT (it
 * demands an array at the configured path and throws otherwise), so an upload
 * is reduced to its list HERE, once, for both.
 *
 * Which is why every caller pairs this with `withoutListPath`: the list has
 * already been found, and leaving a path in the mapping would send the parser
 * looking for it a second time, inside the array it was just handed.
 */
function uploadedList(
  raw: unknown,
  mapping: Record<string, unknown>,
  label: string,
): Record<string, unknown>[] {
  const listPath = String(
    mapping.listPath ?? mapping.participantListPath ?? mapping.list_path ?? '',
  ).trim();
  const rows = findRows(raw, listPath);
  if (!rows.length)
    throw new BadRequestException(
      `${label} holds no rows — expected a JSON array of entries, or an object with one inside it${
        listPath ? ` at "${listPath}"` : ''
      }.`,
    );
  return rows;
}

/** A file's name as it appears in a message to the operator. One helper so the
 *  parser's complaint and the importer's read the same way. */
function quoted(label: string) {
  return `“${label}”`;
}

function withoutListPath(mapping: Record<string, unknown>) {
  return { ...mapping, listPath: '', participantListPath: '', list_path: '' };
}

/** `bigint` comes back from pg as a string, and a millisecond count rendered as
 *  "1336000" instead of a number turns every client-side subtraction into
 *  string concatenation. */
function numeric(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The endpoint a pull will use: the one passed in, or the published one.
 *
 *  An override is accepted so an operator can try a URL before committing it to
 *  a published configuration — the mapping screen is a versioned publish and
 *  should not be where somebody finds out they pasted the participant key. */
function resultsUrl(published: string, override?: string) {
  const url = String(override ?? '').trim() || published;
  if (!/^https?:\/\//i.test(url))
    throw new BadRequestException(
      'This event has no RaceResult results endpoint. Set one in Operations before pulling standings.',
    );
  return url;
}

/** How a result row is matched to the entry it belongs to.
 *
 * A bib is NOT an identity: the same athlete can hold one number across two
 * contests, and `(event_id, bib, category)` is what the entry is keyed on
 * downstream. Exported so every reader that has to line a feed row up against
 * an entry — the importer here, the athlete's own result, the live overlay —
 * matches them the same way. A second spelling of this join is a second answer
 * to "which of my races is this".
 */
export function entryKey(bib: string, category?: string | null) {
  // Must agree with hyfit_v2.contest_key() in migration 084 — same case fold,
  // same collapse of internal whitespace. A feed that writes "Male Open" on one
  // pull and "MALE  OPEN" on the next is describing one contest, and if these
  // two normalisations disagree the database and the page will disagree about
  // how many races somebody ran.
  const contest = String(category ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return `${String(bib ?? '').trim()}|${contest}`;
}

/** Must match the SQL expression in `event()` exactly. */
export function slug(name: string) {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}
