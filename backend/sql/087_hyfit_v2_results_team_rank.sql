-- ============================================================================
-- 087: the two things a newer RaceResult export says that this table could not
--      hold — the team's PLACING, and the name of the age group.
--
-- WHY. 083 built `results` against an export whose contest column was called
-- `Category` and which carried a team TIME but no team rank. The export the
-- 2026 events produce carries both of these as well:
--
--     "Contest":      "NextGen Boys"          the race an entry is in
--     "Category":     "Next Gen Boys 12-15"   the band it is placed within
--     "AgeGroupRank": 1                        …its placing in that band
--     "TeamRank":     1                        the pair's placing
--     "TeamTime":     "12:21"
--
-- Both gaps were silent, and both are the doubles/age-group half of a result:
--
--   * `age_group_rank` was stored with nothing naming the group it counts
--     within, so the public page could only say "Age group placing #1" — true
--     of one athlete per band, printed identically for all of them.
--   * a pair got a team time and no team placing, so a doubles entry showed
--     "Team 12:21" and could not say it won.
--
-- Neither is derivable from what is already stored: the band is a decision the
-- organiser made in RaceResult, and a team placing depends on the pairs, which
-- this schema deliberately does not model (a team IS the club).
--
-- Additive and idempotent. Nothing is backfilled — an event imported before
-- this migration simply has NULLs, which read exactly as they did before, and
-- re-importing that event's feed fills them.
--
-- APPLIED TO BOTH DATABASES, like 086: an offline venue's local server pushes
-- these columns to prod, and a column missing on either side turns the whole
-- push into an error at the receiving INSERT.
--
--   node scripts/run-sql.mjs sql/087_hyfit_v2_results_team_rank.sql
-- ============================================================================

BEGIN;

SET search_path TO hyfit_v2, public;

ALTER TABLE hyfit_v2.results
  ADD COLUMN IF NOT EXISTS team_rank integer,
  ADD COLUMN IF NOT EXISTS age_group text,
  -- Every OTHER time the row carried, under the feed's own column names.
  --
  -- The circuit has thirteen typed columns and this export has more than
  -- thirteen times in it — `HyZone` on every row, `COGRecall` on some — and the
  -- next event will invent another. A column per invention is not a schema, and
  -- dropping them made the legs fail to add up to the total with nothing on the
  -- page to say why: bib 1105's thirteen legs come to 7:21 against 11:35.
  --
  -- A map for the same reason `penalties` is one, and UNPARSED for a reason of
  -- its own: nothing here knows what HyZone measures (it is not additive — one
  -- row's legs plus its HyZone exceed its total), so the strings are published
  -- as the organiser wrote them rather than placed in a circuit they may not
  -- belong to.
  ADD COLUMN IF NOT EXISTS extra_times jsonb NOT NULL DEFAULT '{}'::jsonb;

-- A placing is 1-based. Zero is how the feed spells "not in a team" (the same
-- row writes "00:00" in TeamTime), and it must land as NULL rather than as a
-- rank that would sort ahead of the winner.
ALTER TABLE hyfit_v2.results
  DROP CONSTRAINT IF EXISTS hyfit_v2_results_team_rank_check;
ALTER TABLE hyfit_v2.results
  ADD CONSTRAINT hyfit_v2_results_team_rank_check
  CHECK (team_rank IS NULL OR team_rank > 0);

-- An empty string is not an age group; it is a column the export left blank,
-- and storing it would put "· #1" next to nothing on the public page.
ALTER TABLE hyfit_v2.results
  DROP CONSTRAINT IF EXISTS hyfit_v2_results_age_group_check;
ALTER TABLE hyfit_v2.results
  ADD CONSTRAINT hyfit_v2_results_age_group_check
  CHECK (age_group IS NULL OR btrim(age_group) <> '');

COMMENT ON COLUMN hyfit_v2.results.team_rank IS
  'The pair''s placing as RaceResult computed it (TeamRank). NULL for a solo entry — the same rows that have no team_time_ms.';
COMMENT ON COLUMN hyfit_v2.results.age_group IS
  'The band age_group_rank counts within ("Next Gen Boys 12-15"), from the export''s Category column when it names something narrower than the contest. NULL when the export carries no such column.';

COMMIT;
