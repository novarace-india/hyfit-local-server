import {
  BadRequestException,
  ForbiddenException,
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
  hjudgeSyncConfig,
} from '../hjudge-sync.config';
import {
  chunkByBytes,
  decodeSyncCredential,
  normaliseBaseUrl,
} from '../hjudge-sync-credential.util';

export type PushKind = 'athletes' | 'results';
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
      // Never `token`. The console shows the prefix so an operator can tell
      // which credential is bound; the secret has no reader on this screen.
      target: target ? this.publicTarget(target) : null,
      runs,
    };
  }

  /**
   * Bind this event to a prod event, from a pasted connection code.
   *
   * The handshake is not a formality. It is the only step that can catch a
   * credential minted for a different race — last month's event, the other
   * venue's — and every individual call after it would succeed while quietly
   * overwriting standings that are already public. So the code is decoded, prod
   * is asked what it opens, and what comes back is stored and shown.
   */
  async bind(eventId: string, body: { code?: string; baseUrl?: string }) {
    this.assertLocalRole();
    await this.assertOfflineEvent(eventId);

    let credential;
    try {
      credential = decodeSyncCredential(String(body?.code ?? ''));
    } catch (error: any) {
      throw new BadRequestException(error?.message ?? 'Unreadable connection code');
    }

    // An override for the case the code was minted before prod knew the address
    // the venue can actually reach it on — a staging host, an IP, a tunnel.
    const override = normaliseBaseUrl(String(body?.baseUrl ?? ''));
    const baseUrl = override || credential.baseUrl;

    const handshake = await this.handshake(
      baseUrl,
      credential.eventId,
      credential.token,
    );

    const remoteEvent = handshake?.event ?? {};
    if (remoteEvent.delivery_mode !== 'offline') {
      throw new BadRequestException(
        `"${remoteEvent.name}" is not set to offline delivery on prod`,
      );
    }

    await this.db.q(
      `INSERT INTO event_push_targets
         (event_id, base_url, remote_event_id, remote_event_name,
          token, token_prefix, token_expires_at, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, '')::timestamptz, true)
       ON CONFLICT (event_id) DO UPDATE SET
         base_url          = excluded.base_url,
         remote_event_id   = excluded.remote_event_id,
         remote_event_name = excluded.remote_event_name,
         token             = excluded.token,
         token_prefix      = excluded.token_prefix,
         token_expires_at  = excluded.token_expires_at,
         enabled           = true,
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
        credential.eventId,
        String(remoteEvent.name ?? credential.eventName ?? ''),
        credential.token,
        credential.token.slice(0, 18),
        credential.expiresAt ?? '',
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

  /** The interval dropdown and the pause switch. */
  async configure(
    eventId: string,
    body: {
      intervalMinutes?: number;
      enabled?: boolean;
      autoImportResults?: boolean;
    },
  ) {
    this.assertLocalRole();
    const target = await this.requireTarget(eventId);

    let interval = target.interval_minutes;
    if (body?.intervalMinutes !== undefined) {
      interval = Number(body.intervalMinutes);
      if (!(HJUDGE_PUSH_INTERVALS as readonly number[]).includes(interval)) {
        throw new BadRequestException(
          `Interval must be one of: ${HJUDGE_PUSH_INTERVALS.join(', ')} minutes (0 = manual only)`,
        );
      }
    }

    const enabled =
      body?.enabled === undefined ? target.enabled : Boolean(body.enabled);

    const autoImport =
      body?.autoImportResults === undefined
        ? target.auto_import_results
        : Boolean(body.autoImportResults);

    const row = await this.db.q1<TargetRow>(
      `UPDATE event_push_targets
          SET interval_minutes = $2, enabled = $3, auto_import_results = $4,
              updated_at = now()
        WHERE event_id = $1
        RETURNING *`,
      [eventId, interval, enabled, autoImport],
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

      const sent = await this.send(target, 'results', rows);

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
    kind: PushKind,
    rows: unknown[],
  ): Promise<{ chunks: number; bytes: number }> {
    const batch = randomUUID();
    const chunks = chunkByBytes(rows, hjudgeSyncConfig.pushMaxBytes);
    let bytes = 0;

    for (let seq = 0; seq < chunks.length; seq++) {
      const payload = JSON.stringify({
        batch,
        seq,
        final: seq === chunks.length - 1,
        rows: chunks[seq],
      });
      bytes += Buffer.byteLength(payload, 'utf8');
      await this.post(target, `${kind}`, payload);
    }

    return { chunks: chunks.length, bytes };
  }

  private async post(target: TargetRow, path: string, payload: string) {
    const url = `${target.base_url}/api/hyfit-judge/ingest/events/${target.remote_event_id}/${path}`;
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
        throw new Error(
          `Prod refused the push (${response.status}): ${this.reasonFrom(text)}`,
        );
      }
      return text;
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new Error(
          `Prod did not answer within ${Math.round(hjudgeSyncConfig.pushTimeoutMs / 1000)}s`,
        );
      }
      throw error;
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

  /** The row minus its secret. Everything that reads a target for a response
   *  goes through here, so `token` has one place it could leak from and it does
   *  not. */
  private publicTarget(target: TargetRow) {
    const { token: _secret, ...rest } = target;
    return rest;
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
