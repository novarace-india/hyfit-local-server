import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { HfgDbService } from '../hfg-db.service';
import { HfgCacheService } from '../hfg-cache.service';
import { computeAgeGroup, clubKey } from './hfg-results.service';
import {
  parseLiveResults,
  type LiveResultRecord,
} from '../hfg-live-results.util';

/* Live results: standings pulled from RaceResult that athletes can see BEFORE
 * anything is written to `results`.
 *
 * The rule the whole service exists to keep: a pull writes to Valkey and
 * nothing else. `results` and `category_entries.race_status` are touched by
 * `persist()`, which only the publish action calls. An operator can pull a feed
 * ten times during a race and the database still holds exactly what they last
 * consciously published — which is what makes it safe to put a mid-race feed in
 * front of athletes at all.
 *
 * The rows are shaped to match the ones `GET /events/:id/results` builds from
 * the database, field for field, because the athlete pages render whichever
 * they are handed. A live row that needed its own component would mean two
 * renderers to keep in step, and the doubles half of that (see `teamColumns`)
 * is precisely the code that has already needed three passes to get right.
 */

// A live row is the source of truth for a race in progress, so it must outlive
// the race. Twelve hours covers the longest event day with the venue's wifi
// dropping in the middle of it; every pull resets the clock. It is still a
// cache — see `persist()` for what happens to survive.
const LIVE_TTL_SECONDS = 12 * 60 * 60;

const FETCH_TIMEOUT_MS = 15_000;

export type LiveRow = {
  entry_id: string | null;
  registration_id: string | null;
  bib: string;
  status: string;
  category: string | null;
  full_name: string | null;
  gender: string | null;
  city: string | null;
  total_ms: number | null;
  overall_rank: number | null;
  gender_rank: number | null;
  age_group: string | null;
  age_group_rank: number | null;
  field_size: number | null;
  team_name: string | null;
  team_total_ms: number | null;
  team_rank: number | null;
  team_members: LiveMember[] | null;
  // Not in the database shape: the operator's warning that this bib is in the
  // feed but not on the roster. The athlete pages never see it — an unmatched
  // row has no athlete to belong to — but the admin preview leads with it,
  // because it is almost always a wrong bib column in the mapping.
  unmatched?: true;
};

type LiveMember = {
  entry_id: string | null;
  bib: string;
  full_name: string | null;
  total_ms: number | null;
  category_rank: number | null;
  status: string;
  is_self: boolean;
};

export type LivePayload = {
  event_id: string;
  url: string;
  fetched_at: string;
  source_count: number;
  rejected: number;
  unmatched: number;
  rows: LiveRow[];
};

type RosterEntry = {
  entry_id: string;
  registration_id: string;
  bib: string;
  club: string | null;
  category: string | null;
  team_size_min: number;
  team_size_max: number;
  full_name: string;
  gender: string | null;
  city: string | null;
  dob: string | null;
};

/* Ties share a rank and the next one skips (1,1,3) — the same semantics
 * `computeResults` uses, so a placing does not change meaning when the event is
 * published. Entries with no time are not ranked at all.
 */
function rankBy<T>(
  items: T[],
  time: (item: T) => number | null,
  assign: (item: T, rank: number) => void,
) {
  const timed = items.filter((i) => time(i) !== null);
  timed.sort((a, b) => (time(a) as number) - (time(b) as number));
  let prev: number | null = null;
  let prevRank = 0;
  timed.forEach((item, i) => {
    const t = time(item) as number;
    const rank = t === prev ? prevRank : i + 1;
    assign(item, rank);
    prev = t;
    prevRank = rank;
  });
}

@Injectable()
export class HfgLiveResultsService {
  private readonly logger = new Logger(HfgLiveResultsService.name);

  constructor(
    private readonly db: HfgDbService,
    private readonly cache: HfgCacheService,
  ) {}

  // ───────────────────────────────────────────────────────────── the toggle

  async getState(eventId: string): Promise<{
    enabled: boolean;
    results_status: string;
    payload: LivePayload | null;
  }> {
    const { rows } = await this.db.q(
      'SELECT live_results_enabled, results_status FROM events WHERE id = $1',
      [eventId],
    );
    if (!rows[0]) throw new BadRequestException('Event not found');
    return {
      enabled: Boolean(rows[0].live_results_enabled),
      results_status: rows[0].results_status,
      payload: await this.read(eventId),
    };
  }

