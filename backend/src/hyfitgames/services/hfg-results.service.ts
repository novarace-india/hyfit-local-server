import { Injectable } from '@nestjs/common';
import { HfgDbService } from '../hfg-db.service';

/* ── Age group computation per contest category ───────────────────────────
 * Maps athlete age at event date into the correct bucket for their
 * registration category. Returns the age-group label stored in results.
 */
const CONTEST_AGE_GROUPS: Record<string, string[]> = {
  'NextGen Boys': ['8-9', '10-11', '12-13', '14-15'],
  'NextGen Girls': ['8-9', '10-11', '12-13', '14-15'],
  'Grand Masters Male': ['55-64', '65-74', '75-84'],
  'Grand Masters Female': ['55-64', '65-74', '75-84'],
  'Male Open': ['16-24', '25-34', '35-44', '45-54', '55-64', '65-74', '75-84'],
  'Female Open': [
    '16-24',
    '25-34',
    '35-44',
    '45-54',
    '55-64',
    '65-74',
    '75-84',
  ],
  'Male Pro': ['16-24', '25-34', '35-44', '45-54', '55-64', '65-74', '75-84'],
  'Female Pro': ['16-24', '25-34', '35-44', '45-54', '55-64', '65-74', '75-84'],
  'Male Doubles': [
    '16-24',
    '25-34',
    '35-44',
    '45-54',
    '55-64',
    '65-74',
    '75-84',
  ],
  'Female Doubles': [
    '16-24',
    '25-34',
    '35-44',
    '45-54',
    '55-64',
    '65-74',
    '75-84',
  ],
  'Mixed Doubles': [
    '16-24',
    '25-34',
    '35-44',
    '45-54',
    '55-64',
    '65-74',
    '75-84',
  ],
  'Bloodline Doubles': ['Parent-Child'],
};

function parseAgeGroup(label: string): [number, number] {
  if (label === 'Parent-Child') return [0, 999];
  const [lo, hi] = label.split('-').map(Number);
  return [lo, hi];
}

export function computeAgeGroup(
  dob: string | Date | null | undefined,
  eventDate: string | Date,
  category: string,
): string {
  if (!dob) return 'OPEN';
  const d = new Date(dob),
    e = new Date(eventDate);
  let age = e.getFullYear() - d.getFullYear();
  if (e < new Date(e.getFullYear(), d.getMonth(), d.getDate())) age--;

  const groups = CONTEST_AGE_GROUPS[category];
  if (!groups) return 'OPEN';

  for (const g of groups) {
    const [lo, hi] = parseAgeGroup(g);
    if (age >= lo && age <= hi) return g;
  }
  // age outside all buckets → oldest bucket
  return groups[groups.length - 1];
}

/* Legacy compatibility */
export function ageGroup(
  dob: string | Date | null | undefined,
  eventDate: string | Date,
): string {
  return computeAgeGroup(dob, eventDate, 'Male Open');
}

interface EntryRow {
  id: string;
  race_status: string;
  category: string;
  category_id: string;
  category_name: string;
  gender: string | null;
  dob: string | null;
  club: string | null;
  team_size_min: number;
  team_size_max: number;
  done: number;
  total_ms: number;
  age_group?: string;
}

/* The club, normalised into a team key.
 *
 * Must stay identical to `hyfit.club_key()` (migration 065) and to
 * `normalizedTeamClub()` in the judge apps: those three decide who is on a team
 * at scoring time, at check-in and on the tablet, and a pair that is a pair to
 * one of them and not the others is exactly the bug 065 removed.
 *
 * Exported for the live-results path, which groups the same pairs off a
 * RaceResult feed. It imports this rather than keeping its own copy for exactly
 * the reason above — a fourth spelling of "same club" is a fourth chance to
 * disagree about who is a team.
 */
