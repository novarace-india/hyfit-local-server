/* The doubles half of a result row.
 *
 * Lives here rather than on a controller because SIX read paths need it —
 * leaderboard, event results, scorecard, /me/registrations/:regId, /me/events
 * and the athlete's own event results — and every one of them must show a pair
 * BOTH results they own: the team's placing and each member's own leg. Three
 * separate passes were needed to get that right the first time, because each
 * copy of this block hid one of the two. A seventh copy is how that happens
 * again, so there is one.
 *
 * THE TEAM IS THE CLUB (migration 065). There is no teams table: a team is the
 * entries sharing a club inside one category, and only in a category that races
 * in groups. Three conditions decide it, and all three are load-bearing —
 *
 *   team_size_max > 1   a singles category has no teams. Without this, fifty
 *                       solo athletes from one gym become a fifty-person team.
 *   club_key <> ''      a blank club is not an affiliation, so it cannot group
 *                       anyone. Otherwise every entry with no club joins one
 *                       enormous nameless team.
 *   size within band    a club with one entry is somebody whose partner never
 *                       registered; a club with five in a doubles category is a
 *                       roster that has not said which two race together.
 *                       Neither is a team, and both score individually.
 *
 * `club_key()` is the database's copy of the normalisation the judge apps have
 * always applied. Keep it as the only spelling of it here — an inlined
 * `lower(trim(...))` would drift.
 *
 * CONTRACT: pass the aliases the host query uses for `category_entries` and
 * `results`. Scalar subqueries rather than joins, so this can be dropped into a
 * query that already GROUP BYs without touching its grouping list.
 *
 * `team_rank` is the placing that counts for a pair — `overall_rank` is that
 * partner's own placing in the category, which for a team is a detail, not the
 * result. `team_members` is who they raced with; without it a doubles result
 * reads as an individual one.
 *
 * `team_name` is the club, and it is NULL for anyone not actually in a team, so
 * it doubles as the "is this a pair" flag that `team_id` used to be. Callers
 * test it rather than counting members.
 */
/* The membership test, and the only copy of it.
 *
 * Every team column below is built on this, so they cannot disagree about who
 * is on the team — which is the failure mode the whole change is about.
 * Expects `categories` in scope as `mc`. `category_id` already scopes to one
 * event — categories belong to events — so there is no event_id term.
 */
function inTeam(entry: string) {
  return `mc.team_size_max > 1
                   AND club_key(${entry}.club) <> ''
                   AND (SELECT count(*) FROM category_entries pe
                         WHERE pe.category_id = ${entry}.category_id
                           AND club_key(pe.club) = club_key(${entry}.club))
                       BETWEEN mc.team_size_min AND mc.team_size_max`;
}

/* The club, but only when it names a team — NULL otherwise, so it is also the
 * "is this entry in a pair" flag. Usable on its own by queries that have no
 * results row to join, such as the admin roster.
 */
export function teamNameColumn(entry = 'ce') {
  return `(SELECT btrim(${entry}.club) FROM categories mc
                WHERE mc.id = ${entry}.category_id AND ${inTeam(entry)}) AS team_name`;
}

/* The other members, as one readable string. `withBib` appends each bib, which
 * the admin console wants and the athlete-facing pages do not.
 */
export function teammatesColumn(
  entry = 'ce',
  { withBib = false, as = 'teammates' } = {},
) {
  const name = withBib
    ? `ma.full_name || ' (' || me.bib || ')'`
    : `ma.full_name`;
  return `(SELECT string_agg(${name}, ', ' ORDER BY me.bib)
                 FROM category_entries me
                 JOIN registrations mr ON mr.id = me.registration_id
                 JOIN athletes ma ON ma.id = mr.athlete_id
                 JOIN categories mc ON mc.id = me.category_id
                WHERE me.category_id = ${entry}.category_id
                  AND club_key(me.club) = club_key(${entry}.club)
                  AND me.id <> ${entry}.id
                  AND ${inTeam(entry)}) AS ${as}`;
}

export function teamColumns(entry = 'ce', result = 'res') {
  return `
              ${teamNameColumn(entry)},
              ${result}.team_total_ms, ${result}.team_rank,
              -- Every member of the team, each with their OWN result, and self
              -- included. A pair has two results that both belong to the pair:
              -- naming the partner without their time answers "who" but not
              -- "how did we each do", which is the question the page is for.
              -- Ordered by leg so the fastest reads first; the team's time is
              -- the last one.
              (SELECT json_agg(json_build_object(
                        'entry_id',        me.id,
                        'bib',             me.bib,
                        'full_name',       ma.full_name,
                        'total_ms',        mres.total_ms,
                        'category_rank',   mres.overall_rank,
                        'status',          me.race_status,
                        'is_self',         me.id = ${entry}.id)
                        ORDER BY mres.total_ms NULLS LAST, me.bib)
                 FROM category_entries me
                 JOIN registrations mr ON mr.id = me.registration_id
                 JOIN athletes ma ON ma.id = mr.athlete_id
                 JOIN categories mc ON mc.id = me.category_id
                 LEFT JOIN results mres ON mres.entry_id = me.id
                WHERE me.category_id = ${entry}.category_id
                  AND club_key(me.club) = club_key(${entry}.club)
                  AND ${inTeam(entry)}) AS team_members`;
}

export const TEAM_COLUMNS = teamColumns();

// Public athlete projection — the safe subset of the athletes row returned to
// clients. Ported from the module's routes/auth.js `publicAthlete`.
export function publicAthlete(a: any) {
  const {
    id,
    mobile,
    full_name,
    email,
    gender,
    dob,
    city,
    state,
    blood_group,
    tshirt_size,
    emergency_name,
    emergency_phone,
    photo_url,
    profile_complete,
  } = a;
  return {
    id,
    mobile,
    full_name,
    email,
    gender,
    dob,
    city,
    state,
    blood_group,
    tshirt_size,
    emergency_name,
    emergency_phone,
    photo_url,
    profile_complete,
  };
}
