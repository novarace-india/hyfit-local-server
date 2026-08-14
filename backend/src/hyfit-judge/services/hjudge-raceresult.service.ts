import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { HjudgeDbService } from '../hjudge-db.service';
import { HjudgeCacheService } from '../hjudge-cache.service';
import {
  buildCheckinRoster,
  buildAssignmentTable,
  holderOfAnyAsset,
  bibKey,
  assetKey,
  checkinFieldNames,
  type AssignmentTable,
  type CheckinRoster,
  type CheckinRosterEntry,
} from '../hjudge-checkin-rr.util';

/**
 * The event's RaceResult endpoints, and everything read through or written to
 * them.
 *
 * One place, because two apps need the same answers about the same start list:
 * the check-in counter asks "who is this bib and have they been through?", and
 * the judge asks "who is wearing this transponder and did they finish Stage 2?"
 * — both of which are now facts RaceResult holds, not the database. Splitting
 * that between two services is how the codebase got two sources of truth the
 * last four times.
 *
 * Postgres is still consulted for one thing here: where the endpoints are.
 */

export interface RaceResultConfig {
  participantApiUrl: string;
  updateApiUrl: string;
  /** The equipment assignment table: its own Custom API, fetched whole. The
   *  counter's authority on what an athlete already holds and on who a scanned
   *  code belongs to. Blank stops check-in entirely rather than being guessed
   *  at — without it there is no way to know a band is already spoken for. */
  mapLookupUrl: string;
  /** The standings Custom API. Its own key — nothing about it is derived from
   *  the participant one. Blank when the event publishes no results feed, which
   *  is a normal state: check-in and judging do not need it. */
  resultsUrl: string;
  participantMapping: Record<string, unknown>;
  updateMapping: Record<string, unknown>;
  resultsMapping: Record<string, unknown>;
  declarationText: string;
  declarationVersion: number;
  checkinWindowEnabled: boolean;
  checkinOpensBeforeMinutes: number;
  checkinClosesAfterMinutes: number | null;
  timeZone: string;
  eventDate: string | null;
  eventStartsAt: string | null;
}

/** What the judge app needs to know about an athlete's equipment. */
export interface AthleteEquipment {
  bib: string;
  wristbandCode: string;
  transponderCode: string;
  stage2Ready: boolean;
}

const DEFAULT_DECLARATION =
  'I confirm that my participant details are correct and that I have received the assigned race equipment.';

/** How long the full start list may be reused. It is only ever used to FIND an
 *  athlete; an athlete's own state is re-read for their bib alone, so a stale
 *  copy can misplace a search by a few seconds but cannot report stale state. */
const ROSTER_CACHE_SECONDS = 20;

@Injectable()
export class HjudgeRaceResultService {
  private readonly logger = new Logger(HjudgeRaceResultService.name);

  constructor(
    private readonly db: HjudgeDbService,
    private readonly cache: HjudgeCacheService,
  ) {}

