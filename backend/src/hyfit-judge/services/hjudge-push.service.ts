import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { HjudgeDbService } from '../hjudge-db.service';
import { HjudgeResultsService } from './hjudge-results.service';
import {
  HJUDGE_PUSH_INTERVALS,
  HJUDGE_PUSH_INTERVAL_DEFAULT,
  HJUDGE_PUSH_INTERVAL_MAX,
  HJUDGE_PUSH_INTERVAL_MIN,
  hjudgeSyncConfig,
} from '../hjudge-sync.config';
import {
  chunkByBytes,
  decodeSyncCredential,
  defaultIngestEndpoint,
  normaliseBaseUrl,
  parseIngestEndpoint,
  rehostEndpoint,
} from '../hjudge-sync-credential.util';

export type PushKind = 'athletes' | 'results' | 'results_final';
export type PushTrigger = 'manual' | 'schedule';

export interface PushOutcome {
  kind: PushKind;
  status: 'ok' | 'error' | 'skipped';
  rows: number;
  chunks: number;
  bytes: number;
  durationMs: number;
  message: string;
}

interface TargetRow {
  id: string;
  event_id: string;
  base_url: string;
  /** The two endpoints as prod issued them, without their `?k=`. Empty on a
   *  binding made before 087, or one made from the short code — `endpointFor`
   *  falls back to building one. */
  athletes_url: string;
  results_url: string;
  remote_event_id: string;
  remote_event_name: string;
  token: string;
  token_prefix: string;
  token_expires_at: string | null;
  enabled: boolean;
  interval_minutes: number;
  auto_import_results: boolean;
  athletes_pushed_at: string | null;
  athletes_pushed_rows: number | null;
  results_pushed_at: string | null;
  results_pushed_rows: number | null;
  results_stored_at: string | null;
  results_stored_rows: number | null;
  results_fingerprint: string | null;
  last_attempt_at: string | null;
  last_status: string | null;
  last_error: string | null;
  consecutive_failures: number;
}

/**
 * The sending half of an offline event.
 *
 * This server runs the race — check-in, the judge tablets, the RaceResult
 * import — on a machine on the venue's own network that nobody outside the
 * venue can reach. Prod is what the public reads. So the two tables that make
 * up a public results page, and only those two, are pushed up: the roster when
 * an operator says so, the standings on a timer.
 *
 * WHY THE ROSTER IS MANUAL AND THE STANDINGS ARE NOT. They change at different
 * rates and for different reasons. A start list changes when somebody imports
 * one — a deliberate act, minutes long, that an operator watches finish — and
 * re-sending it every minute would spend the event re-uploading a list that is
 * the same list. Standings change continuously and nobody wants to press a
 * button every ninety seconds for six hours.
 *
 * WHY THE TIMER IS HERE AND NOT IN THE BROWSER. The obvious place to put a
 * "push every N minutes" loop is the admin screen that configures it, and it
 * would work perfectly until somebody closed the laptop lid — at which point
 * the public site silently stops updating while the console that would have
 * shown that is the thing that is asleep. The schedule belongs to the server.
 * See HjudgePushScheduler.
 *
 * WHY A SNAPSHOT AND NOT A DIFF. Every push sends the event's whole roster or
 * whole standings, and the receiver prunes what did not arrive. A diff would be
 * smaller and would need this server to know, reliably, everything prod has —
 * across a link that drops, a laptop that gets restarted, and a re-import that
 * rewrites half the table. A snapshot has no such state to be wrong about: it
 * is self-correcting by construction, and one push after a disaster puts prod
 * back exactly where it should be.
 */
@Injectable()
export class HjudgePushService {
  private readonly logger = new Logger(HjudgePushService.name);

  /** Events with a push in flight. A manual "Push now" landing on top of a
   *  scheduled one would interleave two snapshots under two batch ids, and
   *  whichever finished second would prune the other's rows. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly db: HjudgeDbService,
    // Only for the opt-in re-import before a scheduled push. Sharing the
    // importer rather than reaching for RaceResult again here is the point: the
    // mapping, the alias matching and the athlete reconciliation stay in one
    // place, and a stored snapshot is the same snapshot however it was asked
    // for.
    private readonly results: HjudgeResultsService,
  ) {}

  // ─────────────────────────────────────────────────────────────── binding

  /** Everything the Sync screen renders for one event. */
  async state(eventId: string) {
    const event = await this.db.q1<{
      id: string;
      name: string;
      delivery_mode: string;
      results_mode: string;
    }>(
      `SELECT id, name, delivery_mode, results_mode FROM events WHERE id = $1`,
      [eventId],
    );
    if (!event) throw new NotFoundException('Event not found');

    const target = await this.target(eventId);
    const counts = await this.localCounts(eventId);
    const { rows: runs } = await this.db.q(
      `SELECT id, kind, trigger_source, status, rows_sent, chunks, bytes_sent,
              duration_ms, message, started_at
         FROM push_runs
        WHERE event_id = $1
        ORDER BY started_at DESC
        LIMIT 20`,
      [eventId],
    );

    return {
      event,
      counts,
      intervals: HJUDGE_PUSH_INTERVALS,
      intervalBounds: {
        min: HJUDGE_PUSH_INTERVAL_MIN,
        max: HJUDGE_PUSH_INTERVAL_MAX,
      },
      // Never `token`. The console shows the prefix so an operator can tell
      // which credential is bound; the secret has no reader on this screen.
      target: target ? this.publicTarget(target) : null,
      runs,
    };
  }