  async setEnabled(eventId: string, enabled: boolean) {
    const { rows } = await this.db.q(
      `UPDATE events SET live_results_enabled = $2 WHERE id = $1
       RETURNING id, live_results_enabled, results_status`,
      [eventId, enabled],
    );
    if (!rows[0]) throw new BadRequestException('Event not found');

    // The athlete-facing results and leaderboard reads are cached under
    // `ev:{id}:*`, and flipping this switch changes what they should return
    // without changing anything they read from. Without this the toggle appears
    // not to work for up to 30 seconds, which an operator reasonably reads as
    // "it is broken" and clicks again.
    await this.cache.invalidateEvent(eventId);
    return { enabled: Boolean(rows[0].live_results_enabled) };
  }

  // ───────────────────────────────────────────────────────────── the feed

  private liveKey(eventId: string) {
    return this.cache.liveResultsKey(eventId);
  }

  read(eventId: string): Promise<LivePayload | null> {
    return this.cache.get<LivePayload>(this.liveKey(eventId));
  }

  async clear(eventId: string) {
    await this.cache.delete(this.liveKey(eventId));
    await this.cache.invalidateEvent(eventId);
  }

  /** The rows the athlete-facing routes should serve, or null to fall through
   *  to the database.
   *
   *  The cache is read BEFORE the event row, and the order is deliberate. The
   *  leaderboard calls this ahead of its own cache — it has to, or a live event
   *  would be served the stale split-derived board — so this runs on every poll
   *  from every viewer, every 15 seconds. Checking Postgres first would put a
   *  query behind each of those for every event, including the overwhelming
   *  majority that never pull a feed at all. A Valkey GET that misses answers
   *  that case without touching the database.
   *
   *  Once there IS a feed, the event row decides whether it may be shown. Live
   *  rows only ever pre-empt an UNPUBLISHED event: after results_status leaves
   *  'none' the published numbers are the real ones, and a feed left in the
   *  cache must not be able to talk over them. */
  async liveRowsFor(eventId: string): Promise<LivePayload | null> {
    const payload = await this.read(eventId);
    if (!payload?.rows?.length) return null;

    const { rows } = await this.db.q(
      'SELECT live_results_enabled, results_status FROM events WHERE id = $1',
      [eventId],
    );
    if (!rows[0]) return null;
    if (!rows[0].live_results_enabled) return null;
    if (rows[0].results_status !== 'none') return null;

    return payload;
  }

