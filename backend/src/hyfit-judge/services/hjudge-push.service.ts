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
  HJUDGE_PULL_INTERVAL_DEFAULT,
  HJUDGE_PULL_INTERVALS,
  HJUDGE_PUSH_INTERVAL_DEFAULT,
  HJUDGE_PUSH_INTERVALS,
  HJUDGE_SYNC_INTERVAL_MAX,
  HJUDGE_SYNC_INTERVAL_MIN,
  hjudgeSyncConfig,
} from '../hjudge-sync.config';
import {
  chunkByBytes,
  normaliseBaseUrl,
  parseSyncEndpoint,
  rehostEndpoint,
  stripToken,
} from '../hjudge-sync-credential.util';

export type PushKind = 'config_pull' | 'results' | 'results_final';
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
  pull_url: string;
  push_url: string;
  token: string;
  token_prefix: string;
  token_expires_at: string | null;
  enabled: boolean;
  interval_minutes: number;
  pull_interval_minutes: number;
  auto_import_results: boolean;
  results_pushed_at: string | null;
  results_pushed_rows: number | null;
  results_stored_at: string | null;
  results_stored_rows: number | null;
  results_fingerprint: string | null;
  config_pulled_at: string | null;
  config_fingerprint: string | null;
  last_attempt_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_pull_at: string | null;
  last_pull_status: string | null;
  last_pull_error: string | null;
  consecutive_failures: number;
}

/**
 * The venue half of an offline event: what this server pulls down, and what it
 * pushes back.
 *
 * This server runs the race — check-in, the judge tablets, the RaceResult
 * import — on a machine on the venue's own network that nobody outside the
 * venue can reach. Prod is what the public reads. Since 093 the two talk in
 * both directions, and each is the only writer of what it owns:
 *
 *   PROD OWNS THE SETUP. The event's name, dates, venue, RaceResult wiring,
 *   declaration text, check-in window and certificate layouts are entered once,
 *   on the console an admin already has open, and this server PULLS them. It
 *   does not have its own copy to disagree with — the local event is created by
 *   the first pull, under prod's own id, so there is one event in two places
 *   and nothing to reconcile.
 *
 *   THE VENUE OWNS THE STANDINGS. Results are produced here, by people standing
 *   at the finish, and pushed up. Prod never writes them back.
 *
 * WHY BOTH RUN ON A TIMER AND BOTH HAVE A BUTTON. The two answer to different
 * things — standings change continuously while a race is scored, configuration
 * changes when an admin edits it, which is rare and never urgent — so they have
 * separate intervals. But "rare" is not "never", and the entire reason the pull
 * exists is that a correction made on prod used to reach the venue by telephone
 * or not at all. The buttons are for the moment somebody wants to know NOW,
 * which is exactly when an operator does not want to wait out an interval.
 *
 * WHY THE TIMER IS HERE AND NOT IN THE BROWSER. The obvious place to put a
 * "sync every N minutes" loop is the admin screen that configures it, and it
 * would work perfectly until somebody closed the laptop lid — at which point
 * the public site silently stops updating while the console that would have
 * shown that is the thing that is asleep. The schedule belongs to the server.
 * See HjudgePushScheduler.
 *
 * WHY A SNAPSHOT AND NOT A DIFF. Every push sends the event's whole standings
 * and the receiver prunes what did not arrive. A diff would be smaller and
 * would need this server to know, reliably, everything prod has — across a link
 * that drops, a laptop that gets restarted, and a re-import that rewrites half
 * the table. A snapshot has no such state to be wrong about: it is
 * self-correcting by construction, and one push after a disaster puts prod back
 * exactly where it should be.
 */
@Injectable()
export class HjudgePushService {
  private readonly logger = new Logger(HjudgePushService.name);

