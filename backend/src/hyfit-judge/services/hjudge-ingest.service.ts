import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { HjudgeDbService } from '../hjudge-db.service';
import { HjudgeCacheService } from '../hjudge-cache.service';
import { HjudgeResultsService } from './hjudge-results.service';
import { tokenHash } from '../hjudge-session.util';
import {
  HJUDGE_INGEST_SCOPES,
  hjudgeSyncConfig,
  type HjudgeIngestScope,
} from '../hjudge-sync.config';
import { encodeSyncPair } from '../hjudge-sync-credential.util';
import type { HjudgeIngestPrincipal } from '../hjudge-ingest.guard';
import type { HjudgeUser } from '../hjudge-auth.guard';

/** One athlete, exactly as `hyfit_v2.athletes` holds it.
 *
 *  The wire format is the column names, unchanged. Both ends of this push are
 *  this same codebase against this same schema, so a camel-cased DTO in the
 *  middle would be two renamings to keep in step for no reader's benefit — and
 *  the first time one of them fell behind, a column would go quietly missing
 *  from prod instead of failing. */
export interface IngestAthleteRow {
  id: string;
  bib: string;
  name: string;
  gender: string | null;
  date_of_birth: string | null;
  age: number | null;
  /** The band beneath the contest. Added to `athletes` by 091, which landed
   *  after 086 wrote this contract — a roster pushed without it arrived on prod
   *  with the column silently empty. */
  age_group: string | null;
  mobile: string | null;
  club: string | null;
  category: string;
  contest_id: string | null;
  wave: string | null;
  timeslot: string | null;
  contest_date: string | null;
  source: string;
  source_id: string | null;
  raw: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** One result, exactly as `hyfit_v2.results` holds it — and the athlete it
 *  belongs to, carried with it.
 *
 *  WHY THE ATHLETE TRAVELS ON THE RESULT. `results.athlete_id` is NOT NULL and
 *  references `athletes(id)`, so a result can only land where its athlete
 *  already is. Until 093 that was arranged by pushing a whole roster first, out
 *  of a second endpoint, in the right order — and a results push that arrived
 *  before one was refused with "push the roster for this event first", which is
 *  a message about a button the operator had not pressed rather than about
 *  anything wrong with their data.
 *
 *  A result now brings its own athlete and the receiver upserts the pair in one
 *  transaction. There is no roster endpoint, no ordering between two pushes to
 *  get wrong, and no way for the two to disagree about who ran — because they
 *  are no longer two pushes. See migration 093. */
export interface IngestResultRow {
  id: string;
  athlete_id: string;
  /** The athlete this result belongs to, written before the result is. Its
   *  `id` must equal `athlete_id` above; the receiver refuses the pair if not,
   *  because a mismatch means the sender built the row from two different
   *  people. */
  athlete: IngestAthleteRow;
  bib: string;
  name: string;
  category: string | null;
  club: string | null;
  status: string;
  rank: number | null;
  age_group: string | null;
  age_group_rank: number | null;
  total_ms: number | null;
  team_time_ms: number | null;
  team_rank: number | null;
  cog_ms: number | null;
  run1_ms: number | null;
  st1_ms: number | null;
  run2_ms: number | null;
  st2_ms: number | null;
  run3_ms: number | null;
  st3_ms: number | null;
  run4_ms: number | null;
  st4_ms: number | null;
  run5_ms: number | null;
  st5_ms: number | null;
  run6_ms: number | null;
  st6_ms: number | null;
  penalties: Record<string, unknown>;
  extra_times: Record<string, unknown>;
  raw: Record<string, unknown>;
  source_url: string | null;
  imported_at: string;
}

/** One chunk of a snapshot. `batch` ties the chunks of one push together and
 *  `final` says this was the last of them. */
export interface IngestChunk<TRow> {
  batch?: string;
  seq?: number;
  rows?: TRow[];
  final?: boolean;
  /** Results only. See `ingestResults`. */
  destination?: 'cache' | 'store';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long a half-delivered live push may sit in the cache waiting for its
 *  last chunk. Long enough for a venue link to stall and recover mid-push,
 *  short enough that an abandoned push is not still there next race. */
const STAGE_TTL_SECONDS = 15 * 60;

/**
 * The receiving half of an offline event.
 *
 * Three jobs that share a table and nothing else:
 *
 *   1. MINTING. The console creates a credential for one offline event; the
 *      secret is returned once, here, and never again — only its hash is kept.
 *   2. ANSWERING. A local server asks what prod knows about the event, and
 *      `eventConfig` hands back the whole of it — so a venue laptop is set up
 *      by pasting one URL rather than by retyping what an admin already entered.
 *   3. RECEIVING. That server pushes the standings back in chunks, each result
 *      carrying its own athlete, and this writes them into the same two tables
 *      the RaceResult importer writes, then invalidates the same cache keys.
 *      From the public read's point of view an offline event is
 *      indistinguishable from an online one, which is the whole design:
 *      `HjudgePublicController` does not know this file exists.
 *
 * WHY THE TABLES AND NOT THE CACHE. The obvious shortcut is to push straight
 * into Valkey, since that is what a live event serves. It is the wrong
 * destination. `CacheService` degrades to a no-op when Valkey is unreachable
 * and the live key expires twelve hours after the last pull — so an eviction,
 * a restart or a quiet evening would take the standings away with nothing able
 * to rebuild them, because prod's Postgres would never have received them. The
 * push writes the tables and drops the cache, exactly as `store()` does, and
 * the results are still there the next morning for the history page, the
 * scorecard and the certificate.
 *
 * WHY CHUNKS ARE NOT ONE TRANSACTION. A snapshot of two thousand athletes does
 * not fit in one request the receiving parser will accept, and a venue link
 * that dies partway through must not force the whole push to start again. So
 * each chunk commits, every row it writes is stamped with the push's `batch`,
 * and the `final` call deletes what this event has that the push did not bring.
 * Between the first chunk and the last, prod holds a SUPERSET of the venue's
 * data — never a subset — so the worst a reader sees is a name that has since
 * been withdrawn, and never an empty start list.
 */
@Injectable()
export class HjudgeIngestService {
  private readonly logger = new Logger(HjudgeIngestService.name);

