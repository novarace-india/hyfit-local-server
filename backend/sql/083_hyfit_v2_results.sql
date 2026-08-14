-- ============================================================================
-- 083: the results feed — where it is read from, and where it may be kept.
--
-- RaceResult scores the race. This migration gives an event three things it
-- did not have after the cutover (079/080):
--
--   1. a RESULTS endpoint alongside the participant and update ones, on the
--      same versioned `raceresults_endpoints` row, so all of an event's
--      RaceResult wiring is published in one act and read from one place;
--   2. a MODE on the event saying what to do with what comes back — nothing,
--      serve it live out of Valkey, or keep it here;
--   3. the two tables mode 'stored' writes: `athletes` and `results`, both
--      keyed by event.
--
-- WHY BOTH A CACHE AND TABLES. They answer different questions. Mid-race the
-- feed changes every few minutes and nothing about it is worth keeping — it is
-- a photograph of an unfinished race, and writing each pull to Postgres would
-- mean the database's answer to "what happened" changes under a reader all
-- afternoon. That is the cache: `hyfitgames:results:{event}`, TTL'd, thrown
-- away when the event is over. Storing is the opposite intention — this is the
-- result, keep it — and it has to survive a Valkey flush, be joinable, and be
-- readable a year later. An event moves from one to the other exactly once, and
-- the mode column is what says which of the two a reader is being served.
--
-- THE ATHLETES TABLE IS NOT A REGISTRATION SYSTEM. It is the start list this
-- event was run on, imported from RaceResult's participant endpoint and keyed
-- by (event_id, bib) — the only identity both sides of that feed agree on.
-- There is deliberately no cross-event person: `hyfit.athletes` was that, it
-- lived in a schema this deployment no longer has, and the field apps have
-- worked without one since 079. If a person entity comes back it should come
-- back as its own decision, not as a side effect of importing a start list.
--
-- Idempotent, per the convention in this directory (backend/sql is applied by
-- hand). Safe to re-run.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------- endpoints
-- The results feed's own Custom API. A RaceResult Custom API is a URL whose
-- key IS the access credential and whose configured *API details* decide what
-- it returns, so the results list is a DIFFERENT key from the participant one
-- and cannot be derived from it — hence a column rather than a suffix.
--
-- Empty by default, and deliberately NOT part of
-- hyfit_v2_endpoints_published_is_usable: an event can be run end to end with
-- check-in and judging and never publish a standings feed at all.
ALTER TABLE hyfit_v2.raceresults_endpoints
  ADD COLUMN IF NOT EXISTS results_url text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS results_mapping jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN hyfit_v2.raceresults_endpoints.results_url IS
  'The standings Custom API, fetched whole. Its own key — NOT derived from bib_lookup_url. Blank = this event publishes no results feed. Treat as a secret.';
COMMENT ON COLUMN hyfit_v2.raceresults_endpoints.results_mapping IS
  'Our result field key -> this event''s RaceResult column name. Empty is normal: a standard HYFIT export is alias-matched unaided.';

-- ------------------------------------------------------------------- events
-- What a reader is served. Three values and not a boolean, because "off" and
-- "the numbers are in the database" are different states that a single flag
-- would have to conflate — and the difference between them is whether an
-- athlete refreshing the page sees standings that will still be there tomorrow.
--
--   off     nothing is published; public reads answer 404
--   live    serve the cached pull, which is provisional by construction
--   stored  serve `results`, which is what somebody consciously wrote here
ALTER TABLE hyfit_v2.events
  ADD COLUMN IF NOT EXISTS results_mode text NOT NULL DEFAULT 'off',
  ADD COLUMN IF NOT EXISTS results_stored_at timestamptz;