  /** Events with a sync in flight. A manual "Sync now" landing on top of a
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

  // ─────────────────────────────────────────────────────────────── pairing

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
      pushIntervals: HJUDGE_PUSH_INTERVALS,
      pullIntervals: HJUDGE_PULL_INTERVALS,
      // Never `token`. The console shows the prefix so an operator can tell
      // which credential is paired; the secret has no reader on this screen.
      target: target ? this.publicTarget(target) : null,
      runs,
    };
  }

  /**
   * Pair this server with one prod event, from one pasted URL.
   *
   * THIS IS WHERE THE LOCAL EVENT COMES FROM. There is no "create the event on
   * the laptop as well" step any more, and that is the point: an event typed
   * twice, in two databases, by two people on two days, is two events that
   * agree only by luck. The paste names a prod event, the handshake confirms
   * which race it is, and the local row is created carrying PROD'S OWN ID — so
   * from here on there is one event in two places.
   *
   * The handshake is not a formality. It is the only step that can catch a
   * credential minted for a different race — last month's event, the other
   * venue's — and every individual call after it would succeed while quietly
   * overwriting standings that are already public.
   *
   * The first pull runs immediately, because a pairing that has not applied a
   * configuration yet is a laptop showing an event with nothing but a name on
   * it, and the operator is standing right there.
   */
  async pair(body: { url?: string; baseUrl?: string }) {
    this.assertLocalRole();

    let parsed;
    try {
      parsed = parseSyncEndpoint(String(body?.url ?? ''));
    } catch (error: any) {
      throw new BadRequestException(error?.message ?? 'Unreadable sync URL');
    }

    // An override for the case the URL was issued before prod knew the address
    // the venue can actually reach it on — a staging host, an IP, a tunnel.
    const override = normaliseBaseUrl(String(body?.baseUrl ?? ''));
    const baseUrl = override || parsed.baseUrl;
    const pullUrl = override
      ? rehostEndpoint(parsed.pullUrl, override)
      : parsed.pullUrl;
    const pushUrl = override
      ? rehostEndpoint(parsed.pushUrl, override)
      : parsed.pushUrl;

    const handshake = await this.handshakeAt(pullUrl, parsed.token);
    const remoteEvent = handshake?.event ?? {};

    if (remoteEvent.delivery_mode !== 'offline') {
      throw new BadRequestException(
        `"${remoteEvent.name}" is not set to offline delivery on prod. An online event publishes from wherever it runs and has nothing to pair with.`,
      );
    }
    if (String(remoteEvent.id ?? '') !== parsed.eventId) {
      // Prod answered about a different event than the URL named. Nothing good
      // follows from guessing which one the operator meant.
      throw new BadRequestException(
        'Prod answered for a different event than that URL names — mint a fresh sync URL from the prod console.',
      );
    }

    const eventId = parsed.eventId;

    await this.db.tx(async (client) => {
      // The local event, under prod's id. Only the barest identity is written
      // here — the pull below supplies everything else — but `name` is NOT NULL
      // with a non-empty CHECK, so it has to be something, and the handshake
      // has just told us what.
      await client.query(
        `INSERT INTO events (id, name, delivery_mode)
         VALUES ($1, $2, 'offline')
         ON CONFLICT (id) DO UPDATE SET
           delivery_mode = 'offline',
           updated_at    = now()`,
        [eventId, String(remoteEvent.name ?? 'Untitled event').trim()],
      );

      await client.query(
        `INSERT INTO event_push_targets
           (event_id, base_url, pull_url, push_url,
            token, token_prefix, token_expires_at,
            enabled, interval_minutes, pull_interval_minutes)
         VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, '')::timestamptz, true, $8, $9)
         ON CONFLICT (event_id) DO UPDATE SET
           base_url         = excluded.base_url,
           pull_url         = excluded.pull_url,
           push_url         = excluded.push_url,
           token            = excluded.token,
           token_prefix     = excluded.token_prefix,
           token_expires_at = excluded.token_expires_at,
           enabled          = true,
           -- A new credential is a new connection: what the old one had already
           -- sent or received says nothing about what THIS prod event holds,
           -- and leaving either fingerprint behind would skip the first sync in
           -- each direction as unchanged.
           results_fingerprint  = NULL,
           config_fingerprint   = NULL,
           results_pushed_at    = NULL,
           results_pushed_rows  = NULL,
           last_status          = NULL,
           last_error           = NULL,
           last_pull_status     = NULL,
           last_pull_error      = NULL,
           consecutive_failures = 0,
           updated_at           = now()`,
        [
          eventId,
          baseUrl,
          pullUrl,
          pushUrl,
          parsed.token,
          parsed.token.slice(0, 18),
          String(handshake?.credential?.expiresAt ?? ''),
          HJUDGE_PUSH_INTERVAL_DEFAULT,
          HJUDGE_PULL_INTERVAL_DEFAULT,
        ],
      );
    });

    this.logger.log(
      `Paired with ${baseUrl} for event ${eventId} ("${remoteEvent.name}")`,
    );

    // The first pull, immediately. A failure here is NOT a failed pairing — the
    // credential is good, the row is written, and the Sync screen can retry —
    // so it is reported rather than thrown.
    let pull: PushOutcome | null = null;
    let pullError = '';
    try {
      pull = await this.pullConfig(eventId, 'manual');
    } catch (error: any) {
      pullError = String(error?.message ?? error);
      this.logger.warn(`First pull after pairing failed: ${pullError}`);
    }

    return { eventId, remote: handshake, pull, pullError };
  }