  constructor(
    private readonly db: HjudgeDbService,
    private readonly cache: HjudgeCacheService,
    // The live key belongs to the results service — its name, TTL, payload
    // shape and read-back check live there and are reached through
    // `publishLiveRows`. Nothing in this file constructs a cache key itself.
    private readonly results: HjudgeResultsService,
  ) {}

  // ───────────────────────────────────────────────────────── credentials

  /** The event as the console's Sync screen shows it: what it is set to, and
   *  every credential minted for it. Never the secrets — they do not exist here
   *  to be shown. */
  async credentialState(eventId: string) {
    const event = await this.db.q1<{
      id: string;
      name: string;
      delivery_mode: string;
      results_mode: string;
      results_stored_at: string | null;
    }>(
      `SELECT id, name, delivery_mode, results_mode, results_stored_at
         FROM events WHERE id = $1`,
      [eventId],
    );
    if (!event) throw new NotFoundException('Event not found');

    const { rows } = await this.db.q(
      `SELECT t.id, t.label, t.token_prefix, t.scopes, t.expires_at,
              t.revoked_at, t.last_used_at, t.last_used_ip, t.use_count,
              t.created_at, u.name AS created_by_name,
              (t.revoked_at IS NULL AND t.expires_at > now()) AS live
         FROM event_ingest_tokens t
         LEFT JOIN users u ON u.id = t.created_by
        WHERE t.event_id = $1
        ORDER BY t.created_at DESC`,
      [eventId],
    );

    const counts = await this.db.q1<{ athletes: number; results: number }>(
      `SELECT (SELECT count(*)::int FROM athletes WHERE event_id = $1) AS athletes,
              (SELECT count(*)::int FROM results  WHERE event_id = $1) AS results`,
      [eventId],
    );

    return { event, credentials: rows, counts };
  }

  /**
   * Mint one. The secret is returned in this response and nowhere else.
   *
   * It is 32 random bytes as hex, prefixed so a credential found loose in a
   * chat message or a screenshot is recognisable as what it is and can be
   * revoked without anybody having to work out where it came from.
   */
  async mintCredential(
    eventId: string,
    body: { label?: string; hours?: number; scopes?: string[] },
    user: HjudgeUser,
  ) {
    const event = await this.db.q1<{ name: string; delivery_mode: string }>(
      'SELECT name, delivery_mode FROM events WHERE id = $1',
      [eventId],
    );
    if (!event) throw new NotFoundException('Event not found');
    // Minting for an online event would produce a credential every push is
    // refused with. Better to refuse the mint and say which switch is missing.
    if (event.delivery_mode !== 'offline') {
      throw new BadRequestException(
        'Set this event to offline delivery before issuing a sync credential',
      );
    }

    const scopes = this.normaliseScopes(body?.scopes);
    const hours = this.normaliseHours(body?.hours);
    const secret = `hyfitsync_${randomBytes(32).toString('hex')}`;

    const row = await this.db.q1<{ id: string; expires_at: string }>(
      `INSERT INTO event_ingest_tokens
         (event_id, token_hash, token_prefix, label, scopes, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5::text[], now() + make_interval(hours => $6), $7)
       RETURNING id, expires_at`,
      [
        eventId,
        tokenHash(secret),
        secret.slice(0, 18),
        String(body?.label ?? '')
          .trim()
          .slice(0, 120),
        scopes,
        hours,
        user?.id ?? null,
      ],
    );

    await this.audit(
      eventId,
      user?.id ?? null,
      'sync.credential.mint',
      row!.id,
      {
        scopes,
        hours,
      },
    );

    this.logger.log(
      `Sync credential ${row!.id} minted for event ${eventId} (${scopes.join(', ')}, ${hours}h)`,
    );

    // The two endpoints, ready to paste — built against the address prod is
    // actually reached on rather than one guessed here.
    //
    // WHY `publicBaseUrl` AND NOT THE REQUEST'S HOST. The console operator may
    // be on an internal hostname, a VPN name, or localhost during a rehearsal,
    // and the URL they copy has to work from a laptop at a venue on the far
    // side of the internet. That is a deployment fact, so it comes from the
    // environment. When it is unset the origin is left off and the console asks
    // the operator to fill it in, which is visibly incomplete — better than a
    // URL that looks right and resolves to nothing from the venue.
    const baseUrl = hjudgeSyncConfig.publicBaseUrl;
    const pair = baseUrl ? encodeSyncPair(baseUrl, eventId, secret) : null;

    return {
      id: row!.id,
      expiresAt: row!.expires_at,
      scopes,
      eventId,
      eventName: event.name,
      /** The secret, once. It is not stored and this response is the only place
       *  it will ever exist outside the venue laptop it is about to be pasted
       *  into. */
      token: secret,
      /** What the operator copies: the GET the venue pulls its configuration
       *  from, and the POST it publishes standings to. Pasting EITHER into the
       *  local console pairs it for both — see `parseSyncEndpoint`. */
      pullUrl: pair?.pullUrl ?? '',
      pushUrl: pair?.pushUrl ?? '',
      /** Set when this deployment does not know its own public address, so the
       *  console can say so rather than render two half-built URLs. */
      baseUrlMissing: !baseUrl,
    };
  }

