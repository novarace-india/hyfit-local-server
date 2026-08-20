-- ============================================================================
-- 089: the athlete's AGE, on the result rather than only on the athlete.
--
-- WHY NOT JUST READ hyfit_v2.athletes.age. Because that column is the person's
-- age NOW, and this one is their age WHEN THEY RACED. The results importer
-- already upserts the athlete on every pull (see upsertAthlete: `age =
-- COALESCE(excluded.age, athletes.age)`), so the same person coming back next
-- season overwrites it — and every result they ever posted would silently
-- re-age with them. A fourteen-year-old's NextGen Boys win would read as a
-- fifteen-year-old's a year later, in the same band it was won in.
--
-- A result is a snapshot of one day. `age_group` went onto this table in 087
-- for exactly this reason, and the age the band was judged against belongs
-- beside it: "Next Gen Boys 12-15 · age 14" is a checkable statement, and
-- "Next Gen Boys 12-15" next to whatever age the athlete happens to be today
-- is not.
--
-- The feed carries it plainly:
--
--     "Age": 14,  "Category": "Next Gen Boys 12-15",  "AgeGroupRank": 1
--
-- and the importer has parsed it since 083 — it went to the athlete row and
-- nowhere else, so no results screen could show it.
--
-- Additive and idempotent. Nothing is backfilled: an event imported before this
-- has NULLs, which read as "not published", and re-importing its feed fills
-- them. NULL is also the honest value for an export with no Age column at all.
--
-- APPLY TO BOTH DATABASES, like 086 and 087, and for 087's reason: an offline
-- venue's local server pushes this column to prod, and a column missing on the
-- receiving side turns the whole push into an error at the INSERT.
--
--   node scripts/run-sql.mjs sql/089_hyfit_v2_results_age.sql
-- ============================================================================

BEGIN;

SET search_path TO hyfit_v2, public;

DO $$
BEGIN
  IF to_regclass('hyfit_v2.results') IS NULL THEN
    RAISE EXCEPTION 'hyfit_v2.results does not exist — run 083 first';
  END IF;
END $$;

ALTER TABLE hyfit_v2.results
  ADD COLUMN IF NOT EXISTS age integer;

-- Zero is how an export spells "no age given" — the same way it spells "no team"
-- in TeamRank — and it must land as NULL rather than as an age of nought. The
-- upper bound is not a guess about athletes; it is a guard against a column that
-- turns out to hold a year of birth, which is the one wrong reading of an "Age"
-- column that would otherwise store cleanly and print as nonsense.
ALTER TABLE hyfit_v2.results
  DROP CONSTRAINT IF EXISTS hyfit_v2_results_age_check;
ALTER TABLE hyfit_v2.results
  ADD CONSTRAINT hyfit_v2_results_age_check
  CHECK (age IS NULL OR (age > 0 AND age < 130));

COMMENT ON COLUMN hyfit_v2.results.age IS
  'The athlete''s age ON RACE DAY, from the export''s Age column — the age age_group was judged against. Deliberately not read from hyfit_v2.athletes.age, which every later import overwrites.';

COMMIT;