  /** Forget where prod is. Nothing already pushed is withdrawn — that is prod's
   *  to decide, through its own results mode — and the local event stays, with
   *  everything the last pull gave it. */
  async unpair(eventId: string) {
    this.assertLocalRole();
    const removed = await this.db.q(
      'DELETE FROM event_push_targets WHERE event_id = $1',
      [eventId],
    );
    return { unpaired: (removed.rowCount ?? 0) > 0 };
  }

  /** The intervals, the pause switch, and the two endpoints. */
  async configure(
    eventId: string,
    body: {
      intervalMinutes?: number;
      pullIntervalMinutes?: number;
      enabled?: boolean;
      autoImportResults?: boolean;
      baseUrl?: string;
      pullUrl?: string;
      pushUrl?: string;
    },
  ) {
    this.assertLocalRole();
    const target = await this.requireTarget(eventId);

    const interval =
      body?.intervalMinutes === undefined
        ? target.interval_minutes
        : this.validInterval(body.intervalMinutes, 'push');
    const pullInterval =
      body?.pullIntervalMinutes === undefined
        ? target.pull_interval_minutes
        : this.validInterval(body.pullIntervalMinutes, 'pull');

    const enabled =
      body?.enabled === undefined ? target.enabled : Boolean(body.enabled);

    const autoImport =
      body?.autoImportResults === undefined
        ? target.auto_import_results
        : Boolean(body.autoImportResults);

    // The address prod is reachable on, changeable without re-pairing.
    //
    // It is the one part of a pairing that legitimately changes mid-event while
    // everything else stays valid: a tunnel restarts on a new host, the venue
    // gets a different route out, prod moves behind a new name. Forcing a
    // Disconnect and a fresh URL for that would mean going back to whoever
    // holds the prod console, in the middle of a race, to re-issue a credential
    // that was never the thing that broke.
    //
    // Editing it rewrites the ORIGIN of both endpoints and keeps their paths,
    // which is what "Change server address" has always claimed to do.
    let baseUrl = target.base_url;
    let pullUrl = target.pull_url;
    let pushUrl = target.push_url;

    if (body?.baseUrl !== undefined) {
      baseUrl = normaliseBaseUrl(String(body.baseUrl));
      if (!baseUrl) {
        throw new BadRequestException(
          'That is not a usable server address — give the origin, like https://app.example.com',
        );
      }
      pullUrl = rehostEndpoint(pullUrl, baseUrl);
      pushUrl = rehostEndpoint(pushUrl, baseUrl);
    }

    // Either endpoint on its own, for the case prod serves one of them from
    // somewhere this code would not have guessed. Stored as pasted, minus the
    // credential — an endpoint that is read back differently from how it was
    // typed is the bug 093 was written to end.
    if (body?.pullUrl !== undefined) {
      pullUrl = this.validEndpoint(body.pullUrl, 'configuration');
    }
    if (body?.pushUrl !== undefined) {
      pushUrl = this.validEndpoint(body.pushUrl, 'results');
    }

    const row = await this.db.q1<TargetRow>(
      `UPDATE event_push_targets
          SET interval_minutes      = $2,
              pull_interval_minutes = $3,
              enabled               = $4,
              auto_import_results   = $5,
              base_url              = $6,
              pull_url              = $7,
              push_url              = $8,
              updated_at            = now()
        WHERE event_id = $1
        RETURNING *`,
      [
        eventId,
        interval,
        pullInterval,
        enabled,
        autoImport,
        baseUrl,
        pullUrl,
        pushUrl,
      ],
    );
    return { target: this.publicTarget(row!) };
  }