  async revokeCredential(eventId: string, tokenId: string, user: HjudgeUser) {
    const row = await this.db.q1<{ id: string }>(
      `UPDATE event_ingest_tokens
          SET revoked_at = COALESCE(revoked_at, now())
        WHERE id = $1 AND event_id = $2
        RETURNING id`,
      [tokenId, eventId],
    );
    if (!row) throw new NotFoundException('Credential not found');
    await this.audit(
      eventId,
      user?.id ?? null,
      'sync.credential.revoke',
      row.id,
      {},
    );
    return { revoked: true };
  }

  /** Flip an event between running here and running at a venue.
   *
   *  Switching back to `online` is the emergency stop: the ingest guard reads
   *  this column on every push, so an event moved back stops accepting them
   *  immediately, without anybody having to find and revoke a credential
   *  first. */
  async setDeliveryMode(eventId: string, mode: string, user: HjudgeUser) {
    if (mode !== 'online' && mode !== 'offline') {
      throw new BadRequestException(
        'Delivery mode must be either online or offline',
      );
    }
    const row = await this.db.q1<{ delivery_mode: string }>(
      `UPDATE events SET delivery_mode = $2, updated_at = now()
        WHERE id = $1 RETURNING delivery_mode`,
      [eventId, mode],
    );
    if (!row) throw new NotFoundException('Event not found');
    await this.audit(eventId, user?.id ?? null, 'sync.delivery_mode', eventId, {
      mode,
    });
    await this.cache.invalidateEvent(eventId);
    return { deliveryMode: row.delivery_mode };
  }

  // ─────────────────────────────────────────────────────────── receiving

  /**
   * What the credential opens, before anything is sent.
   *
   * The venue operator pastes a credential and is shown the event it names —
   * its name, its date, what prod currently holds for it — and confirms that is
   * the race in front of them. It is the one check that catches the failure
   * nothing downstream can: a credential minted for last month's event, pasted
   * into this month's, would push a start list over standings that are already
   * public and every individual call in that sequence would succeed.
   */
  async handshake(principal: HjudgeIngestPrincipal) {
    const event = await this.db.q1<{
      id: string;
      name: string;
      venue: string | null;
      event_date: string | null;
      timezone: string;
      status: string;
      delivery_mode: string;
      results_mode: string;
      results_stored_at: string | null;
    }>(
      `SELECT id, name, venue, event_date, timezone, status,
              delivery_mode, results_mode, results_stored_at
         FROM events WHERE id = $1`,
      [principal.eventId],
    );
    if (!event) throw new NotFoundException('Event not found');

    const counts = await this.db.q1<{ athletes: number; results: number }>(
      `SELECT (SELECT count(*)::int FROM athletes WHERE event_id = $1) AS athletes,
              (SELECT count(*)::int FROM results  WHERE event_id = $1) AS results`,
      [principal.eventId],
    );

    return {
      event,
      counts,
      credential: {
        label: principal.label,
        scopes: principal.scopes,
        expiresAt: principal.expiresAt,
      },
      /** So a local server can refuse to bind to a receiver that would reject
       *  every chunk it is about to build. */
      maxBytes: hjudgeSyncConfig.pushMaxBytes,
    };
  }

