-- ============================================================================
-- 085: one table again. `athlete_events_map` is gone, and an athlete row IS an
-- entry, keyed by PHONE + NAME + CATEGORY within an event.
--
-- 084 split the roster into a person and an entry. This reverses that split at
-- the organiser's instruction: one table, one row per athlete per category per
-- event, and no join to read a start list.
--
-- WHAT THE KEY MEANS. `UNIQUE (event_id, phone, name, category)`, all four
-- normalised through the key functions from 084:
--
--   * the same person in two categories at one event  -> two rows, two results
--   * the same person at two editions                 -> two rows, one per event
--   * the same person re-imported                     -> the same row, updated
--
-- Scoped by event because a global (phone, name, category) key would make one
-- athlete's Male Open at Bengaluru and their Male Open at Chennai the same row,
-- with whichever import ran last deciding which event it belonged to. The
-- earlier event would lose them from its roster and the athlete would lose the
-- race from their history.
--
-- THE BIB IS NO LONGER PART OF THE KEY. It is what RaceResult labels a row
-- with, and it changes between exports; the person does not. Two feed rows with
-- one phone, one name and one category are one entry however their bibs differ,
-- and the later one wins the column.
--
-- SOMEBODY WITH NO PHONE still gets a row — the key just falls back to
-- (event_id, '', name, category), so two unnamed-number athletes with the same
-- name in the same contest merge. That is the cost of the flat key and it is
-- accepted: they cannot log in either way, since login is by number.
--
-- Idempotent; safe to re-run. Requires 083 and 084.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. The entry columns come back onto `athletes`
-- ============================================================================

