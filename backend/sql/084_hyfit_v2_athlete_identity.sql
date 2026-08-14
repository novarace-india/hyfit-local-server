-- ============================================================================
-- 084: an athlete is a PERSON, and a person enters many events.
--
-- 083 made `hyfit_v2.athletes` one row per bib per event. That is a start list,
-- not a person: the same human racing two editions was two unrelated rows, so
-- there was nothing for an athlete to log in AS and no way to show them their
-- own history. This splits it in two:
--
--   hyfit_v2.athletes            the person — the thing that logs in
--   hyfit_v2.athlete_events_map  their entry in one event — bib, category,
--                                club, timeslot
--
-- THE IDENTITY IS PHONE + NAME, as decided by the organiser. Both are
-- normalised before they are compared (`mobile_key`, `name_key` below), because
-- the same person arrives as "+91 90000 00131" one year and "9000000131" the
-- next, and as "Luca  Weber" or "luca weber". A number alone was rejected: one
-- number legitimately covers a family, and a parent entering two children would
-- collapse them into one athlete.
--
-- SOMEBODY WITH NO NUMBER STILL HAS TO EXIST. A start list can carry a bib with
-- no phone at all (6 of 1087 on the reference event). They get an `anon:<id>`
-- key, which is unique to that row and can never merge with anyone — the honest
-- answer, since nothing in the data says who they are. They simply cannot log
-- in until a number is imported for them, at which point the importer re-points
-- their entry at the real person rather than mutating the anonymous one (see
-- `resolveAthlete` in hjudge-results.service.ts).
--
-- Also here, because athlete login needs them and they were left behind in the
-- dropped `hyfit` schema: `otp_codes` and `athlete_refresh_tokens`.
--
-- APPLY 083 FIRST. This migration moves what 083 created; on a fresh 083 with
-- no rows every data step below is a no-op. Idempotent, safe to re-run.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. How two athletes are compared
-- ============================================================================