  /**
   * Bind this event to a prod event.
   *
   * TWO ENDPOINTS, PASTED SEPARATELY. Prod issues one URL for the participants
   * and one for the standings, and both are now stored as pasted. Before 087
   * this took a single paste and rebuilt both URLs from its origin and event
   * id, which meant the results endpoint an operator supplied was parsed for
   * its credential and then discarded — and if prod served that route from
   * anywhere but the path this code invents, the push went to the invented one
   * with nothing on any screen to show it.
   *
   * THE SHORT CODE STILL WORKS. `code` remains, for the one-paste flow and for
   * anything already automated against it; the endpoints are then derived, as
   * before, because a code genuinely carries nothing else.
   *
   * THE HANDSHAKE IS NOT A FORMALITY. It is the only step that can catch a
   * credential minted for a different race — last month's event, the other
   * venue's — and every individual call after it would succeed while quietly
   * overwriting standings that are already public. So prod is asked what the
   * credential opens, and what comes back is stored and shown.
   */
  async bind(
    eventId: string,
    body: {
      code?: string;
      baseUrl?: string;
      athletesUrl?: string;
      resultsUrl?: string;
      intervalMinutes?: number;
    },
  ) {
    this.assertLocalRole();
    await this.assertOfflineEvent(eventId);

    const pastedAthletes = String(body?.athletesUrl ?? '').trim();
    const pastedResults = String(body?.resultsUrl ?? '').trim();
    const twoBox = Boolean(pastedAthletes || pastedResults);

    let credential: {
      baseUrl: string;
      eventId: string;
      eventName: string;
      token: string;
      expiresAt: string;
    };
    let athletesUrl = '';
    let resultsUrl = '';

    if (twoBox) {
      // Both, or neither. One endpoint and a blank is a binding that half
      // works — and the half that silently does not is whichever box was left
      // empty, discovered mid-event.
      if (!pastedAthletes || !pastedResults) {
        throw new BadRequestException(
          pastedAthletes
            ? 'The results endpoint is missing — prod issues two, and this server needs both'
            : 'The participants endpoint is missing — prod issues two, and this server needs both',
        );
      }

      let athletes, results;
      try {
        athletes = parseIngestEndpoint(pastedAthletes, 'athletes');
        results = parseIngestEndpoint(pastedResults, 'results');
      } catch (error: any) {
        throw new BadRequestException(error?.message ?? 'Unreadable endpoint');
      }

      // One credential opens both routes — that is what prod mints, and this
      // row holds one token. Two different `?k=` values mean two credentials,
      // and storing one of them would make the other endpoint fail on every
      // push with a 401 nobody would connect to the box they pasted it into.
      if (athletes.token !== results.token) {
        throw new BadRequestException(
          'Those two endpoints carry different credentials. Prod issues one code with two routes — copy both lines from the same "Create connection code" result.',
        );
      }
      if (athletes.eventId !== results.eventId) {
        throw new BadRequestException(
          'Those two endpoints are for different events on prod. Copy both lines from the same result.',
        );
      }

      athletesUrl = athletes.url;
      resultsUrl = results.url;
      credential = {
        baseUrl: athletes.baseUrl,
        eventId: athletes.eventId,
        eventName: '',
        token: athletes.token,
        // Not carried by a URL; the handshake supplies it.
        expiresAt: '',
      };
    } else {
      try {
        credential = decodeSyncCredential(String(body?.code ?? ''));
      } catch (error: any) {
        throw new BadRequestException(
          error?.message ?? 'Unreadable connection code',
        );
      }
    }

    // An override for the case the endpoints were minted before prod knew the
    // address the venue can actually reach it on — a staging host, an IP, a
    // tunnel. It moves the endpoints with it; see `rehostEndpoint`.
    const override = normaliseBaseUrl(String(body?.baseUrl ?? ''));
    const baseUrl = override || credential.baseUrl;

    if (!athletesUrl) {
      athletesUrl = defaultIngestEndpoint(baseUrl, credential.eventId, 'athletes');
      resultsUrl = defaultIngestEndpoint(baseUrl, credential.eventId, 'results');
    } else if (override) {
      athletesUrl = rehostEndpoint(athletesUrl, baseUrl);
      resultsUrl = rehostEndpoint(resultsUrl, baseUrl);
    }

    // Offered on the connect form, so a venue sets its cadence in the same act
    // as connecting rather than finding the control afterwards. Absent leaves
    // the column's default.
    const interval =
      body?.intervalMinutes === undefined
        ? null
        : this.validInterval(body.intervalMinutes);
    const existing = await this.target(eventId);

    const handshake = await this.handshake(
      baseUrl,
      credential.eventId,
      credential.token,
    );

    const remoteEvent = handshake?.event ?? {};
    // The handshake is the authority on the name and the expiry, and for the
    // URL form it is the ONLY source of them — that form carries neither. So
    // prefer what prod just said over whatever the paste claimed.
    const expiresAt =
      String(handshake?.credential?.expiresAt ?? '') || credential.expiresAt;
    if (remoteEvent.delivery_mode !== 'offline') {
      throw new BadRequestException(
        `"${remoteEvent.name}" is not set to offline delivery on prod`,
      );
    }

    await this.db.q(
      `INSERT INTO event_push_targets
         (event_id, base_url, athletes_url, results_url,
          remote_event_id, remote_event_name,
          token, token_prefix, token_expires_at, enabled, interval_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9, '')::timestamptz, true, $10)
       ON CONFLICT (event_id) DO UPDATE SET
         base_url          = excluded.base_url,
         athletes_url      = excluded.athletes_url,
         results_url       = excluded.results_url,
         remote_event_id   = excluded.remote_event_id,
         remote_event_name = excluded.remote_event_name,
         token             = excluded.token,
         token_prefix      = excluded.token_prefix,
         token_expires_at  = excluded.token_expires_at,
         enabled           = true,
         interval_minutes  = excluded.interval_minutes,
         -- A new credential is a new connection: what the old one had already
         -- sent says nothing about what THIS prod event holds, and leaving the
         -- fingerprint behind would skip the first results push as unchanged.
         results_fingerprint  = NULL,
         athletes_pushed_at   = NULL,
         athletes_pushed_rows = NULL,
         results_pushed_at    = NULL,
         results_pushed_rows  = NULL,
         last_status          = NULL,
         last_error           = NULL,
         consecutive_failures = 0,
         updated_at           = now()`,
      [
        eventId,
        baseUrl,
        athletesUrl,
        resultsUrl,
        credential.eventId,
        String(remoteEvent.name ?? credential.eventName ?? ''),
        credential.token,
        credential.token.slice(0, 18),
        expiresAt ?? '',
        // What the form asked for; otherwise whatever this event was already
        // set to, and only failing that the default a fresh venue gets.
        interval ?? existing?.interval_minutes ?? HJUDGE_PUSH_INTERVAL_DEFAULT,
      ],
    );

    this.logger.log(
      `Event ${eventId} bound to ${baseUrl} event ${credential.eventId} ("${remoteEvent.name}")`,
    );

    return { remote: handshake };
  }