  /* Pull the feed, resolve it against the roster, cache it. Synchronous, unlike
   * the roster import next door: that one writes three tables for 2500 athletes
   * and had to be handed to the background, while this one writes a single
   * Valkey key and the operator is standing at the console waiting to see the
   * standings before they switch them on.
   */
  async pull(
    eventId: string,
    opts: { url: string; mapping?: Record<string, unknown> },
  ): Promise<LivePayload> {
    const url = String(opts.url || '').trim();
    if (!/^https?:\/\//i.test(url))
      throw new BadRequestException(
        'A complete http(s) RaceResult results endpoint is required',
      );

    const payload = await this.fetchJson(url);
    const { records, rejectedCount } = parseLiveResults(
      payload,
      opts.mapping ?? {},
    );
    if (!records.length)
      throw new BadRequestException(
        `RaceResult returned no usable rows (${rejectedCount} rejected) — check the field mapping, especially which column holds the bib`,
      );

    const rows = await this.buildRows(eventId, records);
    const out: LivePayload = {
      event_id: eventId,
      url,
      fetched_at: new Date().toISOString(),
      source_count: records.length,
      rejected: rejectedCount,
      unmatched: rows.filter((r) => r.unmatched).length,
      rows,
    };

    await this.cache.set(this.liveKey(eventId), out, LIVE_TTL_SECONDS);
    await this.cache.invalidateEvent(eventId);
    this.logger.log(
      `Live results for ${eventId}: ${rows.length} rows, ${out.unmatched} unmatched, ${rejectedCount} rejected`,
    );
    return out;
  }

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
          `RaceResult results endpoint returned HTTP ${res.status}`,
        );
      return await res.json();
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(
        (err as Error)?.name === 'AbortError'
          ? `RaceResult results request timed out after ${FETCH_TIMEOUT_MS / 1000}s`
          : (err as Error).message,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  // ────────────────────────────────────────────────────── shaping the rows

  private async buildRows(
    eventId: string,
    records: LiveResultRecord[],
  ): Promise<LiveRow[]> {
    const { rows: ev } = await this.db.q(
      'SELECT event_date FROM events WHERE id = $1',
      [eventId],
    );
    if (!ev[0]) throw new BadRequestException('Event not found');

    const { rows: roster } = await this.db.q<RosterEntry>(
      `SELECT ce.id AS entry_id, r.id AS registration_id, ce.bib, ce.club,
              c.name AS category,
              COALESCE(c.team_size_min, 1) AS team_size_min,
              COALESCE(c.team_size_max, 1) AS team_size_max,
              a.full_name, a.gender, a.city, a.dob
         FROM category_entries ce
         JOIN registrations r ON r.id = ce.registration_id
         JOIN athletes a ON a.id = r.athlete_id
         LEFT JOIN categories c ON c.id = ce.category_id
        WHERE ce.event_id = $1`,
      [eventId],
    );
    const byBib = new Map<string, RosterEntry>();
    for (const entry of roster)
      if (!byBib.has(entry.bib)) byBib.set(entry.bib, entry);

    // The roster is what decides an entry's category, gender and club — the feed
    // only decides its time and status. A RaceResult export can carry a stale
    // contest name from before an athlete was moved, and taking it would place
    // them in a contest the organiser no longer has them in.
    const rows: LiveRow[] = records.map((rec) => {
      const entry = byBib.get(rec.bib);
      return {
        entry_id: entry?.entry_id ?? null,
        registration_id: entry?.registration_id ?? null,
        bib: rec.bib,
        status: rec.status,
        category: entry?.category ?? rec.category,
        full_name: entry?.full_name ?? rec.full_name,
        gender: entry?.gender ?? rec.gender,
        city: entry?.city ?? null,
        total_ms: rec.total_ms,
        overall_rank: rec.rank,
        gender_rank: null,
        age_group: entry
          ? computeAgeGroup(entry.dob, ev[0].event_date, entry.category ?? '')
          : null,
        age_group_rank: null,
        field_size: null,
        team_name: null,
        team_total_ms: null,
        team_rank: null,
        team_members: null,
        ...(entry ? {} : { unmatched: true as const }),
      };
    });

    this.applyRanks(rows);
    this.applyTeams(rows, byBib);
    return rows;
  }

  /* Placings, bucketed exactly as `computeResults` buckets them: by category,
   * then by category+gender, then by category+gender+age group. Never across
   * the whole field — that was the bug 054 fixed, where a doubles pair's time
   * was ranked against solo finishers.
   *
   * `overall_rank` keeps whatever the feed supplied if it supplied one: an
   * operator uploading an official RaceResult export expects RaceResult's
   * placings, not ours recomputed off the same times. It is only computed for
   * feeds that carry times and no rank column.
   */
  private applyRanks(rows: LiveRow[]) {
    const bucket = <K>(key: (r: LiveRow) => K | null) => {
      const out = new Map<K, LiveRow[]>();
      for (const r of rows) {
        // A DNS/DQ entry is not in the contest for ranking purposes, and a row
        // with no time cannot be placed.
        if (r.status === 'DNS' || r.status === 'DQ' || r.total_ms === null)
          continue;
        const k = key(r);
        if (k === null) continue;
        const list = out.get(k);
        if (list) list.push(r);
        else out.set(k, [r]);
      }
      return out;
    };

    const time = (r: LiveRow) => r.total_ms;

    if (rows.some((r) => r.overall_rank === null)) {
      for (const list of bucket((r) => r.category).values())
        rankBy(list, time, (r, rank) => {
          if (r.overall_rank === null) r.overall_rank = rank;
        });
    }
    for (const list of bucket((r) =>
      r.category ? `${r.category}|${r.gender ?? 'other'}` : null,
    ).values())
      rankBy(list, time, (r, rank) => (r.gender_rank = rank));

    for (const list of bucket((r) =>
      r.category
        ? `${r.category}|${r.gender ?? 'other'}|${r.age_group ?? 'OPEN'}`
        : null,
    ).values())
      rankBy(list, time, (r, rank) => (r.age_group_rank = rank));

    // The denominator a placing needs to mean anything. Counted over everyone
    // in the contest, finished or not — "3rd of 24" is 24 starters, and a field
    // that shrank as the race went on would make an athlete's own placing look
    // like it was improving while they stood still.
    const sizes = new Map<string, number>();
    for (const r of rows)
      if (r.category) sizes.set(r.category, (sizes.get(r.category) ?? 0) + 1);
    for (const r of rows)
      r.field_size = r.category ? (sizes.get(r.category) ?? null) : null;
  }

  /* Doubles, on the same rule the scorer uses: THE TEAM IS THE CLUB (migration
   * 065). Entries sharing a club inside one group-format category, and only when
   * the group's size falls inside that category's own band — a club with one
   * entry in a doubles category is somebody whose partner never registered, and
   * five is a roster that has not said which two race together. Both score
   * individually, which is the honest answer.
   *
   * A team's time is its LATEST member's, because both partners have to be done
   * for the pair to be done, and a pair is only ranked once every member has a
   * time. Scoring a half-finished pair on its faster partner would place it
   * ahead of pairs that actually finished — mid-race, when half the field is
   * half-finished, that is not an edge case but the normal state of the feed.
   */
  private applyTeams(rows: LiveRow[], byBib: Map<string, RosterEntry>) {
    const groups = new Map<string, { rows: LiveRow[]; entry: RosterEntry }>();

    for (const r of rows) {
      const entry = byBib.get(r.bib);
      if (!entry || !r.category) continue;
      if (entry.team_size_max <= 1) continue;
      const club = clubKey(entry.club);
      if (!club) continue;

      const key = `${r.category}|${club}`;
      const group = groups.get(key);
      if (group) group.rows.push(r);
      else groups.set(key, { rows: [r], entry });
    }

    const teams: {
      key: string;
      rows: LiveRow[];
      total: number;
      category: string;
    }[] = [];

    for (const [key, { rows: members, entry }] of groups) {
      if (
        members.length < entry.team_size_min ||
        members.length > entry.team_size_max
      )
        continue;

      const name = String(entry.club ?? '').trim() || null;
      const memberList: LiveMember[] = members
        .map((m) => ({
          entry_id: m.entry_id,
          bib: m.bib,
          full_name: m.full_name,
          total_ms: m.total_ms,
          category_rank: m.overall_rank,
          status: m.status,
          is_self: false,
        }))
        .sort((a, b) => {
          if (a.total_ms === null) return 1;
          if (b.total_ms === null) return -1;
          return a.total_ms - b.total_ms;
        });

      // `team_name` doubles as the "this entry raced as a pair" flag on the
      // athlete pages, so it is set for every recognised team — including one
      // still out on course, which has a partner and a name but no time yet.
      for (const m of members) {
        m.team_name = name;
        m.team_members = memberList.map((x) => ({
          ...x,
          is_self: x.bib === m.bib,
        }));
      }

      const complete = members.every(
        (m) => m.total_ms !== null && m.status === 'FIN',
      );
      if (!complete) continue;

      const total = Math.max(...members.map((m) => m.total_ms as number));
      for (const m of members) m.team_total_ms = total;
      teams.push({
        key,
        rows: members,
        total,
        category: members[0].category as string,
      });
    }

    const byCategory = new Map<string, typeof teams>();
    for (const t of teams) {
      const list = byCategory.get(t.category);
      if (list) list.push(t);
      else byCategory.set(t.category, [t]);
    }
    for (const list of byCategory.values())
      rankBy(
        list,
        (t) => t.total,
        (t, rank) => {
          for (const m of t.rows) m.team_rank = rank;
        },
      );
  }

  // ──────────────────────────────────────────────────────────── publishing

  /* Write the cached feed into the database. The ONLY method here that does.
   *
   * Called by the publish action, in the same transaction shape `computeResults`
   * uses: clear this event's results, then insert. An unmatched row is skipped —
   * it has no `entry_id` to hang a result on — and counted back to the operator,
   * because publishing a feed where a tenth of the bibs did not resolve is
   * something they need to be told before the athletes find out.
   */
  async persist(
    eventId: string,
  ): Promise<{ persisted: number; skipped: number } | null> {
    const payload = await this.read(eventId);
    if (!payload?.rows?.length) return null;

    const result = await this.db.tx(async (client) => {
      await client.query(
        `DELETE FROM results WHERE entry_id IN (
           SELECT ce.id FROM category_entries ce WHERE ce.event_id = $1
         )`,
        [eventId],
      );

      let persisted = 0;
      let skipped = 0;
      for (const row of payload.rows) {
        if (!row.entry_id) {
          skipped++;
          continue;
        }

        // The status travels with the result. It is what the feed said about
        // this athlete, and leaving `race_status` at 'REG' while publishing a
        // finish time would contradict it on every page that reads one.
        await client.query(
          `UPDATE category_entries SET race_status = $2, updated_at = now() WHERE id = $1`,
          [row.entry_id, row.status],
        );

        // Only a row with a time is a result. The rest are entries that did not
        // finish, and their race_status above is the whole story.
        if (row.total_ms === null) continue;

        await client.query(
          `INSERT INTO results (entry_id, total_ms, overall_rank, gender_rank,
                                age_group, age_group_rank, team_total_ms, team_rank)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            row.entry_id,
            row.total_ms,
            row.overall_rank,
            row.gender_rank,
            row.age_group,
            row.age_group_rank,
            row.team_total_ms,
            row.team_rank,
          ],
        );
        persisted++;
      }
      return { persisted, skipped };
    });

    // Published means these numbers are now IN the database, so the cached copy
    // has stopped being the source of truth and the switch has nothing left to
    // serve. Leaving either in place would let a stale feed shadow the published
    // results the moment somebody flipped the toggle back on.
    await this.db.q(
      'UPDATE events SET live_results_enabled = false WHERE id = $1',
      [eventId],
    );
    await this.clear(eventId);
    return result;
  }
}