  async loadConfig(eventId: string): Promise<RaceResultConfig> {
    const result = await this.db.q(
      // `raceresults_endpoints` is unique on (event_id) WHERE published, so the
      // LATERAL takes the one published row or nothing. An event mid-setup has
      // only drafts and legitimately returns none — hence the LEFT JOIN and the
      // COALESCEs below rather than a failure.
      `SELECT c.bib_lookup_url AS "participantApiUrl",
              c.update_url AS "updateApiUrl",
              c.map_lookup_url AS "mapLookupUrl",
              c.results_url AS "resultsUrl",
              c.participant_mapping AS "participantMapping",
              c.update_mapping AS "updateMapping",
              c.results_mapping AS "resultsMapping",
              c.declaration_text AS "declarationText",
              c.declaration_version AS "declarationVersion",
              c.checkin_window_enabled AS "checkinWindowEnabled",
              c.checkin_opens_before_minutes AS "checkinOpensBeforeMinutes",
              c.checkin_closes_after_minutes AS "checkinClosesAfterMinutes",
              e.timezone AS "timeZone",
              to_char(e.event_date, 'YYYY-MM-DD') AS "eventDate",
              e.starts_at AS "eventStartsAt"
         FROM events e
         LEFT JOIN LATERAL (
           SELECT * FROM raceresults_endpoints
            WHERE event_id = e.id AND state = 'published'
            ORDER BY version DESC LIMIT 1
         ) c ON true
        WHERE e.id = $1`,
      [eventId],
    );
    const row = result.rows[0];
    if (!row) throw new BadRequestException('Event not found');

    return {
      participantApiUrl: String(row.participantApiUrl ?? '').trim(),
      updateApiUrl: String(row.updateApiUrl ?? '').trim(),
      mapLookupUrl: String(row.mapLookupUrl ?? '').trim(),
      resultsUrl: String(row.resultsUrl ?? '').trim(),
      participantMapping: row.participantMapping ?? {},
      updateMapping: row.updateMapping ?? {},
      resultsMapping: row.resultsMapping ?? {},
      declarationText: row.declarationText || DEFAULT_DECLARATION,
      declarationVersion: row.declarationVersion ?? 1,
      checkinWindowEnabled: Boolean(row.checkinWindowEnabled),
      checkinOpensBeforeMinutes: row.checkinOpensBeforeMinutes ?? 240,
      checkinClosesAfterMinutes: row.checkinClosesAfterMinutes ?? null,
      timeZone: row.timeZone || 'Asia/Kolkata',
      eventDate: row.eventDate ?? null,
      eventStartsAt: row.eventStartsAt ?? null,
    };
  }

  isConfigured(config: RaceResultConfig) {
    return /^https?:\/\//i.test(config.participantApiUrl);
  }

  canWrite(config: RaceResultConfig) {
    return /^https?:\/\//i.test(config.updateApiUrl);
  }

  requireFeed(config: RaceResultConfig) {
    if (!this.isConfigured(config)) {
      throw new BadRequestException(
        'This event has no RaceResult participant endpoint. Set one in Operations before opening a counter.',
      );
    }
  }