  /**
   * EVERYTHING PROD KNOWS ABOUT THIS EVENT, in one GET.
   *
   * This is the other direction, and the reason 093 exists. Before it, a venue
   * laptop was set up by somebody retyping — the event's name, its dates, its
   * RaceResult URLs and mappings, its declaration text, its check-in window —
   * all of it already entered once on prod, entered again at six in the morning
   * from a phone screen, and thereafter free to disagree. A correction made on
   * prod reached the venue by telephone or not at all.
   *
   * The local server calls this and applies what comes back. There is one
   * event, in two places, under ONE id: the local event is created BY the first
   * pull carrying prod's uuid, so nothing has to be mapped and no screen has to
   * ask which of two events it means.
   *
   * WHAT IS DELIBERATELY NOT IN HERE.
   *
   *   * People. Athletes, results, staff, sessions, PINs. The roster is not a
   *     thing that travels any more (see `IngestResultRow`) and the rest is the
   *     venue's own business — a credential that could read prod's staff table
   *     would be a credential worth stealing for something other than a race.
   *
   *   * `otp_config` (090). It is global rather than per-event and it holds a
   *     gateway's API key, so putting it in an event-scoped response would
   *     widen what one venue's credential is worth to every event on the
   *     platform. A local server that needs to send athlete OTPs is configured
   *     with its own.
   *
   *   * `delivery_mode` is reported but is NOT the local server's to adopt. It
   *     is prod's statement about where the event is run; the guard already
   *     refuses this call for anything but `offline`, so a local server reading
   *     it back would only ever be told what it already knows.
   *
   * WHY THE RACERESULT CREDENTIALS *ARE* IN HERE, having been forbidden in 086.
   * 086 was describing the other direction: prod has no use for a venue's
   * RaceResult keys, so sending them up was storing a secret in a second place
   * for no reader's benefit. The venue laptop is precisely the machine that
   * needs them, and prod is where they are already configured.
   */
  async eventConfig(principal: HjudgeIngestPrincipal) {
    const event = await this.db.q1(
      // NOT `live_results_enabled`. That column is on `hyfit.events` (077) and
      // this pool is pinned to `hyfit_v2` — selecting it here fails with
      // `column does not exist` on every pull. The live-results toggle is read
      // by HfgLiveResultsService through the OTHER pool, which is still pinned
      // to `hyfit`; until those two agree on a schema it is not a fact this
      // module can carry.
      `SELECT id, name, venue, timezone, starts_at, ends_at,
              event_date, event_end_date, status, is_active,
              results_mode, delivery_mode,
              created_at, updated_at
         FROM events WHERE id = $1`,
      [principal.eventId],
    );
    if (!event) throw new NotFoundException('Event not found');

    // The newest PUBLISHED version, not the newest row. `raceresults_endpoints`
    // is versioned and a draft is an admin mid-edit — shipping that to a venue
    // would push a half-typed URL onto the tablets the moment somebody clicked
    // into the field. An event whose config has never been published sends
    // null, and the local server says "prod has not published a configuration
    // for this event yet" rather than wiping its own.
    const config = await this.db.q1(
      `SELECT id, event_id AS "eventId", version, state,
              bib_lookup_url AS "participantApiUrl",
              update_url AS "updateApiUrl",
              map_lookup_url AS "mapLookupUrl",
              results_url AS "resultsUrl",
              auth_scheme AS "authScheme",
              auth_param_name AS "authParamName",
              auth_token AS "authToken",
              participant_mapping AS "participantMapping",
              update_mapping AS "updateMapping",
              results_mapping AS "resultsMapping",
              declaration_text AS "declarationText",
              declaration_version AS "declarationVersion",
              checkin_window_enabled AS "checkinWindowEnabled",
              checkin_opens_before_minutes AS "checkinOpensBeforeMinutes",
              checkin_closes_after_minutes AS "checkinClosesAfterMinutes",
              published_at AS "publishedAt"
         FROM raceresults_endpoints
        WHERE event_id = $1 AND state = 'published'
        ORDER BY version DESC LIMIT 1`,
      [principal.eventId],
    );

    // Certificates travel because a certificate is a result, printed: the
    // layout is prod's and the venue prints from the same one. `background_url`
    // is an absolute URL into prod's asset bucket, so it resolves from the
    // venue without the image itself having to cross.
    const templates = await this.db.q(
      `SELECT t.id, t.name, t.is_default, t.background_url, t.schema,
              t.is_published, t.created_at, t.updated_at,
              COALESCE(
                array_agg(c.contest ORDER BY c.contest)
                  FILTER (WHERE c.contest IS NOT NULL),
                '{}'
              ) AS contests
         FROM certificate_templates t
         LEFT JOIN certificate_template_contests c ON c.template_id = t.id
        WHERE t.event_id = $1
        GROUP BY t.id
        ORDER BY t.is_default DESC, t.name`,
      [principal.eventId],
    );

    return {
      event,
      config,
      certificateTemplates: templates.rows,
      /** So the local server can tell an unchanged pull from a changed one
       *  without diffing the bundle itself — see `config_fingerprint` in 093.
       *  It is a digest of what is above, computed here so both ends cannot
       *  disagree about what "unchanged" means. */
      fingerprint: this.fingerprint({
        event,
        config,
        certificateTemplates: templates.rows,
      }),
      /** So a local server can refuse to pair with a receiver that would reject
       *  every chunk it is about to build. */
      maxBytes: hjudgeSyncConfig.pushMaxBytes,
    };
  }