  /** Forget where prod is. Nothing already pushed is withdrawn — that is prod's
   *  to decide, through its own results mode. */
  async unbind(eventId: string) {
    this.assertLocalRole();
    const removed = await this.db.q(
      'DELETE FROM event_push_targets WHERE event_id = $1',
      [eventId],
    );
    return { unbound: (removed.rowCount ?? 0) > 0 };
  }

  /** The endpoint boxes, the interval, and the pause switch. Every field is
   *  optional and only what is present changes — the screen sends one at a
   *  time, so a save must never carry a stale copy of the others. */
  async configure(
    eventId: string,
    body: {
      intervalMinutes?: number;
      enabled?: boolean;
      autoImportResults?: boolean;
      baseUrl?: string;
      athletesUrl?: string;
      resultsUrl?: string;
    },
  ) {
    this.assertLocalRole();
    const target = await this.requireTarget(eventId);

    const interval =
      body?.intervalMinutes === undefined
        ? target.interval_minutes
        : this.validInterval(body.intervalMinutes);

    const enabled =
      body?.enabled === undefined ? target.enabled : Boolean(body.enabled);

    const autoImport =
      body?.autoImportResults === undefined
        ? target.auto_import_results
        : Boolean(body.autoImportResults);

    // The address prod is reachable on, changeable without re-pasting the code.
    //
    // It is the one part of a binding that legitimately changes mid-event while
    // everything else stays valid: a tunnel restarts on a new host, the venue
    // gets a different route out, prod moves behind a new name. Forcing a
    // Disconnect and a fresh code for that would mean going back to whoever
    // holds the prod console, in the middle of a race, to re-issue a credential
    // that was never the thing that broke.
    let baseUrl = target.base_url;
    let athletesUrl = this.endpointFor(target, 'athletes');
    let resultsUrl = this.endpointFor(target, 'results');

    if (body?.baseUrl !== undefined) {
      baseUrl = normaliseBaseUrl(String(body.baseUrl));
      if (!baseUrl) {
        throw new BadRequestException(
          'That is not a usable server address — give the origin, like https://app.example.com',
        );
      }
      // Both endpoints move with it, or this control is a no-op on the only
      // thing it exists to fix: the push would keep calling the old host while
      // the screen showed the new one.
      athletesUrl = rehostEndpoint(athletesUrl, baseUrl);
      resultsUrl = rehostEndpoint(resultsUrl, baseUrl);
    }

    // Either endpoint, on its own, without re-pasting the other or going back
    // to prod for a fresh credential. The token on a re-pasted URL is checked
    // against the bound one rather than replacing it: a different credential is
    // a different connection, and that is what Connect is for.
    const endpoint = (raw: string, route: 'athletes' | 'results') => {
      let parsed;
      try {
        parsed = parseIngestEndpoint(raw, route);
      } catch (error: any) {
        throw new BadRequestException(error?.message ?? 'Unreadable endpoint');
      }
      if (parsed.token !== target.token) {
        throw new BadRequestException(
          'That endpoint carries a different credential from the one this event is connected with. Press Disconnect and connect again with the new pair.',
        );
      }
      return parsed;
    };

    if (body?.athletesUrl !== undefined) {
      athletesUrl = endpoint(String(body.athletesUrl), 'athletes').url;
    }
    if (body?.resultsUrl !== undefined) {
      const parsed = endpoint(String(body.resultsUrl), 'results');
      resultsUrl = parsed.url;
      // The standings are the half that changes, so a corrected results
      // endpoint has to send on the next tick even though the rows are the same
      // rows. Without this the fingerprint says "unchanged since the last push"
      // and the new endpoint is never called — which is the failure this whole
      // change is about, reappearing one screen later.
      await this.db.q(
        `UPDATE event_push_targets SET results_fingerprint = NULL
          WHERE event_id = $1`,
        [eventId],
      );
    }

    const row = await this.db.q1<TargetRow>(
      `UPDATE event_push_targets
          SET interval_minutes = $2, enabled = $3, auto_import_results = $4,
              base_url = $5, athletes_url = $6, results_url = $7,
              updated_at = now()
        WHERE event_id = $1
        RETURNING *`,
      [eventId, interval, enabled, autoImport, baseUrl, athletesUrl, resultsUrl],
    );
    return { target: this.publicTarget(row!) };
  }