DO $$
BEGIN
  ALTER TABLE hyfit_v2.events
    ADD CONSTRAINT hyfit_v2_events_results_mode_check
    CHECK (results_mode IN ('off','live','stored'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN hyfit_v2.events.results_mode IS
  'off | live (serve the Valkey pull) | stored (serve hyfit_v2.results). The public read honours this and nothing else.';
COMMENT ON COLUMN hyfit_v2.events.results_stored_at IS
  'When results were last imported into hyfit_v2.results for this event.';

-- ----------------------------------------------------------------- athletes
-- One row per bib per event: the start list, as imported.
--
-- (event_id, bib) is the key because it is the only identity RaceResult and
-- this database both hold. `source_id` carries RaceResult's own row id when the
-- feed exposes one, for tracing back — it is NOT the key, because plenty of
-- Custom APIs do not return it and a start list that stops carrying it must not
-- start creating duplicate athletes.
CREATE TABLE IF NOT EXISTS hyfit_v2.athletes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES hyfit_v2.events (id) ON DELETE CASCADE,

  bib            text NOT NULL
                   CONSTRAINT hyfit_v2_athletes_bib_check CHECK (btrim(bib) <> ''),
  name           text NOT NULL DEFAULT '',
  gender         text,
  date_of_birth  date,
  -- RaceResult exports an age as often as a date of birth, and the two are not
  -- interchangeable: an age is only true on the day of the race. Both are kept
  -- as given rather than one derived from the other.
  age            integer CONSTRAINT hyfit_v2_athletes_age_check
                   CHECK (age IS NULL OR age BETWEEN 0 AND 120),
  mobile         text,
  club           text,
  category       text,
  contest_id     text,
  wave           text,
  timeslot       text,
  contest_date   date,

  -- Where this row came from. 'raceresult' for an import, 'results' for a bib
  -- that first appeared in the standings feed with no start-list row behind it
  -- — which happens, and is worth being able to see rather than smoothing over.
  source         text NOT NULL DEFAULT 'raceresult',
  source_id      text,
  -- The whole feed row as received. Costs little and settles every "did the
  -- export actually carry that column" argument without a re-import.
  raw            jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT hyfit_v2_athletes_event_bib UNIQUE (event_id, bib)
);

CREATE INDEX IF NOT EXISTS hyfit_v2_athletes_event_idx
  ON hyfit_v2.athletes (event_id);
CREATE INDEX IF NOT EXISTS hyfit_v2_athletes_event_category_idx
  ON hyfit_v2.athletes (event_id, category);

COMMENT ON TABLE hyfit_v2.athletes IS
  'The start list one event was run on, imported from its RaceResult participant endpoint. Keyed by (event_id, bib); not a cross-event person.';

-- ------------------------------------------------------------------ results
-- One row per bib per event: what they did.
--
-- The split station columns are typed rather than left in `raw` because they
-- are what a HYFIT scorecard IS — six runs, six stations, a cognitive segment
-- either side — and a scorecard built by reaching into jsonb would have to
-- re-guess the column spellings on every read. Everything is milliseconds:
-- RaceResult writes "22:16" for a total and "00:11" for a memorise time, i.e.
-- the same shape at two magnitudes, and storing the strings would hand every
-- reader that ambiguity.
CREATE TABLE IF NOT EXISTS hyfit_v2.results (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES hyfit_v2.events (id) ON DELETE CASCADE,
  athlete_id        uuid NOT NULL REFERENCES hyfit_v2.athletes (id) ON DELETE CASCADE,

  -- Denormalised from the athlete on purpose: a result is read far more often
  -- than the roster is edited, every public read wants these four, and they are
  -- what the feed itself said at import time — which is the honest record of
  -- what the standings were computed from.
  bib               text NOT NULL,
  name              text NOT NULL DEFAULT '',
  category          text,
  club              text,

  status            text NOT NULL DEFAULT 'FIN'
                      CONSTRAINT hyfit_v2_results_status_check
                      CHECK (status IN ('REG','FIN','DNF','DNS','DQ')),

  rank              integer,
  age_group_rank    integer,

  total_ms          bigint,
  -- The pair's time, as RaceResult computed it. Kept rather than recomputed:
  -- the doubles rule (a team's time is its LATER member's) is RaceResult's to
  -- apply here, and a second implementation of it is a second answer.
  -- "00:00" in the feed means no team and lands as NULL, not zero.
  team_time_ms      bigint,

  -- The cognitive segment: memorise at the start, recall at the end.
  cog_ms            bigint,
  run1_ms           bigint,
  st1_ms            bigint,
  run2_ms           bigint,
  st2_ms            bigint,
  run3_ms           bigint,
  st3_ms            bigint,
  run4_ms           bigint,
  st4_ms            bigint,
  run5_ms           bigint,
  st5_ms            bigint,
  run6_ms           bigint,
  st6_ms            bigint,

  -- Penalties and bonuses as a map rather than columns: which ones an event
  -- carries is an event-by-event decision (the sample feed has S2 and S3 and
  -- not the rest), and a column per station per rule would be sixteen mostly
  -- empty columns that still would not cover the next event.
  penalties         jsonb NOT NULL DEFAULT '{}'::jsonb,

  raw               jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_url        text,
  imported_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT hyfit_v2_results_event_bib UNIQUE (event_id, bib)
);

CREATE INDEX IF NOT EXISTS hyfit_v2_results_event_idx
  ON hyfit_v2.results (event_id);
-- The public read's order: standings within a contest, fastest first.
CREATE INDEX IF NOT EXISTS hyfit_v2_results_event_category_rank_idx
  ON hyfit_v2.results (event_id, category, rank);
CREATE INDEX IF NOT EXISTS hyfit_v2_results_athlete_idx
  ON hyfit_v2.results (athlete_id);

COMMENT ON TABLE hyfit_v2.results IS
  'Imported RaceResult standings for one event, one row per bib. Every time column is milliseconds. Replaced wholesale by each import — see the importer.';

COMMIT;