  /**
   * One chunk of a standings snapshot — into the CACHE, or into the tables.
   *
   * TWO DESTINATIONS, BECAUSE A RACE HAS TWO KINDS OF STANDINGS.
   *
   *   cache (the default, and what the venue's timer sends every few minutes)
   *     The rows are assembled into the same Valkey payload `results_mode =
   *     'live'` already serves, under the same key the RaceResult pull writes.
   *     Provisional by construction: it expires, every push replaces it, and
   *     nothing about it is kept. This is what a race in progress IS — a
   *     photograph of an unfinished event that changes every few minutes — and
   *     writing each of those to Postgres would mean the database's answer to
   *     "what happened" changed under a reader all afternoon.
   *
   *   store (one deliberate push, at the end)
   *     The rows are written to `athletes`/`results` proper, so the standings
   *     survive a Valkey eviction, a restart, and the next morning. This is
   *     what the history page, the scorecard and the certificates read.
   *
   * THE CACHE PATH IS NOT A SHORTCUT AROUND PERSISTENCE — it is the live half
   * of a system that has always had both, and the reason `results_mode` has
   * three values rather than two. An event that only ever pushes to the cache
   * has published nothing permanent, which is why the console says so and the
   * venue gets a Publish-final button.
   *
   * ASSEMBLING A CACHE PAYLOAD FROM CHUNKS. A cache entry has to be written
   * whole — there is no partial value worth serving — so the chunks are staged
   * under short-lived keys and assembled on the final one. A chunk that did not
   * survive staging is detected by its absence rather than silently dropped:
   * `CacheService` swallows a dead Valkey, so a missing stage key is the only
   * evidence there would be.
   */
  async ingestResults(
    principal: HjudgeIngestPrincipal,
    chunk: IngestChunk<IngestResultRow>,
  ) {
    const batch = this.batchId(chunk);
    const rows = this.rowsOf(chunk, 'results');
    const destination = chunk?.destination === 'store' ? 'store' : 'cache';

    return destination === 'store'
      ? this.storeResults(principal, chunk, batch, rows)
      : this.cacheResults(principal, chunk, batch, rows);
  }

  /** The live path: stage this chunk, and on the last one publish the lot. */
  private async cacheResults(
    principal: HjudgeIngestPrincipal,
    chunk: IngestChunk<IngestResultRow>,
    batch: string,
    rows: IngestResultRow[],
  ) {
    const seq = Number.isFinite(Number(chunk?.seq)) ? Number(chunk.seq) : 0;

    if (!chunk?.final) {
      await this.cache.set(this.stageKey(batch, seq), rows, STAGE_TTL_SECONDS);
      return {
        received: rows.length,
        written: 0,
        pruned: 0,
        batch,
        final: false,
        destination: 'cache' as const,
      };
    }

    // The final chunk carries its own rows and completes the set: everything
    // from seq 0 up to this one.
    const assembled: IngestResultRow[] = [];
    for (let i = 0; i < seq; i++) {
      const staged = await this.cache
        .get<IngestResultRow[]>(this.stageKey(batch, i))
        .catch(() => null);
      if (!staged) {
        throw new ServiceUnavailableException(
          `Chunk ${i} of this push did not survive staging — Valkey is unreachable on this server, so live results cannot be assembled. Retry the push, or send the standings to the database instead.`,
        );
      }
      assembled.push(...staged);
    }
    assembled.push(...rows);

    const published = await this.results.publishLiveRows(
      principal.eventId,
      assembled,
    );

    // Staging keys are one push's scratch space and are worth nothing after it.
    await Promise.all(
      Array.from({ length: seq }, (_, i) =>
        this.cache.delete(this.stageKey(batch, i)).catch(() => undefined),
      ),
    );

    this.logger.log(
      `Live standings pushed for ${principal.eventName}: ${published.rows} rows -> ${published.key}`,
    );

    return {
      received: rows.length,
      written: published.rows,
      pruned: 0,
      batch,
      final: true,
      destination: 'cache' as const,
      cacheKey: published.key,
      fetchedAt: published.fetchedAt,
    };
  }