  /** Ask prod what the bound credential still opens, without sending anything.
   *  The Sync screen's "Test connection". */
  async check(eventId: string) {
    const target = await this.requireTarget(eventId);
    return {
      remote: await this.handshake(
        target.base_url,
        target.remote_event_id,
        target.token,
      ),
    };
  }

  // ─────────────────────────────────────────────────────────────── pushing

  /**
   * The roster, whole.
   *
   * Sent before the standings ever are, and re-sent whenever an operator
   * presses Sync — because `results.athlete_id` is a foreign key on prod and a
   * result for somebody prod has never heard of is refused, correctly.
   *
   * AN EMPTY ROSTER IS REFUSED. A push is a snapshot and prod drops whatever it
   * did not bring, so pushing nothing means "this event has no start list" —
   * and on prod that cascades through `results.athlete_id` and takes the
   * standings with it. There is one realistic way to arrive here with an empty
   * table, and it is pressing Sync before importing the roster rather than
   * every entrant having withdrawn. Clearing prod deliberately is what
   * Disconnect and prod's own roster delete are for.
   */
  async pushAthletes(
    eventId: string,
    trigger: PushTrigger = 'manual',
  ): Promise<PushOutcome> {
    return this.run(eventId, 'athletes', trigger, async (target) => {
      const { rows } = await this.db.q(
        `SELECT id, bib, name, gender, date_of_birth, age, mobile, club,
                category, contest_id, wave, timeslot, contest_date,
                source, source_id, raw, created_at, updated_at
           FROM athletes
          WHERE event_id = $1
          ORDER BY id`,
        [eventId],
      );

      if (!rows.length) {
        throw new BadRequestException(
          'This server has no start list for the event yet. Import the roster from RaceResult first — pushing an empty one would clear the roster on prod, and the results with it.',
        );
      }

      const sent = await this.send(target, 'athletes', rows);

      await this.db.q(
        `UPDATE event_push_targets
            SET athletes_pushed_at = now(), athletes_pushed_rows = $2,
                updated_at = now()
          WHERE event_id = $1`,
        [eventId, rows.length],
      );

      return { ...sent, rows: rows.length, message: '' };
    });
  }