-- Digits only, last ten. Country codes are written four ways in one export
-- ("+91 90000 00131", "919000000131", "09000000131", "9000000131") and all of
-- them are the same phone. Ten digits is the national number everywhere this
-- runs; keeping more would make the same person two people depending on how the
-- organiser typed it.
CREATE OR REPLACE FUNCTION hyfit_v2.mobile_key(raw text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN length(regexp_replace(COALESCE(raw, ''), '\D', '', 'g')) >= 10
    THEN right(regexp_replace(raw, '\D', '', 'g'), 10)
    ELSE ''
  END
$$;

-- Case-folded, internal whitespace collapsed, ends trimmed. Nothing more:
-- stripping punctuation would merge "O'Brien" with "OBrien" — which is probably
-- right — but also fold initials and hyphenated surnames together in ways that
-- merge two real people, and a wrong merge is much worse than a missed one.
CREATE OR REPLACE FUNCTION hyfit_v2.name_key(raw text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(btrim(regexp_replace(COALESCE(raw, ''), '\s+', ' ', 'g')))
$$;

-- The comparable form of a CONTEST name, and the third leg of the entry key.
-- RaceResult exports the same contest as "Male Open", "MALE OPEN" and
-- "Male  Open" depending on who typed it into which screen; without this each
-- spelling would be its own contest, so one athlete's single race would become
-- three entries and three results across three pulls.
--
-- The column keeps the organiser's own spelling for display — this is the key,
-- not the value.
CREATE OR REPLACE FUNCTION hyfit_v2.contest_key(raw text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(btrim(regexp_replace(COALESCE(raw, ''), '\s+', ' ', 'g')))
$$;

COMMENT ON FUNCTION hyfit_v2.mobile_key(text) IS
  'The comparable form of a phone number: digits only, last 10. Empty when there is no usable number.';
COMMENT ON FUNCTION hyfit_v2.name_key(text) IS
  'The comparable form of a name: case-folded, whitespace collapsed.';
COMMENT ON FUNCTION hyfit_v2.contest_key(text) IS
  'The comparable form of a contest name: case-folded, whitespace collapsed. Part of the entry key; the column keeps the original spelling.';

-- ============================================================================
-- 2. The person
-- ============================================================================

-- Columns that describe a HUMAN rather than an entry. Everything event-shaped
-- (bib, category, club, wave, timeslot, contest date) moves to the map below.
ALTER TABLE hyfit_v2.athletes
  ADD COLUMN IF NOT EXISTS identity_key text,
  ADD COLUMN IF NOT EXISTS email        text,
  ADD COLUMN IF NOT EXISTS city         text,
  -- The login switch. An organiser must be able to stop an account without
  -- deleting the person their results hang off.
  ADD COLUMN IF NOT EXISTS is_active    boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

-- --------------------------------------------------------------- the trigger
-- `identity_key` is maintained here rather than by the application because
-- every writer must agree on it — the roster importer, the results importer and
-- any future admin edit — and a key computed in three places is a key computed
-- three ways. It is recomputed on UPDATE too, so correcting a typo in a number
-- moves the person to their real identity.
CREATE OR REPLACE FUNCTION hyfit_v2.athletes_set_identity()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.identity_key := CASE
    WHEN hyfit_v2.mobile_key(NEW.mobile) <> ''
    THEN hyfit_v2.mobile_key(NEW.mobile) || '|' || hyfit_v2.name_key(NEW.name)
    -- No number: unique to this row and never mergeable with anybody. NEW.id is
    -- already populated here — column defaults are applied before BEFORE
    -- triggers fire.
    ELSE 'anon:' || NEW.id::text
  END;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hyfit_v2_athletes_identity ON hyfit_v2.athletes;
CREATE TRIGGER hyfit_v2_athletes_identity
  BEFORE INSERT OR UPDATE ON hyfit_v2.athletes
  FOR EACH ROW EXECUTE FUNCTION hyfit_v2.athletes_set_identity();

-- ============================================================================
-- 3. The entry
-- ============================================================================

-- THE ENTRY IS THE ENTITY. One row per bib per CATEGORY per event, pointing at
-- the person who raced it.
--
-- Not unique on (event_id, athlete_id): an athlete entering several categories
-- at one event is several entries, and a per-athlete constraint would silently
-- drop all but one of the races they ran.
--
-- Not unique on (event_id, bib) either, which is the correction this carries.
-- A bib is how RaceResult labels a start-list row, and the same athlete can
-- appear under one bib in two contests — solo and doubles at the same event is
-- the ordinary case. Keying on the bib alone made those two races one row, so
-- the second one silently replaced the first: one time, one placing, and a
-- category the athlete did not recognise.
--
-- `category` is therefore part of the key and NOT NULL. Empty string, not NULL,
-- for an entry with no contest named: NULLs are distinct from each other in a
-- unique index, so a nullable column here would let one bib accumulate
-- unlimited duplicate rows — the exact thing the key exists to prevent.
CREATE TABLE IF NOT EXISTS hyfit_v2.athlete_events_map (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id    uuid NOT NULL REFERENCES hyfit_v2.athletes (id) ON DELETE CASCADE,
  event_id      uuid NOT NULL REFERENCES hyfit_v2.events (id) ON DELETE CASCADE,

  bib           text NOT NULL
                  CONSTRAINT hyfit_v2_aem_bib_check CHECK (btrim(bib) <> ''),
  category      text NOT NULL DEFAULT '',
  club          text,
  contest_id    text,
  wave          text,
  timeslot      text,
  contest_date  date,
  -- Their age AT THIS EVENT, as the export gave it. On the entry rather than
  -- the person because it is only true on the day; the date of birth on the
  -- person is the thing that stays true.
  age           integer CONSTRAINT hyfit_v2_aem_age_check
                  CHECK (age IS NULL OR age BETWEEN 0 AND 120),

  source        text NOT NULL DEFAULT 'raceresult',
  source_id     text,
  raw           jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Converge a database that ran an earlier version of this migration, where the
-- key was (event_id, bib) and `category` was nullable. All of it is a no-op on
-- a table that was just created above.
UPDATE hyfit_v2.athlete_events_map SET category = '' WHERE category IS NULL;
ALTER TABLE hyfit_v2.athlete_events_map
  ALTER COLUMN category SET DEFAULT '',
  ALTER COLUMN category SET NOT NULL,
  DROP CONSTRAINT IF EXISTS hyfit_v2_aem_event_bib,
  DROP CONSTRAINT IF EXISTS hyfit_v2_aem_event_bib_category;

-- THE ENTRY KEY. An expression index rather than a plain UNIQUE, so that two
-- spellings of one contest are one entry — see contest_key above. If this fails
-- with a uniqueness error, the table already holds rows that differ only by the
-- case or spacing of their category: they are the same entry twice, and which
-- one to keep is a decision for whoever imported them, not for this migration.
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_v2_aem_entry
  ON hyfit_v2.athlete_events_map (event_id, bib, hyfit_v2.contest_key(category));

CREATE INDEX IF NOT EXISTS hyfit_v2_aem_athlete_idx
  ON hyfit_v2.athlete_events_map (athlete_id);
CREATE INDEX IF NOT EXISTS hyfit_v2_aem_event_idx
  ON hyfit_v2.athlete_events_map (event_id);
-- The bib alone is still how a counter and a judge find somebody, so it keeps
-- an index — just not a unique one.
CREATE INDEX IF NOT EXISTS hyfit_v2_aem_event_bib_idx
  ON hyfit_v2.athlete_events_map (event_id, bib);

COMMENT ON TABLE hyfit_v2.athlete_events_map IS
  'One athlete''s entry in one event: bib, category, club, timeslot. Unique on (event_id, bib, category) — the ENTRY is the entity, and one bib may race two contests.';

-- ============================================================================
-- 4. Move what 083 already holds
-- ============================================================================

-- Everything below is conditional on 083's shape still being in place, so this
-- migration is a no-op on a database that has already run it.
DO $$
DECLARE
  had_event_id boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'hyfit_v2' AND table_name = 'athletes'
       AND column_name = 'event_id'
  ) INTO had_event_id;

  IF NOT had_event_id THEN
    RETURN;
  END IF;

  -- 4a. Every existing athlete row IS an entry. Carry it across first, keeping
  -- the athlete id as the entry's owner; the merge below re-points it.
  INSERT INTO hyfit_v2.athlete_events_map (
    athlete_id, event_id, bib, category, club, contest_id, wave, timeslot,
    contest_date, age, source, source_id, raw, created_at)
  SELECT a.id, a.event_id, a.bib, COALESCE(a.category, ''), a.club,
         a.contest_id, a.wave, a.timeslot, a.contest_date, a.age, a.source,
         a.source_id, a.raw, a.created_at
    FROM hyfit_v2.athletes a
   ON CONFLICT DO NOTHING;

  -- 4b. Give every existing row its identity key. The trigger does it, and a
  -- no-op UPDATE is the cheapest way to make it fire for every row.
  UPDATE hyfit_v2.athletes SET name = name;

  -- 4c. Collapse the duplicates the old shape allowed: the same person entered
  -- in two events is two rows with one identity_key. The oldest survives (it is
  -- the one anything else is most likely to already reference) and the rest are
  -- re-pointed and deleted.
  --
  -- `anon:` keys are unique per row by construction, so nobody without a phone
  -- number is merged into anybody here.
  CREATE TEMP TABLE hyfit_v2_merge ON COMMIT DROP AS
    SELECT a.id AS loser,
           first_value(a.id) OVER (
             PARTITION BY a.identity_key ORDER BY a.created_at, a.id
           ) AS winner
      FROM hyfit_v2.athletes a;
  DELETE FROM hyfit_v2_merge WHERE loser = winner;

  UPDATE hyfit_v2.athlete_events_map m
     SET athlete_id = k.winner
    FROM hyfit_v2_merge k
   WHERE m.athlete_id = k.loser;

  -- Re-pointed BEFORE the delete below, not after. `results.athlete_id` is
  -- ON DELETE CASCADE (083), so deleting a merged-away duplicate would take
  -- that person's results with it — the column is dropped a few statements
  -- later, but it is still load-bearing right now.
  UPDATE hyfit_v2.results r
     SET athlete_id = k.winner
    FROM hyfit_v2_merge k
   WHERE r.athlete_id = k.loser;

  DELETE FROM hyfit_v2.athletes a USING hyfit_v2_merge k WHERE a.id = k.loser;
END $$;

-- 4d. The person table sheds its event-shaped columns and its old key.
ALTER TABLE hyfit_v2.athletes
  DROP CONSTRAINT IF EXISTS hyfit_v2_athletes_event_bib;
DROP INDEX IF EXISTS hyfit_v2.hyfit_v2_athletes_event_idx;
DROP INDEX IF EXISTS hyfit_v2.hyfit_v2_athletes_event_category_idx;

ALTER TABLE hyfit_v2.athletes
  DROP COLUMN IF EXISTS event_id,
  DROP COLUMN IF EXISTS bib,
  DROP COLUMN IF EXISTS category,
  DROP COLUMN IF EXISTS club,
  DROP COLUMN IF EXISTS contest_id,
  DROP COLUMN IF EXISTS wave,
  DROP COLUMN IF EXISTS timeslot,
  DROP COLUMN IF EXISTS contest_date,
  DROP COLUMN IF EXISTS age;

ALTER TABLE hyfit_v2.athletes ALTER COLUMN identity_key SET NOT NULL;

-- The key itself. A partial index would let two rows share a phone and a name
-- as long as one of them was inactive, which is not what "this is the same
-- person" means.
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_v2_athletes_identity
  ON hyfit_v2.athletes (identity_key);

CREATE INDEX IF NOT EXISTS hyfit_v2_athletes_mobile_key
  ON hyfit_v2.athletes (hyfit_v2.mobile_key(mobile))
  WHERE hyfit_v2.mobile_key(mobile) <> '';

COMMENT ON TABLE hyfit_v2.athletes IS
  'A person who races. Identified by phone + name (see identity_key); their entries are in athlete_events_map.';
COMMENT ON COLUMN hyfit_v2.athletes.identity_key IS
  'mobile_key|name_key, or anon:<id> for somebody with no usable number. Maintained by trigger — never write it directly.';

-- ============================================================================
-- 5. Results hang off the ENTRY
-- ============================================================================

-- `results` was keyed to the athlete and to (event_id, bib) — the same fact
-- twice, and after the split the athlete no longer implies an event. It now
-- points at the entry, which carries both. The person is one join away and is
-- deliberately NOT duplicated here.
ALTER TABLE hyfit_v2.results
  ADD COLUMN IF NOT EXISTS entry_id uuid REFERENCES hyfit_v2.athlete_events_map (id) ON DELETE CASCADE;

-- Matched on the category too, not the bib alone: one bib can hold two entries
-- now, and joining on the bib would attach a solo result to whichever of the
-- athlete's contests the planner happened to reach first.
UPDATE hyfit_v2.results r
   SET entry_id = m.id
  FROM hyfit_v2.athlete_events_map m
 WHERE r.entry_id IS NULL
   AND m.event_id = r.event_id
   AND m.bib = r.bib
   AND m.category = COALESCE(r.category, '');

-- A result whose bib has no entry cannot be attributed to anybody. There should
-- be none: every 083 athlete row became an entry above, and the importer writes
-- the entry first. If one exists anyway, stop — rolling the whole migration
-- back is right, because the alternative is deleting somebody's race or
-- carrying a row nothing can join to.
DO $$
DECLARE orphans bigint;
BEGIN
  SELECT count(*) INTO orphans FROM hyfit_v2.results WHERE entry_id IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      '% result row(s) have no entry in athlete_events_map. Import the start list for those events, or delete the orphaned results, then re-run.', orphans;
  END IF;
END $$;

ALTER TABLE hyfit_v2.results ALTER COLUMN entry_id SET NOT NULL;
ALTER TABLE hyfit_v2.results DROP COLUMN IF EXISTS athlete_id;

-- ONE RESULT PER ENTRY, and the entry is now what the key is built on. 083 made
-- it one result per (event_id, bib), which is the same mistake the map carried:
-- an athlete racing solo and doubles at one event under one bib has two results
-- and that constraint permitted one of them.
ALTER TABLE hyfit_v2.results
  DROP CONSTRAINT IF EXISTS hyfit_v2_results_event_bib;
-- Both exceptions, because ADD CONSTRAINT can fail two ways on a re-run: the
-- CONSTRAINT already being there (duplicate_object) and the INDEX it wants to
-- create already being there under that name (duplicate_table). Catching only
-- the first is why this file failed on its second application.
DO $$
BEGIN
  ALTER TABLE hyfit_v2.results
    ADD CONSTRAINT hyfit_v2_results_entry UNIQUE (entry_id);
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

-- The bib still indexes the way a person looks a result up, just not uniquely.
CREATE INDEX IF NOT EXISTS hyfit_v2_results_event_bib_idx
  ON hyfit_v2.results (event_id, bib);

-- An earlier version of this file created a plain index on entry_id, which the
-- UNIQUE constraint above now provides. Two indexes on one column cost every
-- write and buy nothing.
DROP INDEX IF EXISTS hyfit_v2.hyfit_v2_results_entry_idx;

-- ============================================================================
-- 6. Athlete login
-- ============================================================================

-- Ported from the dropped `hyfit` schema unchanged in shape, because the OTP
-- service's throttle and verify queries are written against exactly these
-- columns.
CREATE TABLE IF NOT EXISTS hyfit_v2.otp_codes (
  id          bigserial PRIMARY KEY,
  mobile      varchar(15) NOT NULL,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Both reads go through this: the resend throttle counts recent rows for a
-- number, and verification takes the newest live one.
CREATE INDEX IF NOT EXISTS hyfit_v2_otp_codes_mobile_time
  ON hyfit_v2.otp_codes (mobile, created_at DESC);

-- Athlete sessions live in their own table rather than beside the staff ones in
-- hyfit_v2.refresh_tokens: that table's user_id references hyfit_v2.users, and
-- an athlete is not a user of the console. One table with two nullable owners
-- would mean every read of it has to remember which kind it is holding.
CREATE TABLE IF NOT EXISTS hyfit_v2.athlete_refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id uuid NOT NULL REFERENCES hyfit_v2.athletes (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hyfit_v2_athlete_refresh_live
  ON hyfit_v2.athlete_refresh_tokens (athlete_id)
  WHERE revoked_at IS NULL;

COMMIT;