  /**
   * The persistent path: the standings into `results`, to outlive the cache.
   *
   * `results` is one row per athlete (085's `hyfit_v2_results_athlete`), so a
   * result arriving for an athlete who already has one under a different id has
   * to displace it — same shape as the roster's natural-key clear, one column
   * narrower.
   *
   * A result whose athlete this server does not have is refused with a message
   * that says what to do about it. It means the roster and the standings were
   * pushed out of order, the local server's own push sequence prevents it, and
   * the alternative — inventing an athlete row from a result — is how a start
   * list quietly grows people nobody entered.
   */
  private async storeResults(
    principal: HjudgeIngestPrincipal,
    chunk: IngestChunk<IngestResultRow>,
    batch: string,
    rows: IngestResultRow[],
  ) {
    const athletes = this.athletesOf(rows);

    let written = 0;
    try {
      written = await this.db.tx(async (client) => {
        if (!rows.length) return 0;

        // ── the athletes first, in the same transaction ──────────────────
        //
        // A result cannot be written before the row it references exists, and
        // since 093 there is no separate push that would have put it there. So
        // the pair lands together or neither does: a chunk that fails leaves
        // prod holding exactly what it held before, and the sender can simply
        // send it again.
        //
        // The delete before the insert is the price of carrying the venue's own
        // ids. `hyfit_v2_athletes_entry` (085) makes (event, phone, name,
        // category) unique, so a prod row that already describes an incoming
        // athlete under a DIFFERENT id — a roster imported here before the
        // event was moved offline, or a venue laptop rebuilt mid-event — would
        // fail the insert on a constraint `ON CONFLICT (id)` cannot see.
        // Clearing those first makes the push authoritative, which for an
        // offline event it is.
        await client.query(
          `DELETE FROM athletes a
             USING jsonb_to_recordset($2::jsonb)
                   AS t(id uuid, mobile text, name text, category text)
            WHERE a.event_id = $1::uuid
              AND a.id <> t.id
              AND hyfit_v2.mobile_key(a.mobile)    = hyfit_v2.mobile_key(t.mobile)
              AND hyfit_v2.name_key(a.name)        = hyfit_v2.name_key(t.name)
              AND hyfit_v2.contest_key(a.category) = hyfit_v2.contest_key(t.category)`,
          [
            principal.eventId,
            JSON.stringify(
              athletes.map((a) => ({
                id: a.id,
                mobile: a.mobile ?? '',
                name: a.name ?? '',
                category: a.category ?? '',
              })),
            ),
          ],
        );

        await client.query(
          `INSERT INTO athletes (
             id, event_id, bib, name, gender, date_of_birth, age, age_group,
             mobile, club, category, contest_id, wave, timeslot, contest_date,
             source, source_id, raw, created_at, updated_at, sync_batch)
           SELECT t.id, $1::uuid, t.bib, t.name, t.gender, t.date_of_birth,
                  t.age, t.age_group, t.mobile, t.club,
                  COALESCE(t.category, ''), t.contest_id,
                  t.wave, t.timeslot, t.contest_date,
                  COALESCE(NULLIF(t.source, ''), 'raceresult'), t.source_id,
                  COALESCE(t.raw, '{}'::jsonb),
                  COALESCE(t.created_at, now()), COALESCE(t.updated_at, now()),
                  $3::uuid
             FROM jsonb_to_recordset($2::jsonb) AS t(
                    id uuid, bib text, name text, gender text,
                    date_of_birth date, age integer, age_group text,
                    mobile text, club text, category text, contest_id text,
                    wave text, timeslot text, contest_date date, source text,
                    source_id text, raw jsonb,
                    created_at timestamptz, updated_at timestamptz)
           ON CONFLICT (id) DO UPDATE SET
             bib           = excluded.bib,
             name          = excluded.name,
             gender        = excluded.gender,
             date_of_birth = excluded.date_of_birth,
             age           = excluded.age,
             age_group     = excluded.age_group,
             mobile        = excluded.mobile,
             club          = excluded.club,
             category      = excluded.category,
             contest_id    = excluded.contest_id,
             wave          = excluded.wave,
             timeslot      = excluded.timeslot,
             contest_date  = excluded.contest_date,
             source        = excluded.source,
             source_id     = excluded.source_id,
             raw           = excluded.raw,
             updated_at    = excluded.updated_at,
             sync_batch    = excluded.sync_batch`,
          [principal.eventId, JSON.stringify(athletes), batch],
        );

        // ── then the results ─────────────────────────────────────────────
        await client.query(
          `DELETE FROM results r
             USING jsonb_to_recordset($2::jsonb) AS t(id uuid, athlete_id uuid)
            WHERE r.event_id = $1::uuid
              AND r.athlete_id = t.athlete_id
              AND r.id <> t.id`,
          [
            principal.eventId,
            JSON.stringify(
              rows.map((r) => ({ id: r.id, athlete_id: r.athlete_id })),
            ),
          ],
        );

        const inserted = await client.query(
          `INSERT INTO results (
             id, event_id, athlete_id, bib, name, category, club, status,
             rank, age_group, age_group_rank, age, total_ms, team_time_ms,
             team_rank, cog_ms,
             run1_ms, st1_ms, run2_ms, st2_ms, run3_ms, st3_ms,
             run4_ms, st4_ms, run5_ms, st5_ms, run6_ms, st6_ms,
             penalties, extra_times, raw, source_url, imported_at, sync_batch)
           SELECT t.id, $1::uuid, t.athlete_id, t.bib, t.name, t.category, t.club,
                  COALESCE(NULLIF(t.status, ''), 'FIN'),
                  t.rank, t.age_group, t.age_group_rank, t.age, t.total_ms,
                  t.team_time_ms, t.team_rank, t.cog_ms,
                  t.run1_ms, t.st1_ms, t.run2_ms, t.st2_ms, t.run3_ms, t.st3_ms,
                  t.run4_ms, t.st4_ms, t.run5_ms, t.st5_ms, t.run6_ms, t.st6_ms,
                  COALESCE(t.penalties, '{}'::jsonb),
                  COALESCE(t.extra_times, '{}'::jsonb),
                  COALESCE(t.raw, '{}'::jsonb),
                  t.source_url, COALESCE(t.imported_at, now()), $3::uuid
             FROM jsonb_to_recordset($2::jsonb) AS t(
                    id uuid, athlete_id uuid, bib text, name text, category text,
                    club text, status text, rank integer, age_group text,
                    age_group_rank integer, age integer,
                    total_ms bigint, team_time_ms bigint, team_rank integer,
                    cog_ms bigint,
                    run1_ms bigint, st1_ms bigint, run2_ms bigint, st2_ms bigint,
                    run3_ms bigint, st3_ms bigint, run4_ms bigint, st4_ms bigint,
                    run5_ms bigint, st5_ms bigint, run6_ms bigint, st6_ms bigint,
                    penalties jsonb, extra_times jsonb, raw jsonb, source_url text,
                    imported_at timestamptz)
           ON CONFLICT (id) DO UPDATE SET
             athlete_id     = excluded.athlete_id,
             bib            = excluded.bib,
             name           = excluded.name,
             category       = excluded.category,
             club           = excluded.club,
             status         = excluded.status,
             rank           = excluded.rank,
             age_group      = excluded.age_group,
             age_group_rank = excluded.age_group_rank,
             age            = excluded.age,
             total_ms       = excluded.total_ms,
             team_time_ms   = excluded.team_time_ms,
             team_rank      = excluded.team_rank,
             cog_ms         = excluded.cog_ms,
             run1_ms = excluded.run1_ms, st1_ms = excluded.st1_ms,
             run2_ms = excluded.run2_ms, st2_ms = excluded.st2_ms,
             run3_ms = excluded.run3_ms, st3_ms = excluded.st3_ms,
             run4_ms = excluded.run4_ms, st4_ms = excluded.st4_ms,
             run5_ms = excluded.run5_ms, st5_ms = excluded.st5_ms,
             run6_ms = excluded.run6_ms, st6_ms = excluded.st6_ms,
             penalties      = excluded.penalties,
             extra_times    = excluded.extra_times,
             raw            = excluded.raw,
             source_url     = excluded.source_url,
             imported_at    = excluded.imported_at,
             sync_batch     = excluded.sync_batch`,
          [principal.eventId, JSON.stringify(rows), batch],
        );
        return inserted.rowCount ?? 0;
      });
    } catch (error: any) {
      // 23503 used to mean "the roster was not pushed first" and was answered
      // with an instruction to press the other button. There is no other button
      // now — the athlete is written from this same payload, immediately above
      // — so a foreign key that still fails means the payload itself is
      // inconsistent, and saying so is more use than a workflow hint that no
      // longer applies to anything.
      if (error?.code === '23503') {
        throw new BadRequestException(
          'A result in this push references an athlete the push did not carry. Every result must travel with its own athlete — resend the standings.',
        );
      }
      throw error;
    }

    let pruned = 0;
    if (chunk?.final) {
      pruned = await this.finishResults(principal.eventId, batch);
      await this.cache.invalidateEvent(principal.eventId);
    }

    return {
      received: rows.length,
      written,
      pruned,
      batch,
      final: Boolean(chunk?.final),
      destination: 'store' as const,
    };
  }