  /**
   * The standings, whole — unless they are the standings prod already has.
   *
   * The fingerprint is the whole reason this is safe to run every minute. A
   * race in progress is scored in bursts: a wave finishes, twenty rows change,
   * then nothing changes for six minutes. Without the digest, a one-minute
   * interval would re-upload an identical table sixty times an hour over a
   * venue connection that is usually the worst link in the chain.
   *
   * `force` is what the manual button sends, because "push it again" has to
   * mean it — the one case somebody presses that button is when they suspect
   * prod is not holding what this database says it should be.
   */
  async pushResults(
    eventId: string,
    trigger: PushTrigger = 'manual',
    options: { force?: boolean } = {},
  ): Promise<PushOutcome> {
    return this.run(eventId, 'results', trigger, async (target) => {
      let importNote = '';

      // Refresh the stored standings from RaceResult first, when this event
      // asked for it. Without this the timer would re-send the same snapshot
      // all afternoon: `results` is written by `store()` alone, and the judge
      // app writes back to RaceResult rather than to this table.
      //
      // A failed import does NOT fail the push. RaceResult being briefly
      // unreachable from the venue is ordinary, and the standings already in
      // this database are still the standings — refusing to publish them
      // because we could not fetch newer ones would take the public site
      // backwards over a blip. The reason is carried into the run history so it
      // is visible rather than silent.
      if (target.auto_import_results) {
        try {
          const imported = await this.results.store(eventId);
          importNote = `Re-imported ${imported.imported} row(s) from RaceResult. `;
        } catch (error: any) {
          importNote = `RaceResult re-import failed (${error?.message ?? error}) — pushing the standings already stored here. `;
          this.logger.warn(
            `Auto-import before push failed for ${eventId}: ${error?.message ?? error}`,
          );
        }
      }

      const { rows } = await this.db.q(
        `SELECT id, athlete_id, bib, name, category, club, status,
                rank, age_group_rank, total_ms, team_time_ms, cog_ms,
                run1_ms, st1_ms, run2_ms, st2_ms, run3_ms, st3_ms,
                run4_ms, st4_ms, run5_ms, st5_ms, run6_ms, st6_ms,
                penalties, raw, source_url, imported_at
           FROM results
          WHERE event_id = $1
          ORDER BY id`,
        [eventId],
      );

      const fingerprint = createHash('sha256')
        .update(JSON.stringify(rows))
        .digest('hex');

      if (!options.force && fingerprint === target.results_fingerprint) {
        return {
          status: 'skipped' as const,
          rows: rows.length,
          chunks: 0,
          bytes: 0,
          message: `${importNote}Unchanged since the last push`,
        };
      }

      // The roster first, if prod has never had one from us. A results push
      // into an empty prod roster fails on the foreign key, and "push the
      // roster first" is a thing this server can simply do rather than a thing
      // to tell an operator at the far end of an event day.
      if (!target.athletes_pushed_at) {
        this.logger.log(
          `Event ${eventId}: pushing the roster first — prod has never had one from this server`,
        );
        const roster = await this.sendAthletesFor(eventId, target);
        await this.db.q(
          `UPDATE event_push_targets
              SET athletes_pushed_at = now(), athletes_pushed_rows = $2,
                  updated_at = now()
            WHERE event_id = $1`,
          [eventId, roster.rows],
        );
        await this.recordRun(eventId, {
          kind: 'athletes',
          status: 'ok',
          rows: roster.rows,
          chunks: roster.chunks,
          bytes: roster.bytes,
          durationMs: 0,
          message: 'Sent automatically before the first results push',
        });
      }

      const sent = await this.send(target, 'results', rows, 'cache');

      await this.db.q(
        `UPDATE event_push_targets
            SET results_pushed_at = now(), results_pushed_rows = $2,
                results_fingerprint = $3, updated_at = now()
          WHERE event_id = $1`,
        [eventId, rows.length, fingerprint],
      );

      return { ...sent, rows: rows.length, message: importNote.trim() };
    });
  }