export function clubKey(club: string | null | undefined): string {
  return String(club ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Recompute results for an event.
 * - total_ms = sum of splits, only for athletes who completed ALL stations
 * - athletes with all splits are auto-promoted REG -> FIN
 * - RANK() semantics: ties share a rank, next rank skips (1,1,3)
 * - Every ranking is scoped to the category. `overall_rank` is the placing
 *   inside the entry's own contest — NOT across the event. It used to be a
 *   single pool, which put a doubles pair's time up against solo finishers;
 *   two people covering a course are not racing one person covering it.
 * - Doubles score as teams, and a team is a club: the entries sharing a club
 *   inside one group-format category. A team's time is its LATEST member's
 *   finish, and it is only ranked once every member has finished. An entry with
 *   no club, or the only one from its club, is scored individually.
 * Safe to run repeatedly (scoring corrections, protest resolutions).
 */
@Injectable()
export class HfgResultsService {
  constructor(private readonly db: HfgDbService) {}

  async computeResults(
    eventId: string,
  ): Promise<{ finishers: number; of: number }> {
    return this.db.tx(async (client) => {
      const { rows: ev } = await client.query(
        'SELECT * FROM events WHERE id = $1',
        [eventId],
      );
      if (!ev[0]) throw new Error('event not found');
      const { rows: stationCount } = await client.query(
        'SELECT count(*)::int AS n FROM stations WHERE event_id = $1',
        [eventId],
      );
      const need = stationCount[0].n;

      const { rows: entries } = await client.query<EntryRow>(
        `SELECT ce.id, ce.race_status, ce.club, ce.category_id,
                c.name AS category_name, c.format AS category,
                c.team_size_min, c.team_size_max,
                a.gender, a.dob,
                count(s.id)::int AS done, COALESCE(sum(s.split_ms),0)::int AS total_ms
           FROM category_entries ce
           JOIN registrations r ON r.id = ce.registration_id
           JOIN athletes a ON a.id = r.athlete_id
           JOIN categories c ON c.id = ce.category_id
           LEFT JOIN splits s ON s.entry_id = ce.id
          WHERE ce.event_id = $1
          GROUP BY ce.id, ce.race_status, ce.club, ce.category_id, c.name, c.format,
                   c.team_size_min, c.team_size_max, a.gender, a.dob`,
        [eventId],
      );

      // promote finishers; leave DNS/DNF/DQ set by admins untouched
      for (const e of entries) {
        if (e.done === need && need > 0 && e.race_status === 'REG')
          await client.query(
            `UPDATE category_entries SET race_status = 'FIN', updated_at = now() WHERE id = $1`,
            [e.id],
          );
      }

      await client.query(
        `DELETE FROM results WHERE entry_id IN (
           SELECT ce.id FROM category_entries ce
           JOIN registrations r ON r.id = ce.registration_id
           WHERE r.event_id = $1
         )`,
        [eventId],
      );

      const finishers = entries
        .filter(
          (e) =>
            e.done === need &&
            need > 0 &&
            e.race_status !== 'DQ' &&
            e.race_status !== 'DNS',
        )
        .map((e) => ({
          ...e,
          age_group: computeAgeGroup(e.dob, ev[0].event_date, e.category_name),
        }))
        .sort((a, b) => a.total_ms - b.total_ms);

      const rank = (list: EntryRow[]): Map<string, number> => {
        const out = new Map<string, number>();
        let prev: number | null = null,
          prevRank = 0;
        list.forEach((e, i) => {
          const rk = e.total_ms === prev ? prevRank : i + 1;
          out.set(e.id, rk);
          prev = e.total_ms;
          prevRank = rk;
        });
        return out;
      };

      // Every ranking is bucketed before ranking, so a placing is only ever
      // computed against comparable entries. `overall_rank` is bucketed by
      // category alone — that is the fix: it used to rank the whole field.
      const byCategory: Record<string, EntryRow[]> = {},
        byGenderCat: Record<string, EntryRow[]> = {},
        byAge: Record<string, EntryRow[]> = {};
      for (const e of finishers) {
        (byCategory[e.category_name] ||= []).push(e);
        (byGenderCat[`${e.category_name}|${e.gender || 'other'}`] ||= []).push(
          e,
        );
        (byAge[`${e.category_name}|${e.gender || 'other'}|${e.age_group}`] ||=
          []).push(e);
      }
      const categoryRanks = new Map<string, number>(),
        genderRanks = new Map<string, number>(),
        ageRanks = new Map<string, number>();
      const collect = (
        buckets: Record<string, EntryRow[]>,
        into: Map<string, number>,
      ) =>
        Object.values(buckets).forEach((l) =>
          rank(l).forEach((v, k) => into.set(k, v)),
        );
      collect(byCategory, categoryRanks);
      collect(byGenderCat, genderRanks);
      collect(byAge, ageRanks);

      /* ── Teams ────────────────────────────────────────────────────────────
       * A doubles pair races as one entry. Its time is the LATEST member's
       * finish: both partners have to be done for the team to be done, so the
       * team crosses when the second one does.
       *
       * THE TEAM IS THE CLUB (migration 065). There is no teams table and no
       * team_id: a team is the set of entries sharing a club inside ONE
       * category, and only in a category that races in groups. The
       * `team_size_max > 1` test is what keeps fifty solo athletes from one gym
       * out of a fifty-person team — it is load-bearing, not defensive.
       *
       * A team is only ranked when every expected member has finished. That
       * matters for correctness, not tidiness — scoring a half-finished pair
       * on its faster partner's time would place it ahead of teams that
       * actually completed. Same reason DNF propagates: if one partner does
       * not finish, the team has no time.
       *
       * Ranked within category, like everything else.
       */
      const finisherIds = new Set(finishers.map((e) => e.id));
      const membersByTeam = new Map<string, EntryRow[]>();
      const teamKey = (e: EntryRow) =>
        e.team_size_max > 1 && clubKey(e.club)
          ? `${e.category_name} ${clubKey(e.club)}`
          : null;
      for (const e of entries) {
        const key = teamKey(e);
        if (!key) continue;
        const members = membersByTeam.get(key);
        if (members) members.push(e);
        else membersByTeam.set(key, [e]);
      }

      const teamTotals = new Map<string, number>();
      const teamCategory = new Map<string, string>();
      for (const [key, members] of membersByTeam) {
        const { team_size_min: min, team_size_max: max } = members[0];
        // Outside the category's own size band the group is not a team: one
        // entry from a club is somebody whose partner never registered, and
        // five sharing a club in a doubles category is a roster that has not
        // said which two race together. Both score individually, which is the
        // honest answer — inventing a pairing here would hand out a placing
        // nobody raced for.
        if (members.length < min || members.length > max) continue;
        // Carried over from the pairing endpoint 065 deleted, which refused a
        // mixed_doubles pair that was one gender. That rule has to live here
        // now, or a roster where two men share a club in Mixed Doubles gets a
        // published Mixed Doubles placing — a wrong result, not a tidiness
        // problem. They score individually instead, like any other entry whose
        // partner is not recorded.
        if (
          members[0].category === 'mixed_doubles' &&
          new Set(members.map((m) => m.gender).filter(Boolean)).size < 2
        )
          continue;
        if (!members.every((m) => finisherIds.has(m.id))) continue;
        teamTotals.set(key, Math.max(...members.map((m) => m.total_ms)));
        teamCategory.set(key, members[0].category_name);
      }

      // Rank the teams inside their category, reusing the same tie semantics.
      const teamRanks = new Map<string, number>();
      const teamsByCategory: Record<string, EntryRow[]> = {};
      for (const [key, total] of teamTotals) {
        // `rank()` keys off `id`/`total_ms`, so a team stands in as a row.
        (teamsByCategory[teamCategory.get(key)!] ||= []).push({
          id: key,
          total_ms: total,
        } as EntryRow);
      }
      collect(teamsByCategory, teamRanks);

      for (const e of finishers) {
        const key = teamKey(e);
        await client.query(
          `INSERT INTO results (entry_id, total_ms, overall_rank, gender_rank, age_group, age_group_rank,
                                team_total_ms, team_rank)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            e.id,
            e.total_ms,
            categoryRanks.get(e.id),
            genderRanks.get(e.id),
            e.age_group,
            ageRanks.get(e.id),
            key ? (teamTotals.get(key) ?? null) : null,
            key ? (teamRanks.get(key) ?? null) : null,
          ],
        );
      }
      return { finishers: finishers.length, of: entries.length };
    });
  }
}