  /** Ask prod what the paired credential still opens, without sending or
   *  applying anything. The Sync screen's "Test connection". */
  async check(eventId: string) {
    const target = await this.requireTarget(eventId);
    return { remote: await this.handshakeAt(target.pull_url, target.token) };
  }

  // ─────────────────────────────────────────────────────────────── pulling

  /**
   * Prod's configuration for this event, applied here.
   *
   * WHAT IT OVERWRITES, AND WHAT IT WILL NOT TOUCH. The event's identity and
   * setup are prod's, so they are replaced outright — there is no merge,
   * because a merge needs a rule for who wins and the whole design is that
   * exactly one side owns each fact. What it leaves alone is everything the
   * VENUE owns: `is_active` (which event the field apps on this network are
   * pointed at, a local operational choice), `results_mode`, the athletes, the
   * results, and every staff account and session.
   *
   * A pull that changes nothing is recorded as `skipped` rather than rewriting
   * the rows and stamping `updated_at`. On a fifteen-minute interval across an
   * event day, almost every pull is that one.
   */
  async pullConfig(
    eventId: string,
    trigger: PushTrigger = 'manual',
    options: { force?: boolean } = {},
  ): Promise<PushOutcome> {
    return this.run(eventId, 'config_pull', trigger, async (target) => {
      const bundle = await this.get(target);

      const fingerprint =
        String(bundle?.fingerprint ?? '') ||
        createHash('sha256').update(JSON.stringify(bundle)).digest('hex');

      if (!options.force && fingerprint === target.config_fingerprint) {
        return {
          status: 'skipped' as const,
          rows: 0,
          chunks: 0,
          bytes: 0,
          message: 'Unchanged since the last pull',
        };
      }

      const applied = await this.applyConfig(eventId, bundle);

      await this.db.q(
        `UPDATE event_push_targets
            SET config_pulled_at   = now(),
                config_fingerprint = $2,
                last_pull_at       = now(),
                last_pull_status   = 'ok',
                last_pull_error    = '',
                updated_at         = now()
          WHERE event_id = $1`,
        [eventId, fingerprint],
      );

      return {
        rows: applied.rows,
        chunks: 1,
        bytes: 0,
        message: applied.message,
      };
    });
  }