  /**
   * The standings into prod's TABLES, once, at the end.
   *
   * WHY THIS BUTTON EXISTS. Everything the timer sends goes into prod's Valkey,
   * which is right for a race in progress and wrong for a race that has
   * finished: the live key expires twelve hours after the last push, and a
   * cache is allowed to lose things. An event whose standings only ever went
   * there has published nothing that will still be answerable tomorrow — no
   * history page, no scorecard, no certificate.
   *
   * So this is the deliberate act at the end of the day, and it is deliberate
   * on purpose: pressing it says "these are the numbers". It always sends,
   * ignoring the fingerprint, because the fingerprint tracks what the CACHE
   * holds and says nothing about what the tables do.
   *
   * The roster goes first if prod has never had one, for the same foreign key
   * reason as everywhere else.
   */
  async pushFinalResults(
    eventId: string,
    trigger: PushTrigger = 'manual',
  ): Promise<PushOutcome> {
    return this.run(eventId, 'results_final', trigger, async (target) => {
      const { rows } = await this.db.q(
        `SELECT id, athlete_id, bib, name, category, club, status,
                rank, age_group_rank, total_ms, team_time_ms, cog_ms,
                run1_ms, st1_ms, run2_ms, st2_ms, run3_ms, st3_ms,
                run4_ms, st4_ms, run5_ms, st5_ms, run6_ms, st6_ms,
                penalties, raw, source_url, imported_at
           FROM results
          WHERE event_id = $1
          ORDER BY id`,
        [eventId],
      );

      if (!rows.length) {
        throw new BadRequestException(
          'There are no standings on this server to publish. Import the results from RaceResult first.',
        );
      }

      if (!target.athletes_pushed_at) {
        const roster = await this.sendAthletesFor(eventId, target);
        await this.db.q(
          `UPDATE event_push_targets
              SET athletes_pushed_at = now(), athletes_pushed_rows = $2,
                  updated_at = now()
            WHERE event_id = $1`,
          [eventId, roster.rows],
        );
      }

      const sent = await this.send(target, 'results', rows, 'store');

      await this.db.q(
        `UPDATE event_push_targets
            SET results_stored_at = now(), results_stored_rows = $2,
                updated_at = now()
          WHERE event_id = $1`,
        [eventId, rows.length],
      );

      return {
        ...sent,
        rows: rows.length,
        message: 'Written to prod\'s database — these outlive the cache',
      };
    });
  }

  /**
   * Every event whose results are due to go up, newest deadline first.
   *
   * The due-time is computed in SQL against the database's own clock rather
   * than against a timer held in this process, so changing the dropdown takes
   * effect on the next tick and a restart does not reset everybody's schedule
   * to "now".
   *
   * `consecutive_failures` widens the gap: a link that is down does not get
   * hammered at full rate, and the log stays readable enough to see when it
   * comes back.
   */
  async due(): Promise<string[]> {
    const { rows } = await this.db.q<{ event_id: string }>(
      `SELECT t.event_id
         FROM event_push_targets t
         JOIN events e ON e.id = t.event_id
        WHERE t.enabled
          AND t.interval_minutes > 0
          AND e.delivery_mode = 'offline'
          AND (t.token_expires_at IS NULL OR t.token_expires_at > now())
          AND (
            t.last_attempt_at IS NULL
            OR t.last_attempt_at <= now() - make_interval(
                 mins => t.interval_minutes * LEAST(GREATEST(t.consecutive_failures, 1), 8))
          )
        ORDER BY t.last_attempt_at NULLS FIRST`,
    );
    return rows.map((r) => r.event_id);
  }

  // ───────────────────────────────────────────────────────────── internals

  /** One push, with everything that has to happen around every push: the
   *  in-flight lock, the timing, the outcome written to the target row, and the
   *  run appended to the history the Sync screen reads. */
  private async run(
    eventId: string,
    kind: PushKind,
    trigger: PushTrigger,
    body: (target: TargetRow) => Promise<{
      status?: 'ok' | 'skipped';
      rows: number;
      chunks: number;
      bytes: number;
      message: string;
    }>,
  ): Promise<PushOutcome> {
    this.assertLocalRole();
    await this.assertOfflineEvent(eventId);

    const lock = `${eventId}`;
    if (this.inFlight.has(lock)) {
      throw new ServiceUnavailableException(
        'A push for this event is already running',
      );
    }
    this.inFlight.add(lock);

    const startedAt = Date.now();
    const target = await this.requireTarget(eventId);

    await this.db.q(
      `UPDATE event_push_targets SET last_attempt_at = now(), updated_at = now()
        WHERE event_id = $1`,
      [eventId],
    );

    try {
      const result = await body(target);
      const outcome: PushOutcome = {
        kind,
        status: result.status ?? 'ok',
        rows: result.rows,
        chunks: result.chunks,
        bytes: result.bytes,
        durationMs: Date.now() - startedAt,
        message: result.message,
      };

      await this.db.q(
        `UPDATE event_push_targets
            SET last_status = $2, last_error = '', consecutive_failures = 0,
                updated_at = now()
          WHERE event_id = $1`,
        [eventId, outcome.status],
      );
      await this.recordRun(eventId, { ...outcome, trigger });
      return outcome;
    } catch (error: any) {
      const message = String(error?.message ?? error).slice(0, 500);
      await this.db.q(
        `UPDATE event_push_targets
            SET last_status = 'error', last_error = $2,
                consecutive_failures = consecutive_failures + 1,
                updated_at = now()
          WHERE event_id = $1`,
        [eventId, message],
      );
      await this.recordRun(eventId, {
        kind,
        status: 'error',
        rows: 0,
        chunks: 0,
        bytes: 0,
        durationMs: Date.now() - startedAt,
        message,
        trigger,
      });
      this.logger.warn(`Push (${kind}) failed for ${eventId}: ${message}`);
      throw error;
    } finally {
      this.inFlight.delete(lock);
    }
  }