  // ───────────────────────────────────────────────────────────── internals

  /**
   * The standings are complete: both halves of what the push carried are
   * pruned to what it actually brought.
   *
   * ONE PRUNE, TWO TABLES, IN THIS ORDER. `results` goes first and `athletes`
   * second, because `results.athlete_id` cascades — deleting a stale athlete
   * takes their result with them, and doing that BEFORE the results prune would
   * silently widen it beyond the batch. Deleting the results first means the
   * athlete prune only ever removes people this push did not mention, which is
   * what withdrawn means.
   *
   * The athlete prune is what stops a venue's start list growing forever on
   * prod. A person who was entered, raced, and was then removed at the venue is
   * absent from the next push; without this they would stay on prod's roster
   * indefinitely, counted by every screen that counts athletes.
   *
   * `results_stored_at` is stamped because that is what the console and the
   * public read mean by "when did this event last publish" — an offline event
   * that never touches the RaceResult importer would otherwise show as never
   * having stored anything.
   *
   * The MODE is deliberately not touched. What is public is prod's decision,
   * made once on the Sync screen, and a push that could turn the standings on
   * by itself would publish an unfinished race the first time somebody tested
   * the connection.
   */
  private async finishResults(eventId: string, batch: string) {
    const removed = await this.db.q(
      `DELETE FROM results
        WHERE event_id = $1::uuid AND sync_batch IS DISTINCT FROM $2::uuid`,
      [eventId, batch],
    );
    const withdrawn = await this.db.q(
      `DELETE FROM athletes
        WHERE event_id = $1::uuid AND sync_batch IS DISTINCT FROM $2::uuid`,
      [eventId, batch],
    );
    await this.db.q(
      `UPDATE events SET results_stored_at = now(), updated_at = now()
        WHERE id = $1`,
      [eventId],
    );
    this.logger.log(
      `Results push complete for ${eventId} (batch ${batch}): ` +
        `${removed.rowCount ?? 0} stale result(s) and ` +
        `${withdrawn.rowCount ?? 0} withdrawn athlete(s) removed`,
    );
    return removed.rowCount ?? 0;
  }