  /**
   * Write what prod sent into this database.
   *
   * Everything in one transaction: a laptop left holding prod's event name and
   * its own stale RaceResult URL, because the second statement failed, is worse
   * than a laptop that pulled nothing and says so.
   */
  private async applyConfig(
    eventId: string,
    bundle: any,
  ): Promise<{ rows: number; message: string }> {
    const event = bundle?.event;
    if (!event?.id) {
      throw new BadGatewayException(
        'Prod sent no event in its configuration — nothing was changed here',
      );
    }
    if (String(event.id) !== eventId) {
      throw new BadGatewayException(
        'Prod sent configuration for a different event — nothing was changed here',
      );
    }

    const config = bundle?.config ?? null;
    const templates: any[] = Array.isArray(bundle?.certificateTemplates)
      ? bundle.certificateTemplates
      : [];
    const notes: string[] = [];

    await this.db.tx(async (client) => {
      // ── the event ────────────────────────────────────────────────────
      //
      // `is_active` and `results_mode` are deliberately absent. The first says
      // which event the tablets on this network open, which is a decision made
      // at the venue; the second says what the public may see, which is prod's
      // and is made on prod's own screen — pulling it down here would let a
      // laptop's copy of it drift into being read as authoritative.
      await client.query(
        `UPDATE events
            SET name           = $2,
                venue          = $3,
                timezone       = COALESCE(NULLIF($4, ''), timezone),
                starts_at      = $5,
                ends_at        = $6,
                event_date     = $7,
                event_end_date = $8,
                status         = COALESCE(NULLIF($9, ''), status),
                delivery_mode  = 'offline',
                updated_at     = now()
          WHERE id = $1`,
        [
          eventId,
          String(event.name ?? '').trim() || 'Untitled event',
          event.venue ?? null,
          String(event.timezone ?? ''),
          event.starts_at ?? null,
          event.ends_at ?? null,
          event.event_date ?? null,
          event.event_end_date ?? null,
          String(event.status ?? ''),
        ],
      );

      // ── the RaceResult wiring, as a new published version ─────────────
      //
      // `raceresults_endpoints` is versioned and the field apps read the newest
      // published row, so applying a configuration is publishing one — not
      // editing the row in place, which would rewrite history the Operations
      // screen shows and give two different configurations the same version
      // number on the two sides.
      if (config) {
        const retired = await client.query(
          `UPDATE raceresults_endpoints
              SET state = 'retired', updated_at = now()
            WHERE event_id = $1 AND state = 'published'`,
          [eventId],
        );
        void retired;

        await client.query(
          `INSERT INTO raceresults_endpoints (
             event_id, version, state,
             bib_lookup_url, map_lookup_url, update_url, results_url,
             auth_scheme, auth_param_name, auth_token,
             participant_mapping, update_mapping, results_mapping,
             declaration_text, declaration_version,
             checkin_window_enabled,
             checkin_opens_before_minutes, checkin_closes_after_minutes,
             published_at)
           SELECT $1,
                  COALESCE(max(version), 0) + 1,
                  'published',
                  COALESCE($2, ''), COALESCE($3, ''), COALESCE($4, ''),
                  COALESCE($5, ''),
                  COALESCE(NULLIF($6, ''), 'none'), $7, $8,
                  COALESCE($9::jsonb,  '{}'::jsonb),
                  COALESCE($10::jsonb, '{}'::jsonb),
                  COALESCE($11::jsonb, '{}'::jsonb),
                  COALESCE(NULLIF($12, ''), 'I confirm that my participant details are correct and that I have received the assigned race equipment.'),
                  COALESCE($13, 1),
                  COALESCE($14, false),
                  COALESCE($15, 240), $16,
                  now()
             FROM raceresults_endpoints WHERE event_id = $1`,
          [
            eventId,
            config.participantApiUrl,
            config.mapLookupUrl,
            config.updateApiUrl,
            config.resultsUrl,
            String(config.authScheme ?? ''),
            config.authParamName ?? null,
            config.authToken ?? null,
            JSON.stringify(config.participantMapping ?? {}),
            JSON.stringify(config.updateMapping ?? {}),
            JSON.stringify(config.resultsMapping ?? {}),
            String(config.declarationText ?? ''),
            config.declarationVersion ?? 1,
            config.checkinWindowEnabled ?? false,
            config.checkinOpensBeforeMinutes ?? 240,
            config.checkinClosesAfterMinutes ?? null,
          ],
        );
        notes.push('RaceResult configuration published');
      } else {
        // Prod has an event but has never published a configuration for it.
        // Wiping what this laptop already has would take the tablets offline to
        // replace a working setup with nothing.
        notes.push(
          'prod has not published a RaceResult configuration for this event — the one already on this server was left alone',
        );
      }

      // ── certificate layouts ──────────────────────────────────────────
      if (templates.length) {
        for (const template of templates) {
          await client.query(
            `INSERT INTO certificate_templates
               (id, event_id, name, is_default, background_url, schema,
                is_published, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, COALESCE($6::jsonb, '{}'::jsonb), $7,
                     COALESCE($8::timestamptz, now()),
                     COALESCE($9::timestamptz, now()))
             ON CONFLICT (id) DO UPDATE SET
               name           = excluded.name,
               is_default     = excluded.is_default,
               background_url = excluded.background_url,
               schema         = excluded.schema,
               is_published   = excluded.is_published,
               updated_at     = excluded.updated_at`,
            [
              template.id,
              eventId,
              String(template.name ?? 'Certificate'),
              Boolean(template.is_default),
              template.background_url ?? null,
              JSON.stringify(template.schema ?? {}),
              Boolean(template.is_published),
              template.created_at ?? null,
              template.updated_at ?? null,
            ],
          );

          // The contest links are a set, not a list to be merged: prod's answer
          // is the whole answer, so the old rows go and the new ones land.
          await client.query(
            'DELETE FROM certificate_template_contests WHERE template_id = $1',
            [template.id],
          );
          const contests: string[] = Array.isArray(template.contests)
            ? template.contests.filter(Boolean)
            : [];
          if (contests.length) {
            await client.query(
              `INSERT INTO certificate_template_contests
                 (template_id, event_id, contest)
               SELECT $1, $2, c FROM unnest($3::text[]) AS c`,
              [template.id, eventId, contests],
            );
          }
        }

        // A layout deleted on prod is a layout that must stop printing here.
        await client.query(
          `DELETE FROM certificate_templates
            WHERE event_id = $1 AND id <> ALL($2::uuid[])`,
          [eventId, templates.map((t) => t.id)],
        );
        notes.push(`${templates.length} certificate layout(s)`);
      }
    });

    return {
      rows: templates.length,
      message: `Applied from prod: ${notes.join('; ')}`,
    };
  }