  private async sendAthletesFor(eventId: string, target: TargetRow) {
    const { rows } = await this.db.q(
      `SELECT id, bib, name, gender, date_of_birth, age, mobile, club,
              category, contest_id, wave, timeslot, contest_date,
              source, source_id, raw, created_at, updated_at
         FROM athletes
        WHERE event_id = $1
        ORDER BY id`,
      [eventId],
    );
    // Same refusal as `pushAthletes`, and it matters more here: this runs
    // unattended, inside a scheduled results push, where an empty snapshot
    // would clear prod's roster with nobody watching.
    if (!rows.length) {
      throw new BadRequestException(
        'This server has no start list for the event yet, so the results have nobody to belong to. Import the roster from RaceResult first.',
      );
    }
    const sent = await this.send(target, 'athletes', rows);
    return { ...sent, rows: rows.length };
  }

  /**
   * The wire: a snapshot, chunked, with one batch id and a final flag.
   *
   * Chunks go one at a time rather than in parallel. Venue uplinks are thin and
   * six concurrent requests on one do not arrive six times faster; more to the
   * point, the receiver prunes on the final chunk, and a final flag that
   * overtook the chunk before it would prune rows that were still in flight.
   */
  private async send(
    target: TargetRow,
    path: 'athletes' | 'results',
    rows: unknown[],
    destination?: 'cache' | 'store',
  ): Promise<{ chunks: number; bytes: number }> {
    const batch = randomUUID();
    const chunks = chunkByBytes(rows, hjudgeSyncConfig.pushMaxBytes);
    let bytes = 0;

    for (let seq = 0; seq < chunks.length; seq++) {
      const payload = JSON.stringify({
        batch,
        seq,
        final: seq === chunks.length - 1,
        // Carried on EVERY chunk, not just the last: the receiver stages a
        // cache push and writes a store push, and it has to know which on the
        // first one, not after the fact.
        ...(destination ? { destination } : {}),
        rows: chunks[seq],
      });
      bytes += Buffer.byteLength(payload, 'utf8');
      await this.post(target, path, payload);
    }

    return { chunks: chunks.length, bytes };
  }