ALTER TABLE hyfit_v2.athletes
  ADD COLUMN IF NOT EXISTS event_id     uuid REFERENCES hyfit_v2.events (id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS bib          text,
  ADD COLUMN IF NOT EXISTS category     text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS club         text,
  ADD COLUMN IF NOT EXISTS contest_id   text,
  ADD COLUMN IF NOT EXISTS wave         text,
  ADD COLUMN IF NOT EXISTS timeslot     text,
  ADD COLUMN IF NOT EXISTS contest_date date,
  ADD COLUMN IF NOT EXISTS age          integer,
  ADD COLUMN IF NOT EXISTS source_id    text;

-- ============================================================================
-- 2. Fold every entry back into a row
-- ============================================================================

-- A person with N entries becomes N rows. The FIRST entry updates the person
-- row that already exists (so its id survives, and any result pointing at it);
-- the rest are inserted as new rows carrying the same profile.
DO $$
DECLARE has_map boolean;
BEGIN
  SELECT to_regclass('hyfit_v2.athlete_events_map') IS NOT NULL INTO has_map;
  IF NOT has_map THEN RETURN; END IF;

  -- 2a. The kept entry per person: the earliest, so the choice is stable across
  -- re-runs rather than depending on what the planner returns first.
  CREATE TEMP TABLE hyfit_v2_fold ON COMMIT DROP AS
    SELECT m.*,
           row_number() OVER (PARTITION BY m.athlete_id ORDER BY m.created_at, m.id) AS rn
      FROM hyfit_v2.athlete_events_map m;

  UPDATE hyfit_v2.athletes a
     SET event_id = f.event_id, bib = f.bib, category = f.category,
         club = f.club, contest_id = f.contest_id, wave = f.wave,
         timeslot = f.timeslot, contest_date = f.contest_date, age = f.age,
         source_id = f.source_id
    FROM hyfit_v2_fold f
   WHERE f.athlete_id = a.id AND f.rn = 1;

  -- 2b. Their other entries become rows of their own, profile copied across.
  INSERT INTO hyfit_v2.athletes (
    name, mobile, gender, date_of_birth, email, city, is_active, source, raw,
    event_id, bib, category, club, contest_id, wave, timeslot, contest_date,
    age, source_id, created_at)
  SELECT a.name, a.mobile, a.gender, a.date_of_birth, a.email, a.city,
         a.is_active, a.source, a.raw,
         f.event_id, f.bib, f.category, f.club, f.contest_id, f.wave,
         f.timeslot, f.contest_date, f.age, f.source_id, f.created_at
    FROM hyfit_v2_fold f
    JOIN hyfit_v2.athletes a ON a.id = f.athlete_id
   WHERE f.rn > 1;

  -- 2c. A person with no entries at all has nothing to be a row of.
  DELETE FROM hyfit_v2.athletes a
   WHERE NOT EXISTS (SELECT 1 FROM hyfit_v2.athlete_events_map m WHERE m.athlete_id = a.id);
END $$;

-- ============================================================================
-- 3. Results point at the athlete row
-- ============================================================================

ALTER TABLE hyfit_v2.results
  ADD COLUMN IF NOT EXISTS athlete_id uuid REFERENCES hyfit_v2.athletes (id) ON DELETE CASCADE;

-- Re-pointed through the map while it still exists: entry -> its athlete, then
-- the athlete row that now carries that entry's event and category.
DO $$
BEGIN
  IF to_regclass('hyfit_v2.athlete_events_map') IS NULL THEN RETURN; END IF;

  UPDATE hyfit_v2.results r
     SET athlete_id = a.id
    FROM hyfit_v2.athlete_events_map m
    JOIN hyfit_v2.athletes a
      ON a.event_id = m.event_id
     AND hyfit_v2.contest_key(a.category) = hyfit_v2.contest_key(m.category)
     AND hyfit_v2.name_key(a.name) = hyfit_v2.name_key(
           (SELECT x.name FROM hyfit_v2.athletes x WHERE x.id = m.athlete_id))
   WHERE r.athlete_id IS NULL AND r.entry_id = m.id;
END $$;

-- A result nothing can be attributed to is deleted rather than orphaned. Unlike
-- 084's equivalent this does NOT abort: results are re-importable from
-- RaceResult in one click, and a migration that cannot finish because of a row
-- that can be rebuilt is worse than the row.
DELETE FROM hyfit_v2.results WHERE athlete_id IS NULL;

ALTER TABLE hyfit_v2.results ALTER COLUMN athlete_id SET NOT NULL;
ALTER TABLE hyfit_v2.results DROP CONSTRAINT IF EXISTS hyfit_v2_results_entry;
ALTER TABLE hyfit_v2.results DROP COLUMN IF EXISTS entry_id;

DO $$
BEGIN
  ALTER TABLE hyfit_v2.results
    ADD CONSTRAINT hyfit_v2_results_athlete UNIQUE (athlete_id);
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

-- ============================================================================
-- 4. The map table goes
-- ============================================================================

DROP TABLE IF EXISTS hyfit_v2.athlete_events_map;

-- ============================================================================
-- 5. The key
-- ============================================================================

-- `identity_key` and its trigger were 084's answer to "who is this person", and
-- the unique index below is now that answer. Two mechanisms for one fact is the
-- thing this codebase keeps getting bitten by, so the older one goes.
DROP TRIGGER IF EXISTS hyfit_v2_athletes_identity ON hyfit_v2.athletes;
DROP FUNCTION IF EXISTS hyfit_v2.athletes_set_identity();
DROP INDEX IF EXISTS hyfit_v2.hyfit_v2_athletes_identity;
ALTER TABLE hyfit_v2.athletes DROP COLUMN IF EXISTS identity_key;

-- An athlete row must belong to an event now — it is an entry.
UPDATE hyfit_v2.athletes SET category = '' WHERE category IS NULL;
DELETE FROM hyfit_v2.athletes WHERE event_id IS NULL;
ALTER TABLE hyfit_v2.athletes
  ALTER COLUMN event_id SET NOT NULL,
  ALTER COLUMN category SET DEFAULT '',
  ALTER COLUMN category SET NOT NULL;

-- PHONE + NAME + CATEGORY, within the event. Normalised through the same three
-- functions every reader and writer uses, so "+91 90000 00131" / "9000000131"
-- and "Male Open" / "MALE  open" are one athlete, not four.
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_v2_athletes_entry
  ON hyfit_v2.athletes (
    event_id,
    hyfit_v2.mobile_key(mobile),
    hyfit_v2.name_key(name),
    hyfit_v2.contest_key(category));

CREATE INDEX IF NOT EXISTS hyfit_v2_athletes_event_idx
  ON hyfit_v2.athletes (event_id);
CREATE INDEX IF NOT EXISTS hyfit_v2_athletes_event_bib_idx
  ON hyfit_v2.athletes (event_id, bib);
-- How login finds everybody on a number, and how an athlete's own history is
-- gathered across events.
CREATE INDEX IF NOT EXISTS hyfit_v2_athletes_person_idx
  ON hyfit_v2.athletes (hyfit_v2.mobile_key(mobile), hyfit_v2.name_key(name))
  WHERE hyfit_v2.mobile_key(mobile) <> '';

-- 084's index on mobile_key alone is a prefix of the one above, so it answers
-- nothing that index cannot and costs every write.
DROP INDEX IF EXISTS hyfit_v2.hyfit_v2_athletes_mobile_key;

COMMENT ON TABLE hyfit_v2.athletes IS
  'One athlete in one category at one event — the entry IS the row. Unique on (event_id, phone, name, category), all normalised. Their history is the rows sharing a phone and name.';

COMMIT;
