-- ============================================================================
-- 091: the AGE BAND on the roster row, not only on the result.
--
-- RaceResult now exports an `AgeGroup` variable on the participant feed as well
-- as the results one. `hyfit_v2.results.age_group` has carried the band since
-- 087 — it is what `age_group_rank` counts within, and what the public
-- leaderboard's age filter is built from — but the athlete row had nowhere to
-- put it, so a start list imported before anybody finished knew every entry's
-- band and threw it away.
--
-- WHY IT IS WORTH STORING TWICE. It is not the same fact told twice: the result
-- carries the band the placing WAS JUDGED IN on the day, and the roster carries
-- the band the entry IS IN — which exists from the moment the start list is
-- imported, hours before the first finish, and is what check-in and the judge
-- app can show for somebody who has not raced yet. The same reasoning as 089's
-- `age`: a snapshot on the result, the current value on the athlete.
--
-- NOT a source for the leaderboard filter. That reads the RESULT's band and
-- keeps reading it — a board row showing one band while its placing was counted
-- in another is the two-places-one-fact failure this project keeps paying for.
--
-- Additive and idempotent. Nothing is backfilled: a roster imported before this
-- has no band to recover, and the next import fills it in.
-- ============================================================================

BEGIN;

ALTER TABLE hyfit_v2.athletes
  ADD COLUMN IF NOT EXISTS age_group text;

-- Blank is not a band. An export column that exists but is empty on a row says
-- nothing about that athlete, and storing '' would make "no band" and "a band
-- nobody typed" two values that every reader has to test for separately.
ALTER TABLE hyfit_v2.athletes
  DROP CONSTRAINT IF EXISTS hyfit_v2_athletes_age_group_check;

ALTER TABLE hyfit_v2.athletes
  ADD CONSTRAINT hyfit_v2_athletes_age_group_check
  CHECK (age_group IS NULL OR btrim(age_group) <> '');

COMMENT ON COLUMN hyfit_v2.athletes.age_group IS
  'The age band this entry is in ("Next Gen Boys 12-15"), from the feed''s AgeGroup column. NULL when the export carries no such column. The band a PLACING was judged in lives on hyfit_v2.results.age_group and is what the public age filter reads.';

COMMIT;