  private async post(
    target: TargetRow,
    path: 'athletes' | 'results',
    payload: string,
  ) {
    const url = this.endpointFor(target, path);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      hjudgeSyncConfig.pushTimeoutMs,
    );
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${target.token}`,
        },
        body: payload,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        // A typed exception, not a bare Error, and this matters more than it
        // looks: `run()` re-throws whatever it catches, and Nest turns an
        // untyped Error into a bare 500 "Internal server error". The operator
        // pressing Push then sees nothing, while the actual answer — "that
        // event is online on prod", "the credential was revoked" — sits in the
        // log and in `last_error` where they are not looking. 502 because the
        // failure is upstream: this server did its job and prod said no.
        throw new BadGatewayException(
          `Prod refused the push (${response.status}): ${this.reasonFrom(text)}`,
        );
      }
      return text;
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      if (error?.name === 'AbortError') {
        throw new BadGatewayException(
          `Prod did not answer within ${Math.round(hjudgeSyncConfig.pushTimeoutMs / 1000)}s`,
        );
      }
      // A DNS failure, a refused connection, a dead venue link. The cause is
      // the message an operator can act on, so it is carried rather than
      // flattened into a 500 — and it names the ENDPOINT rather than the base
      // URL, because the two can now differ and "could not reach prod" is a
      // useless thing to read when one of the two endpoints is the wrong one.
      throw new BadGatewayException(
        `Could not reach ${url}: ${error?.message ?? error}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async handshake(baseUrl: string, remoteEventId: string, token: string) {
    const url = `${baseUrl}/api/hyfit-judge/ingest/events/${remoteEventId}/handshake`;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      hjudgeSyncConfig.pushTimeoutMs,
    );
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new BadRequestException(
          `Prod refused the credential (${response.status}): ${this.reasonFrom(text)}`,
        );
      }
      return JSON.parse(text);
    } catch (error: any) {
      if (error instanceof BadRequestException) throw error;
      if (error?.name === 'AbortError') {
        throw new BadRequestException(`${baseUrl} did not answer in time`);
      }
      throw new BadRequestException(
        `Could not reach ${baseUrl}: ${error?.message ?? error}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Prod's own error text if it sent one. Routes under /api/hyfit-judge/ are
   *  carved out of the host app's response envelope, so the body is Nest's
   *  `{ message }` on both deployments — but a proxy in front of prod can
   *  answer with HTML, so the raw text is the fallback. */
  private reasonFrom(text: string): string {
    try {
      const body = JSON.parse(text);
      return String(body?.message ?? body?.error ?? text).slice(0, 300);
    } catch {
      return String(text ?? '').slice(0, 300);
    }
  }

  private async recordRun(
    eventId: string,
    run: Omit<PushOutcome, 'durationMs'> & {
      durationMs?: number;
      trigger?: PushTrigger;
    },
  ) {
    try {
      await this.db.q(
        `INSERT INTO push_runs
           (event_id, kind, trigger_source, status, rows_sent, chunks,
            bytes_sent, duration_ms, message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          eventId,
          run.kind,
          run.trigger ?? 'manual',
          run.status,
          run.rows,
          run.chunks,
          run.bytes,
          run.durationMs ?? null,
          run.message ?? '',
        ],
      );
      // Kept short on purpose. The question this table answers is "what has
      // been happening for the last few hours", and a minute-interval push
      // writes sixty rows an hour per event on a machine nobody administers.
      await this.db.q(
        `DELETE FROM push_runs
          WHERE event_id = $1
            AND id NOT IN (
              SELECT id FROM push_runs WHERE event_id = $1
               ORDER BY started_at DESC LIMIT $2)`,
        [eventId, hjudgeSyncConfig.pushRunRetention],
      );
    } catch (error) {
      this.logger.warn(`Could not record push run for ${eventId}: ${error}`);
    }
  }

  private async localCounts(eventId: string) {
    return this.db.q1<{ athletes: number; results: number }>(
      `SELECT (SELECT count(*)::int FROM athletes WHERE event_id = $1) AS athletes,
              (SELECT count(*)::int FROM results  WHERE event_id = $1) AS results`,
      [eventId],
    );
  }

  private target(eventId: string) {
    return this.db.q1<TargetRow>(
      'SELECT * FROM event_push_targets WHERE event_id = $1',
      [eventId],
    );
  }

  private async requireTarget(eventId: string): Promise<TargetRow> {
    const target = await this.target(eventId);
    if (!target) {
      throw new BadRequestException(
        'This event is not connected to a prod server yet — paste a connection code first',
      );
    }
    return target;
  }

  /** Where a route's push actually goes.
   *
   *  The stored endpoint is the authority. The fallback is for a binding made
   *  before 087 on a database whose backfill has not run, and for one made from
   *  the short code, which carries no paths — it rebuilds what this codebase
   *  has always built, so those bindings keep behaving exactly as they did. */
  private endpointFor(target: TargetRow, route: 'athletes' | 'results'): string {
    const stored = String(
      (route === 'athletes' ? target.athletes_url : target.results_url) ?? '',
    ).trim();
    return (
      stored ||
      defaultIngestEndpoint(target.base_url, target.remote_event_id, route)
    );
  }

  /** Any whole number of minutes inside the column's CHECK. See migration 087
   *  for why this is a range and not the old enumerated list. */
  private validInterval(input: unknown): number {
    const minutes = Number(input);
    if (
      !Number.isInteger(minutes) ||
      minutes < HJUDGE_PUSH_INTERVAL_MIN ||
      minutes > HJUDGE_PUSH_INTERVAL_MAX
    ) {
      throw new BadRequestException(
        `Push every how many minutes? A whole number from ${HJUDGE_PUSH_INTERVAL_MIN} to ${HJUDGE_PUSH_INTERVAL_MAX} (0 = manual only).`,
      );
    }
    return minutes;
  }

  /** The row minus its secret, plus the two endpoints resolved.
   *
   *  Everything that reads a target for a response goes through here, so
   *  `token` has one place it could leak from and it does not — and the screen
   *  is shown the URLs the pushes will really use rather than the raw columns,
   *  which are empty on a pre-087 binding. */
  private publicTarget(target: TargetRow) {
    const { token: _secret, ...rest } = target;
    return {
      ...rest,
      athletes_url: this.endpointFor(target, 'athletes'),
      results_url: this.endpointFor(target, 'results'),
    };
  }

  private async assertOfflineEvent(eventId: string) {
    const event = await this.db.q1<{ delivery_mode: string; name: string }>(
      'SELECT delivery_mode, name FROM events WHERE id = $1',
      [eventId],
    );
    if (!event) throw new NotFoundException('Event not found');
    if (event.delivery_mode !== 'offline') {
      throw new BadRequestException(
        `"${event.name}" is an online event — it publishes from wherever it runs and has nothing to push`,
      );
    }
  }

  private assertLocalRole() {
    if (hjudgeSyncConfig.nodeRole !== 'local') {
      throw new ForbiddenException(
        'This server runs as a prod node — set HYFIT_NODE_ROLE=local to push from it',
      );
    }
  }
}