  private async fetchPayload(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!res.ok) {
        this.logger.warn(
          `RaceResult participant GET returned HTTP ${res.status}`,
        );
        return [];
      }
      const data = await res.json();
      if (Array.isArray(data)) return data;
      if (data && typeof data === 'object') {
        for (const key of ['participants', 'data', 'list', 'rows']) {
          if (Array.isArray((data as any)[key])) return (data as any)[key];
        }
      }
      return data;
    } catch (err) {
      this.logger.warn(
        `RaceResult participant GET failed: ${(err as Error).message}`,
      );
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  roster(payload: unknown, config: RaceResultConfig): CheckinRoster {
    return buildCheckinRoster(
      payload,
      config.participantMapping,
      config.updateMapping,
    );
  }

  /**
   * The whole start list.
   *
   * Needed whenever the answer is not keyed by bib — a wristband scan, a
   * doubles partner — because `bib` is the only parameter this Custom API
   * filters on. Single-athlete reads go through `fetchAthlete`, which asks for
   * one bib and gets a few hundred bytes instead of 950 KB.
   *
   * `fresh` bypasses the cache. Reads that only need to FIND somebody may use
   * the cached copy; a read that a check-in is about to be written against must
   * not, or two counters could hand out bands inside the same cache window.
   */
  async fetchFullRoster(
    config: RaceResultConfig,
    eventId: string,
    opts: { fresh?: boolean } = {},
  ): Promise<CheckinRoster> {
    const key = `hjudge:checkin:roster:${eventId}`;
    if (!opts.fresh) {
      const cached = await this.cache.get<unknown>(key).catch(() => null);
      if (cached) return this.roster(cached, config);
    }

    const payload = await this.fetchPayload(config.participantApiUrl);
    await this.cache
      .set(key, payload, ROSTER_CACHE_SECONDS)
      .catch(() => undefined);
    return this.roster(payload, config);
  }

  /**
   * One athlete, asked for by bib.
   *
   * `?bib=` is a real server-side filter here: 300-odd bytes rather than the
   * 950 KB start list, on every scan and every check-in. Verified on
   * 2026-08-12 that the filtered row is byte-identical to the same row in the
   * full list — equipment, the stage flags, the times and the issuers all
   * present. (An earlier session concluded the opposite; that test compared a
   * live filtered read against a snapshot taken before the roster was cleared,
   * so it was measuring the roster, not the filter.)
   *
   * Still matched client-side afterwards, so a deployment whose API ignores the
   * parameter answers with everything and finds the same row.
   */
  async fetchAthlete(
    config: RaceResultConfig,
    eventId: string,
    bib: string,
    opts: { fresh?: boolean } = {},
  ): Promise<CheckinRosterEntry | null> {
    const target = new URL(config.participantApiUrl);
    target.searchParams.set('bib', String(bib).trim());
    const roster = this.roster(
      await this.fetchPayload(target.toString()),
      config,
    );
    const found = roster.byBib.get(bibKey(bib));
    if (found) return found;

    // A feed that returned nothing for the filter may simply not support it and
    // have answered with an empty envelope; fall back to the whole list rather
    // than reporting an athlete who is on the start list as missing.
    if (roster.entries.length) return null;
    const full = await this.fetchFullRoster(config, eventId, opts);
    return full.byBib.get(bibKey(bib)) ?? null;
  }

  /** Whether the event has an equipment mapping table configured. */
  canUseMapLookup(config: RaceResultConfig) {
    return /^https?:\/\//i.test(config.mapLookupUrl);
  }

  /**
   * The equipment assignment table.
   *
   * Fetched WHOLE — no `?bib=`, no filter of any kind. This endpoint does not
   * take one; it is a table, and the row is found here.
   *
   * Every check-in now goes through this, not just the ones that start from a
   * wristband: it is what says which stage an athlete is due and whether the
   * code about to be handed over already belongs to somebody. So an event
   * without it cannot open a counter at all, where it used to only lose Stage 2.
   *
   * `fresh` bypasses the cache, and a hand-over always asks for fresh. The
   * cached copy is fine for finding somebody; it is not fine for deciding
   * whether a band is spoken for, because two desks a few seconds apart would
   * both read it as free.
   */
  async fetchAssignments(
    config: RaceResultConfig,
    eventId: string,
    opts: { fresh?: boolean } = {},
  ): Promise<AssignmentTable> {
    this.requireMapLookup(config);

    const key = `hjudge:checkin:assignments:${eventId}`;
    if (!opts.fresh) {
      const cached = await this.cache.get<unknown>(key).catch(() => null);
      if (cached) return buildAssignmentTable(cached, config.updateMapping);
    }

    const payload = await this.fetchPayload(config.mapLookupUrl);
    await this.cache
      .set(key, payload, ROSTER_CACHE_SECONDS)
      .catch(() => undefined);
    return buildAssignmentTable(payload, config.updateMapping);
  }

  requireMapLookup(config: RaceResultConfig) {
    if (!this.canUseMapLookup(config)) {
      throw new BadRequestException(
        'This event has no RaceResult equipment mapping endpoint. Set it in Operations before opening a counter — it is what says which equipment an athlete already holds.',
      );
    }
  }

  /**
   * The athlete carrying this code, in full.
   *
   * Two hops, which is the whole point of the mapping table: the code gives a
   * BIB, and the BIB gives the athlete. The second hop goes to the participant
   * feed with `?bib=`, so a counter that started from a scan sees exactly the
   * same details as one that started from a race number — name, contest, slot,
   * club — from the same place, rather than whatever subset the mapping table
   * happens to carry.
   *
   * Both equipment columns are searched. Someone at the counter is carrying a
   * wristband, or a transponder, or both, and which of them they hold up is not
   * the desk's decision to make; a scan that only ever meant "wristband" simply
   * failed to find an athlete who offered the other one.
   */
  async fetchAthleteByAssetCode(
    config: RaceResultConfig,
    eventId: string,
    code: string,
    opts: { fresh?: boolean } = {},
  ): Promise<CheckinRosterEntry | null> {
    if (!assetKey(code)) return null;

    const table = await this.fetchAssignments(config, eventId, opts);
    const bib = holderOfAnyAsset(table, code)?.assignment.bib;
    if (!bib) return null;

    return this.fetchAthlete(config, eventId, bib, opts);
  }

  // ------------------------------------------------- equipment (judge side)

  private equipmentOf(entry: CheckinRosterEntry): AthleteEquipment {
    return {
      bib: entry.person.bib,
      wristbandCode: entry.person.wristbandCode,
      transponderCode: entry.person.transponderCode,
      stage2Ready: Boolean(entry.stages.STAGE_2_TRANSPONDER),
    };
  }

  /**
   * Who is wearing this wristband or transponder.
   *
   * A wristband wins a code issued as both, because that is the identifier
   * every other judging path is keyed on.
   */
  async findByCode(
    eventId: string,
    code: string,
    opts: { fresh?: boolean } = {},
  ): Promise<{
    equipment: AthleteEquipment;
    matchedAssetType: string;
    entry: CheckinRosterEntry;
    roster: CheckinRoster;
  } | null> {
    const config = await this.loadConfig(eventId);
    if (!this.isConfigured(config)) return null;
    const wanted = assetKey(code);
    if (!wanted) return null;

    const roster = await this.fetchFullRoster(config, eventId, opts);
    const byWristband = roster.entries.find(
      (entry) => assetKey(entry.person.wristbandCode) === wanted,
    );
    const match =
      byWristband ??
      roster.entries.find(
        (entry) => assetKey(entry.person.transponderCode) === wanted,
      );
    if (!match) return null;

    return {
      equipment: this.equipmentOf(match),
      matchedAssetType: byWristband ? 'wristband' : 'transponder1',
      entry: match,
      roster,
    };
  }

  /** Equipment for a set of bibs, in one pull of the start list. */
  async equipmentByBibs(
    eventId: string,
    bibs: string[],
  ): Promise<Map<string, AthleteEquipment>> {
    const out = new Map<string, AthleteEquipment>();
    const wanted = bibs.map(bibKey).filter(Boolean);
    if (!wanted.length) return out;

    const config = await this.loadConfig(eventId);
    if (!this.isConfigured(config)) return out;

    const roster = await this.fetchFullRoster(config, eventId);
    for (const bib of wanted) {
      const entry = roster.byBib.get(bib);
      if (entry) out.set(bib, this.equipmentOf(entry));
    }
    return out;
  }

  /** Blank equipment, for an athlete RaceResult has nothing on. */
  static readonly noEquipment: AthleteEquipment = {
    bib: '',
    wristbandCode: '',
    transponderCode: '',
    stage2Ready: false,
  };

  // ----------------------------------------------------------------- write

  /**
   * Writes one field to RaceResult.
   *
   * GET, because a RaceResult Custom API is a URL you call — the server answers
   * POST with 405 whatever the API does. One retry, because the alternative to
   * a transient blip at a counter is asking a volunteer to redo a check-in that
   * nearly worked.
   */
  async writeField(
    config: RaceResultConfig,
    bib: string,
    fieldName: string,
    value: string,
  ): Promise<void> {
    if (!this.canWrite(config)) {
      throw new BadRequestException(
        'This event has no RaceResult update endpoint. Set one in Operations before checking anyone in.',
      );
    }
    const target = new URL(config.updateApiUrl);
    target.searchParams.set('bib', bib);
    target.searchParams.set('fieldname', fieldName);
    target.searchParams.set('value', value);
    // 0 means "record this in the participant's history", which is what an
    // official check-in should do.
    target.searchParams.set('nohistory', '0');

    const attempt = async () => {
      const res = await fetch(target, {
        method: 'GET',
        signal: AbortSignal.timeout(8000),
        headers: { accept: 'application/json,text/plain,*/*' },
      });
      if (!res.ok) {
        const detail = await res
          .text()
          .then((body) => body.trim().replace(/\s+/g, ' ').slice(0, 200))
          .catch(() => '');
        throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
      }
    };

    try {
      await attempt();
    } catch (first) {
      this.logger.warn(
        `RaceResult write ${fieldName}=${value} for BIB ${bib} failed once: ${(first as Error).message}`,
      );
      try {
        await attempt();
      } catch (second) {
        throw new BadRequestException(
          `RaceResult did not accept ${fieldName}: ${(second as Error).message}. Nothing was recorded for this field — try again.`,
        );
      }
    }
  }

  /** The field names this event uses, for callers that write directly. */
  fieldNames(config: RaceResultConfig) {
    return checkinFieldNames(config.updateMapping);
  }
}