  /**
   * The athletes a results chunk carries, one per athlete, validated.
   *
   * TWO CHECKS, AND BOTH HAVE BITTEN. A result whose `athlete_id` does not
   * match the `id` of the athlete travelling with it was built from two
   * different people, and would write one person's row and another person's
   * result against it — which the foreign key cannot catch, because both ids
   * exist. And the same athlete legitimately appears on several rows of one
   * chunk (a doubles entrant has a team result and an individual one), so the
   * list is deduplicated by id before it reaches an INSERT whose ON CONFLICT
   * cannot see a duplicate inside its own VALUES.
   */
  private athletesOf(rows: IngestResultRow[]): IngestAthleteRow[] {
    const byId = new Map<string, IngestAthleteRow>();
    for (const row of rows) {
      const athlete = row?.athlete;
      if (!athlete || !athlete.id) {
        throw new BadRequestException(
          `The result for bib ${row?.bib ?? '(none)'} carries no athlete. Every result must travel with the athlete it belongs to.`,
        );
      }
      if (athlete.id !== row.athlete_id) {
        throw new BadRequestException(
          `The result for bib ${row.bib} names athlete ${row.athlete_id} but carries athlete ${athlete.id}.`,
        );
      }
      byId.set(athlete.id, athlete);
    }
    return [...byId.values()];
  }

  /** A stable digest of the configuration bundle, so the local server can tell
   *  a pull that changed something from one that did not without diffing it.
   *  Keys are sorted at every level: `JSON.stringify` preserves insertion
   *  order, and two queries that return the same row can return its columns in
   *  a different order across a schema change, which would otherwise read as a
   *  configuration change on every pull after a deploy. */
  private fingerprint(value: unknown): string {
    const stable = (input: unknown): unknown => {
      if (Array.isArray(input)) return input.map(stable);
      if (input && typeof input === 'object') {
        return Object.fromEntries(
          Object.entries(input as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, stable(v)]),
        );
      }
      return input;
    };
    return createHash('sha256')
      .update(JSON.stringify(stable(value)))
      .digest('hex');
  }

  /** Scratch space for one live push, namespaced by batch so two pushes cannot
   *  read each other's chunks. */
  private stageKey(batch: string, seq: number): string {
    return `hjudge:ingest:${batch}:${seq}`;
  }

  private batchId(chunk: { batch?: string }): string {
    const batch = String(chunk?.batch ?? '').trim();
    if (!UUID.test(batch)) {
      throw new BadRequestException('A push must carry a uuid batch id');
    }
    return batch;
  }

  private rowsOf<T>(chunk: { rows?: T[] }, what: string): T[] {
    const rows = chunk?.rows;
    if (rows === undefined || rows === null) return [];
    if (!Array.isArray(rows)) {
      throw new BadRequestException(`${what} must be sent as an array of rows`);
    }
    return rows;
  }

  private normaliseScopes(input?: string[]): HjudgeIngestScope[] {
    const wanted = (Array.isArray(input) ? input : HJUDGE_INGEST_SCOPES)
      .map((s) => String(s).trim().toLowerCase())
      .filter((s): s is HjudgeIngestScope =>
        (HJUDGE_INGEST_SCOPES as readonly string[]).includes(s),
      );
    const unique = [...new Set(wanted)];
    if (!unique.length) {
      throw new BadRequestException(
        `A credential must carry at least one of: ${HJUDGE_INGEST_SCOPES.join(', ')}`,
      );
    }
    return unique;
  }

  private normaliseHours(input?: number): number {
    const hours = Number(input ?? hjudgeSyncConfig.credentialDefaultHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 90) {
      throw new BadRequestException(
        'A credential must last between 1 hour and 90 days',
      );
    }
    return Math.round(hours);
  }

  /** Best-effort, like every other write to this table: an audit row that
   *  cannot be written is not a reason to fail the act it was describing. */
  private async audit(
    eventId: string,
    actorId: string | null,
    action: string,
    entityId: string,
    details: Record<string, unknown>,
  ) {
    try {
      await this.db.q(
        `INSERT INTO audit_events (actor_id, event_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, $3, 'event_sync', $4, $5::jsonb)`,
        [actorId, eventId, action, entityId, JSON.stringify(details)],
      );
    } catch (error) {
      this.logger.warn(`Audit write failed for ${action}: ${error}`);
    }
  }

  /** Guard rail for the console: minting and revoking are prod-role acts, and a
   *  local server offering them would hand an operator a credential nothing
   *  will ever present. */
  assertProdRole() {
    if (hjudgeSyncConfig.nodeRole !== 'prod') {
      throw new ForbiddenException(
        'This server runs as a local node — sync credentials are issued on prod',
      );
    }
  }
}
