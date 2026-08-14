import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { HjudgeDbService } from '../hjudge-db.service';
import { HjudgeCacheService } from '../hjudge-cache.service';
import { tokenHash } from '../hjudge-session.util';
import {
  HJUDGE_INGEST_SCOPES,
  hjudgeSyncConfig,
  type HjudgeIngestScope,
} from '../hjudge-sync.config';
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

/** One result, exactly as `hyfit_v2.results` holds it. */
export interface IngestResultRow {
  id: string;
  athlete_id: string;
  bib: string;
  name: string;
  category: string | null;
  club: string | null;
  status: string;
  rank: number | null;
  age_group_rank: number | null;
  total_ms: number | null;
  team_time_ms: number | null;
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
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The receiving half of an offline event.
 *
 * Two jobs that share a table and nothing else:
 *
 *   1. MINTING. The console creates a credential for one offline event; the
 *      secret is returned once, here, and never again — only its hash is kept.
 *   2. RECEIVING. A local server pushes the event's roster and standings in
 *      chunks, and this writes them into the same two tables the RaceResult
 *      importer writes, then invalidates the same cache keys. From the public
 *      read's point of view an offline event is indistinguishable from an
 *      online one, which is the whole design: `HjudgePublicController` does not
 *      know this file exists.
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
        String(body?.label ?? '').trim().slice(0, 120),
        scopes,
        hours,
        user?.id ?? null,
      ],
    );

    await this.audit(eventId, user?.id ?? null, 'sync.credential.mint', row!.id, {
      scopes,
      hours,
    });

    this.logger.log(
      `Sync credential ${row!.id} minted for event ${eventId} (${scopes.join(', ')}, ${hours}h)`,
    );

    return {
      id: row!.id,
      expiresAt: row!.expires_at,
      scopes,
      /** Everything the local server needs, in one thing to copy. It carries
       *  the prod event id because the two databases were created by hand and
       *  neither knows the other's uuid — see `event_push_targets`. */
      credential: {
        baseUrl: '',
        eventId,
        eventName: event.name,
        token: secret,
        expiresAt: row!.expires_at,
      },
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
    await this.audit(eventId, user?.id ?? null, 'sync.credential.revoke', row.id, {});
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
   * One chunk of a roster snapshot.
   *
   * The rows carry the local server's own ids and keep them here: prod's
   * `athletes.id` for an offline event IS the venue's, which is what lets the
   * results chunk reference `athlete_id` directly instead of re-deriving who
   * each result belongs to from a name and a phone number.
   *
   * The delete before the insert is the price of that. `hyfit_v2_athletes_entry`
   * (085) makes (event, phone, name, category) unique, so a prod row that
   * already describes an incoming athlete under a DIFFERENT id — a roster
   * imported here before the event was moved offline, or a venue laptop rebuilt
   * mid-event — would fail the insert on a constraint the `ON CONFLICT (id)`
   * clause cannot see. Clearing those first makes the push authoritative, which
   * for an offline event it is.
   */
  async ingestAthletes(
    principal: HjudgeIngestPrincipal,
    chunk: IngestChunk<IngestAthleteRow>,
  ) {
    const batch = this.batchId(chunk);
    const rows = this.rowsOf(chunk, 'athletes');

    const written = await this.db.tx(async (client) => {
      if (!rows.length) return 0;

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
            rows.map((r) => ({
              id: r.id,
              mobile: r.mobile ?? '',
              name: r.name ?? '',
              category: r.category ?? '',
            })),
          ),
        ],
      );

      const inserted = await client.query(
        `INSERT INTO athletes (
           id, event_id, bib, name, gender, date_of_birth, age, mobile, club,
           category, contest_id, wave, timeslot, contest_date, source,
           source_id, raw, created_at, updated_at, sync_batch)
         SELECT t.id, $1::uuid, t.bib, t.name, t.gender, t.date_of_birth, t.age,
                t.mobile, t.club, COALESCE(t.category, ''), t.contest_id,
                t.wave, t.timeslot, t.contest_date,
                COALESCE(NULLIF(t.source, ''), 'raceresult'), t.source_id,
                COALESCE(t.raw, '{}'::jsonb),
                COALESCE(t.created_at, now()), COALESCE(t.updated_at, now()), $3::uuid
           FROM jsonb_to_recordset($2::jsonb) AS t(
                  id uuid, bib text, name text, gender text,
                  date_of_birth date, age integer, mobile text, club text,
                  category text, contest_id text, wave text, timeslot text,
                  contest_date date, source text, source_id text, raw jsonb,
                  created_at timestamptz, updated_at timestamptz)
         ON CONFLICT (id) DO UPDATE SET
           bib           = excluded.bib,
           name          = excluded.name,
           gender        = excluded.gender,
           date_of_birth = excluded.date_of_birth,
           age           = excluded.age,
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
        [principal.eventId, JSON.stringify(rows), batch],
      );
      return inserted.rowCount ?? 0;
    });

    const pruned = chunk?.final
      ? await this.finishAthletes(principal.eventId, batch)
      : 0;

    if (chunk?.final) await this.cache.invalidateEvent(principal.eventId);

    return {
      received: rows.length,
      written,
      pruned,
      batch,
      final: Boolean(chunk?.final),
    };
  }

  /**
   * One chunk of a standings snapshot.
   *
   * `results` is one row per athlete (085's `hyfit_v2_results_athlete`), so a
   * result arriving for an athlete who already has one under a different id has
   * to displace it — same shape as the roster's natural-key clear above, one
   * column narrower.
   *
   * A result whose athlete this server does not have is refused with a message
   * that says what to do about it. It means the roster and the standings were
   * pushed out of order, the local server's own push sequence prevents it, and
   * the alternative — inventing an athlete row from a result — is how a start
   * list quietly grows people nobody entered.
   */
  async ingestResults(
    principal: HjudgeIngestPrincipal,
    chunk: IngestChunk<IngestResultRow>,
  ) {
    const batch = this.batchId(chunk);
    const rows = this.rowsOf(chunk, 'results');

    let written = 0;
    try {
      written = await this.db.tx(async (client) => {
        if (!rows.length) return 0;

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
             rank, age_group_rank, total_ms, team_time_ms, cog_ms,
             run1_ms, st1_ms, run2_ms, st2_ms, run3_ms, st3_ms,
             run4_ms, st4_ms, run5_ms, st5_ms, run6_ms, st6_ms,
             penalties, raw, source_url, imported_at, sync_batch)
           SELECT t.id, $1::uuid, t.athlete_id, t.bib, t.name, t.category, t.club,
                  COALESCE(NULLIF(t.status, ''), 'FIN'),
                  t.rank, t.age_group_rank, t.total_ms, t.team_time_ms, t.cog_ms,
                  t.run1_ms, t.st1_ms, t.run2_ms, t.st2_ms, t.run3_ms, t.st3_ms,
                  t.run4_ms, t.st4_ms, t.run5_ms, t.st5_ms, t.run6_ms, t.st6_ms,
                  COALESCE(t.penalties, '{}'::jsonb), COALESCE(t.raw, '{}'::jsonb),
                  t.source_url, COALESCE(t.imported_at, now()), $3::uuid
             FROM jsonb_to_recordset($2::jsonb) AS t(
                    id uuid, athlete_id uuid, bib text, name text, category text,
                    club text, status text, rank integer, age_group_rank integer,
                    total_ms bigint, team_time_ms bigint, cog_ms bigint,
                    run1_ms bigint, st1_ms bigint, run2_ms bigint, st2_ms bigint,
                    run3_ms bigint, st3_ms bigint, run4_ms bigint, st4_ms bigint,
                    run5_ms bigint, st5_ms bigint, run6_ms bigint, st6_ms bigint,
                    penalties jsonb, raw jsonb, source_url text,
                    imported_at timestamptz)
           ON CONFLICT (id) DO UPDATE SET
             athlete_id     = excluded.athlete_id,
             bib            = excluded.bib,
             name           = excluded.name,
             category       = excluded.category,
             club           = excluded.club,
             status         = excluded.status,
             rank           = excluded.rank,
             age_group_rank = excluded.age_group_rank,
             total_ms       = excluded.total_ms,
             team_time_ms   = excluded.team_time_ms,
             cog_ms         = excluded.cog_ms,
             run1_ms = excluded.run1_ms, st1_ms = excluded.st1_ms,
             run2_ms = excluded.run2_ms, st2_ms = excluded.st2_ms,
             run3_ms = excluded.run3_ms, st3_ms = excluded.st3_ms,
             run4_ms = excluded.run4_ms, st4_ms = excluded.st4_ms,
             run5_ms = excluded.run5_ms, st5_ms = excluded.st5_ms,
             run6_ms = excluded.run6_ms, st6_ms = excluded.st6_ms,
             penalties      = excluded.penalties,
             raw            = excluded.raw,
             source_url     = excluded.source_url,
             imported_at    = excluded.imported_at,
             sync_batch     = excluded.sync_batch`,
          [principal.eventId, JSON.stringify(rows), batch],
        );
        return inserted.rowCount ?? 0;
      });
    } catch (error: any) {
      if (error?.code === '23503') {
        throw new BadRequestException(
          'These results reference athletes this server does not have. Push the roster for this event first, then push the results.',
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
    };
  }

  // ───────────────────────────────────────────────────────────── internals

  /** The roster is complete: whatever this event still holds that the push did
   *  not bring is no longer on the start list. `results.athlete_id` cascades,
   *  so an athlete withdrawn at the venue takes their result with them. */
  private async finishAthletes(eventId: string, batch: string) {
    const removed = await this.db.q(
      `DELETE FROM athletes
        WHERE event_id = $1::uuid AND sync_batch IS DISTINCT FROM $2::uuid`,
      [eventId, batch],
    );
    this.logger.log(
      `Roster push complete for ${eventId} (batch ${batch}): ${removed.rowCount ?? 0} stale athlete(s) removed`,
    );
    return removed.rowCount ?? 0;
  }

  /** The standings are complete. `results_stored_at` is stamped because that is
   *  what the console and the public read mean by "when did this event last
   *  publish" — an offline event that never touches the RaceResult importer
   *  would otherwise show as never having stored anything.
   *
   *  The MODE is deliberately not touched. What is public is prod's decision,
   *  made once on the Sync screen, and a push that could turn the standings on
   *  by itself would publish an unfinished race the first time somebody tested
   *  the connection. */
  private async finishResults(eventId: string, batch: string) {
    const removed = await this.db.q(
      `DELETE FROM results
        WHERE event_id = $1::uuid AND sync_batch IS DISTINCT FROM $2::uuid`,
      [eventId, batch],
    );
    await this.db.q(
      `UPDATE events SET results_stored_at = now(), updated_at = now()
        WHERE id = $1`,
      [eventId],
    );
    this.logger.log(
      `Results push complete for ${eventId} (batch ${batch}): ${removed.rowCount ?? 0} stale row(s) removed`,
    );
    return removed.rowCount ?? 0;
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