  // ─────────────────────────────────────────────────────────────── pushing

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
   *
   * EVERY ROW CARRIES ITS ATHLETE. There is no roster push to run first and no
   * ordering between two endpoints to get wrong: the receiver writes the
   * athlete and the result in one transaction. See `IngestResultRow`.
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

      const rows = await this.resultRows(eventId);

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

      const sent = await this.send(target, rows, 'cache');

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
   */
  async pushFinalResults(
    eventId: string,
    trigger: PushTrigger = 'manual',
  ): Promise<PushOutcome> {
    return this.run(eventId, 'results_final', trigger, async (target) => {
      const rows = await this.resultRows(eventId);

      if (!rows.length) {
        throw new BadRequestException(
          'There are no standings on this server to publish. Import the results from RaceResult first.',
        );
      }

      const sent = await this.send(target, rows, 'store');

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
        message: "Written to prod's database — these outlive the cache",
      };
    });
  }

  /**
   * The standings, each row carrying the athlete it belongs to.
   *
   * The join is INNER on purpose. `results.athlete_id` is NOT NULL and
   * references `athletes`, so a result with no athlete cannot exist here — but
   * if one ever did, sending it would be sending a row prod must reject, and
   * dropping it silently is better than failing the whole push over a row that
   * is already broken locally. It would show up as a row count that does not
   * match the Results screen, which is a visible symptom.
   */
  private async resultRows(eventId: string) {
    const { rows } = await this.db.q(
      `SELECT r.id, r.athlete_id, r.bib, r.name, r.category, r.club, r.status,
              r.rank, r.age_group, r.age_group_rank, r.age,
              r.total_ms, r.team_time_ms, r.team_rank, r.cog_ms,
              r.run1_ms, r.st1_ms, r.run2_ms, r.st2_ms, r.run3_ms, r.st3_ms,
              r.run4_ms, r.st4_ms, r.run5_ms, r.st5_ms, r.run6_ms, r.st6_ms,
              r.penalties, r.extra_times, r.raw, r.source_url, r.imported_at,
              jsonb_build_object(
                'id',            a.id,
                'bib',           a.bib,
                'name',          a.name,
                'gender',        a.gender,
                'date_of_birth', a.date_of_birth,
                'age',           a.age,
                'age_group',     a.age_group,
                'mobile',        a.mobile,
                'club',          a.club,
                'category',      a.category,
                'contest_id',    a.contest_id,
                'wave',          a.wave,
                'timeslot',      a.timeslot,
                'contest_date',  a.contest_date,
                'source',        a.source,
                'source_id',     a.source_id,
                'raw',           a.raw,
                'created_at',    a.created_at,
                'updated_at',    a.updated_at
              ) AS athlete
         FROM results r
         JOIN athletes a ON a.id = r.athlete_id
        WHERE r.event_id = $1
        ORDER BY r.id`,
      [eventId],
    );
    return rows;
  }

  /**
   * Every event due in one direction, oldest attempt first.
   *
   * The due-time is computed in SQL against the database's own clock rather
   * than against a timer held in this process, so changing an interval takes
   * effect on the next tick and a restart does not reset everybody's schedule
   * to "now".
   *
   * `consecutive_failures` widens the gap on the PUSH side: a link that is down
   * does not get hammered at full rate, and the log stays readable enough to
   * see when it comes back. The pull side does not back off — it is already the
   * slow one, and a laptop that has lost contact with prod is exactly the one
   * that should notice promptly when contact returns.
   */
  async due(): Promise<string[]> {
    const { rows } = await this.db.q<{ event_id: string }>(
      `SELECT t.event_id
         FROM event_push_targets t
         JOIN events e ON e.id = t.event_id
        WHERE t.enabled
          AND t.interval_minutes > 0
          AND btrim(t.push_url) <> ''
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

  /** The same question for the other direction. */
  async duePulls(): Promise<string[]> {
    const { rows } = await this.db.q<{ event_id: string }>(
      `SELECT t.event_id
         FROM event_push_targets t
         JOIN events e ON e.id = t.event_id
        WHERE t.enabled
          AND t.pull_interval_minutes > 0
          AND btrim(t.pull_url) <> ''
          AND e.delivery_mode = 'offline'
          AND (t.token_expires_at IS NULL OR t.token_expires_at > now())
          AND (
            t.last_pull_at IS NULL
            OR t.last_pull_at <= now() - make_interval(mins => t.pull_interval_minutes)
          )
        ORDER BY t.last_pull_at NULLS FIRST`,
    );
    return rows.map((r) => r.event_id);
  }

  // ───────────────────────────────────────────────────────────── internals

  /** One sync, with everything that has to happen around every sync: the
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

    const isPull = kind === 'config_pull';
    // The lock is per event AND per direction: a pull and a push touch
    // different tables and have no reason to exclude each other, while two
    // pushes would interleave two snapshots under two batch ids and whichever
    // finished second would prune the other's rows.
    const lock = `${eventId}:${isPull ? 'pull' : 'push'}`;
    if (this.inFlight.has(lock)) {
      throw new ServiceUnavailableException(
        isPull
          ? 'A pull for this event is already running'
          : 'A push for this event is already running',
      );
    }
    this.inFlight.add(lock);

    const startedAt = Date.now();
    const target = await this.requireTarget(eventId);

    await this.db.q(
      isPull
        ? `UPDATE event_push_targets SET last_pull_at = now(), updated_at = now()
            WHERE event_id = $1`
        : `UPDATE event_push_targets SET last_attempt_at = now(), updated_at = now()
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
        isPull
          ? `UPDATE event_push_targets
                SET last_pull_status = $2, last_pull_error = '', updated_at = now()
              WHERE event_id = $1`
          : `UPDATE event_push_targets
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
        isPull
          ? `UPDATE event_push_targets
                SET last_pull_status = 'error', last_pull_error = $2,
                    updated_at = now()
              WHERE event_id = $1`
          : `UPDATE event_push_targets
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
      this.logger.warn(`Sync (${kind}) failed for ${eventId}: ${message}`);
      throw error;
    } finally {
      this.inFlight.delete(lock);
    }
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
    rows: unknown[],
    destination: 'cache' | 'store',
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
        destination,
        rows: chunks[seq],
      });
      bytes += Buffer.byteLength(payload, 'utf8');
      await this.post(target, payload);
    }

    return { chunks: chunks.length, bytes };
  }

  private async post(target: TargetRow, payload: string) {
    const url = this.requireEndpoint(target.push_url, 'results');
    return this.fetchJson(url, target.token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
  }

  /** The configuration bundle, as prod sent it. */
  private async get(target: TargetRow) {
    const url = this.requireEndpoint(target.pull_url, 'configuration');
    const text = await this.fetchJson(url, target.token, { method: 'GET' });
    try {
      return JSON.parse(text);
    } catch {
      throw new BadGatewayException(
        'Prod answered the configuration request with something that is not JSON — check the pull URL points at this event, not at a login page.',
      );
    }
  }

  /**
   * The handshake, derived from the pull endpoint rather than rebuilt.
   *
   * The three ingest routes differ in their last segment and nothing else, so
   * the address of the handshake is the address of the pull with that segment
   * swapped. Deriving it keeps a deployment that serves these from a custom
   * path working: 093 exists precisely because the previous code invented a
   * path, and the invented one stopped matching.
   */
  private async handshakeAt(pullUrl: string, token: string) {
    const url = this.siblingRoute(
      this.requireEndpoint(pullUrl, 'configuration'),
      'handshake',
    );
    const text = await this.fetchJson(url, token, { method: 'GET' }).catch(
      (error: any) => {
        // The handshake's failures are the operator's to read while they are
        // standing at the console pasting a URL, so they come back as 400s
        // rather than as 502s from a machine.
        throw new BadRequestException(String(error?.message ?? error));
      },
    );
    try {
      return JSON.parse(text);
    } catch {
      throw new BadRequestException(
        'That address answered, but not with a HYFIT handshake — check it is the sync URL and not the console address.',
      );
    }
  }

  /** One request to prod, with the credential in the header and never in the
   *  URL. Shared by all three directions so the timeout, the abort and the way
   *  prod's own error text is surfaced cannot drift between them. */
  private async fetchJson(
    url: string,
    token: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      hjudgeSyncConfig.pushTimeoutMs,
    );
    try {
      const response = await fetch(url, {
        method: init.method,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
        body: init.body,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        // A typed exception, not a bare Error, and this matters more than it
        // looks: `run()` re-throws whatever it catches, and Nest turns an
        // untyped Error into a bare 500 "Internal server error". The operator
        // pressing Sync then sees nothing, while the actual answer — "that
        // event is online on prod", "the credential was revoked" — sits in the
        // log and in `last_error` where they are not looking. 502 because the
        // failure is upstream: this server did its job and prod said no.
        throw new BadGatewayException(
          `Prod refused the request (${response.status}): ${this.reasonFrom(text)}`,
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
      // flattened into a 500.
      let origin = url;
      try {
        origin = new URL(url).origin;
      } catch {
        /* the message is still worth having */
      }
      throw new BadGatewayException(
        `Could not reach ${origin}: ${error?.message ?? error}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Swap the last path segment. See `handshakeAt`. */
  private siblingRoute(url: string, route: string): string {
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split('/').filter(Boolean);
      parts[parts.length - 1] = route;
      parsed.pathname = `/${parts.join('/')}`;
      return parsed.toString();
    } catch {
      return url;
    }
  }

  private requireEndpoint(url: string, what: string): string {
    const clean = String(url ?? '').trim();
    if (!clean) {
      throw new BadRequestException(
        `This event has no ${what} endpoint. Paste the sync URL prod issued for it, or set the endpoint on the Sync screen.`,
      );
    }
    return clean;
  }

  private validEndpoint(input: unknown, what: string): string {
    const clean = String(input ?? '').trim();
    if (!clean) {
      throw new BadRequestException(`The ${what} endpoint cannot be empty`);
    }
    if (!/^https?:\/\//i.test(clean)) {
      throw new Error(
        `The ${what} endpoint is a URL starting with https:// — this does not`,
      );
    }
    return stripToken(clean);
  }

  private validInterval(input: unknown, which: 'push' | 'pull'): number {
    const value = Number(input);
    if (
      !Number.isInteger(value) ||
      value < HJUDGE_SYNC_INTERVAL_MIN ||
      value > HJUDGE_SYNC_INTERVAL_MAX
    ) {
      throw new BadRequestException(
        `The ${which} interval is a whole number of minutes from ${HJUDGE_SYNC_INTERVAL_MIN} (manual only) to ${HJUDGE_SYNC_INTERVAL_MAX}`,
      );
    }
    return value;
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
      this.logger.warn(`Could not record sync run for ${eventId}: ${error}`);
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
        'This event is not paired with a prod server yet — paste the sync URL first',
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
        `"${event.name}" is an online event — it publishes from wherever it runs and has nothing to sync`,
      );
    }
  }

  private assertLocalRole() {
    if (hjudgeSyncConfig.nodeRole !== 'local') {
      throw new ForbiddenException(
        'This server runs as a prod node — set HYFIT_NODE_ROLE=local to sync from it',
      );
    }
  }
}
