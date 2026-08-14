-- ============================================================================
-- 086: running an event on a laptop at the venue and publishing it from AWS.
--
-- An event is `online` — the deployment the crew works in IS the deployment the
-- public reads — or it is `offline`, and those are two different databases: a
-- local server on the venue's intranet that check-in and the judge tablets talk
-- to, and prod, which is the only one an athlete's family can reach. Nothing
-- else about the event changes. Same schema, same modules, same screens.
--
-- WHAT MOVES, AND ONLY WHAT MOVES. Two tables: `athletes` and `results`. The
-- start list and the standings are what the public read is built from, and they
-- are the whole of what an offline event owes prod. Judges, counters, sessions,
-- PINs, the RaceResult endpoints — none of it crosses. `raceresults_endpoints`
-- in particular holds URLs that ARE credentials, and a sync that carried them
-- would put the venue's RaceResult keys in a second place for no reader's
-- benefit.
--
-- ONE DIRECTION. Local writes, prod receives. Prod never writes back into these
-- two tables for an offline event. The moment it could, two databases are
-- editing one row while a race is running and somebody has to decide which edit
-- was right — which is a merge, and a merge belongs in `hyfit-db-sync` after the
-- event, not in the middle of one.
--
-- HOW THE TWO FIND EACH OTHER. Prod mints a credential for one event
-- (`event_ingest_tokens`); an operator carries it to the venue and pastes it in
-- (`event_push_targets`). The credential names the prod event, so the two
-- databases do NOT need matching event ids — they are created by hand on each
-- side, as different rows describing the same race.
--
-- WHY A TOKEN AND NOT A GENERATED URL. "A temporary endpoint" is the right
-- idea; a per-event route is the wrong shape for it. The routes are fixed and
-- there are three, the credential is what expires and what can be revoked, and
-- the guard that reads it is the one place the scope is enforced — one event,
-- two tables, nothing else reachable. A dynamically minted path would spread
-- that decision across the router.
--
-- THIS MIGRATION IS APPLIED TO BOTH DATABASES. The two roles' tables are
-- created on both even though each side only ever uses one of them: the schemas
-- stay identical, which is the property that makes a local server a drop-in for
-- prod in the first place. Which role a server plays is `HYFIT_NODE_ROLE` in
-- its environment, deliberately not a row anybody can click.
--
-- Idempotent, per the convention in this directory (backend/sql is applied by
-- hand). Safe to re-run.
-- ============================================================================

BEGIN;

-- ------------------------------------------------------------------- events
-- Where this event's public read is served from.
--
--   online   the deployment running the event also publishes it. Today's
--            behaviour, and the default, so every event that exists now keeps
--            working with nothing switched on.
--   offline  the crew works on a local server and prod publishes. Only an
--            offline event may mint a credential, and only an offline event
--            accepts a push.
--
-- Not a boolean because it is read in the UI and in three guards, and
-- `delivery_mode = 'offline'` says what `is_offline = true` only implies.
ALTER TABLE hyfit_v2.events
  ADD COLUMN IF NOT EXISTS delivery_mode text NOT NULL DEFAULT 'online';

DO $$
BEGIN
  ALTER TABLE hyfit_v2.events
    ADD CONSTRAINT hyfit_v2_events_delivery_mode_check
    CHECK (delivery_mode IN ('online','offline'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN hyfit_v2.events.delivery_mode IS
  'online = this deployment publishes the event itself. offline = a local server runs it and pushes athletes + results here. Gates both the ingest routes and the push panel.';

-- --------------------------------------------------------------- sync_batch
-- Which push a row arrived in.
--
-- A snapshot arrives in chunks, and a chunk is its own transaction — a venue
-- connection that dies halfway through must leave prod with SOME of the roster
-- rather than a request that has to be replayed from the start. So the prune
-- cannot be "delete everything, then insert": there is no single transaction to
-- put both halves in.
--
-- Instead every chunk stamps its rows with the push's id, and the finishing
-- call deletes what this event has that is not stamped with it. Prod is briefly
-- a SUPERSET of the venue's roster — an athlete who was removed locally is
-- still there until the last chunk lands — and never a subset. A public page
-- showing one extra name for four seconds is a fair price for never showing an
-- empty start list.
--
-- NULL means the row did not come from a push: everything that exists today,
-- and everything an online event will ever write. The prune is scoped to one
-- event and one batch, so those rows are only ever touched on an event that has
-- been switched to offline, which is exactly when replacing them is the point.
ALTER TABLE hyfit_v2.athletes
  ADD COLUMN IF NOT EXISTS sync_batch uuid;
ALTER TABLE hyfit_v2.results
  ADD COLUMN IF NOT EXISTS sync_batch uuid;

COMMENT ON COLUMN hyfit_v2.athletes.sync_batch IS
  'The push this row last arrived in. NULL = not from a push. The finishing call prunes this event''s rows carrying any other batch.';
COMMENT ON COLUMN hyfit_v2.results.sync_batch IS
  'The push this row last arrived in. NULL = not from a push. See hyfit_v2.athletes.sync_batch.';

CREATE INDEX IF NOT EXISTS hyfit_v2_athletes_sync_batch_idx
  ON hyfit_v2.athletes (event_id, sync_batch);
CREATE INDEX IF NOT EXISTS hyfit_v2_results_sync_batch_idx
  ON hyfit_v2.results (event_id, sync_batch);

-- ============================================================================
-- The prod role: what a receiving server holds
-- ============================================================================

-- One credential, one event, two routes.
--
-- The secret is never stored. `token_hash` is its SHA-256 and `token_prefix` is
-- the first eight characters, which is enough for the console to show WHICH
-- credential a row is without being able to reconstruct it — the same shape as
-- `refresh_tokens` above, for the same reason.
--
-- An event may have several: reissuing before an event day without revoking the
-- one the venue is already using is a normal thing to want, and forcing a
-- single row would make every reissue an outage.
CREATE TABLE IF NOT EXISTS hyfit_v2.event_ingest_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES hyfit_v2.events (id) ON DELETE CASCADE,

  token_hash    text NOT NULL
                  CONSTRAINT hyfit_v2_ingest_tokens_hash_check CHECK (btrim(token_hash) <> ''),
  token_prefix  text NOT NULL DEFAULT '',

  -- A label the operator types: "Bengaluru laptop", "spare machine". Two
  -- credentials for one event are otherwise eight indistinguishable characters
  -- apart on the screen where one of them has to be revoked.
  label         text NOT NULL DEFAULT '',

  -- What this credential may write. Both today; a column rather than an assumed
  -- constant because "results only, the roster is already up" is a real request
  -- and the guard can honour it without a schema change.
  scopes        text[] NOT NULL DEFAULT ARRAY['athletes','results']::text[]
                  CONSTRAINT hyfit_v2_ingest_tokens_scopes_check
                  CHECK (scopes <@ ARRAY['athletes','results']::text[] AND cardinality(scopes) > 0),

  -- NOT NULL on purpose. A credential that outlives the event it was minted for
  -- is a permanent write path into prod that nobody remembers issuing, and the
  -- console offers a default rather than a blank.
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,

  last_used_at  timestamptz,
  last_used_ip  text,
  -- Counted rather than logged per request: a credential's use is not an audit
  -- trail (audit_events is), it is a "did the venue ever actually connect"
  -- indicator on the console, and one UPDATE per push is cheap.
  use_count     bigint NOT NULL DEFAULT 0,

  created_by    uuid REFERENCES hyfit_v2.users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The guard's read: hash in, live row out.
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_v2_ingest_tokens_hash
  ON hyfit_v2.event_ingest_tokens (token_hash);
CREATE INDEX IF NOT EXISTS hyfit_v2_ingest_tokens_event
  ON hyfit_v2.event_ingest_tokens (event_id);

COMMENT ON TABLE hyfit_v2.event_ingest_tokens IS
  'Bearer credentials that let one local server push athletes + results into one offline event here. The secret is shown once at creation and only its hash is kept.';

-- ============================================================================
-- The local role: what a sending server holds
-- ============================================================================

-- Where this event pushes, and how often.
--
-- One row per event — a start list with two destinations is two answers to
-- "what is public", so the UNIQUE is the design and not a convenience.
--
-- `token` is the credential in the clear, because this server has to replay it
-- on every push and there is no user present to re-enter it. It is a venue
-- machine holding a key scoped to one event on one prod database for the
-- duration of one race, which is the smallest thing that can work. It must
-- never be selected into an API response; the console reads `token_prefix`.
CREATE TABLE IF NOT EXISTS hyfit_v2.event_push_targets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              uuid NOT NULL UNIQUE REFERENCES hyfit_v2.events (id) ON DELETE CASCADE,

  -- Prod's origin, no trailing slash, no path: "https://app.example.com".
  base_url              text NOT NULL
                          CONSTRAINT hyfit_v2_push_targets_base_url_check CHECK (btrim(base_url) <> ''),
  -- The event id ON PROD. Different from `event_id` above, and it has to be:
  -- both events were created by hand, in two databases, and neither knows the
  -- other's uuid. The credential carries this, and the handshake confirms it
  -- names the race the operator thinks it does.
  remote_event_id       uuid NOT NULL,
  remote_event_name     text NOT NULL DEFAULT '',

  token                 text NOT NULL,
  token_prefix          text NOT NULL DEFAULT '',
  token_expires_at      timestamptz,

  -- Off pauses the scheduler without discarding the binding — "stop pushing for
  -- ten minutes while we fix the scoring" is not "forget where prod is".
  enabled               boolean NOT NULL DEFAULT true,

  -- Minutes between automatic RESULTS pushes. 0 = manual only.
  --
  -- The roster is deliberately not on this timer: a start list changes when
  -- somebody imports one, which is an act with a button behind it, and pushing
  -- it every minute would spend the whole event re-sending a list that is the
  -- same list.
  interval_minutes      integer NOT NULL DEFAULT 5
                          CONSTRAINT hyfit_v2_push_targets_interval_check
                          CHECK (interval_minutes IN (0,1,2,3,5,10,20,30,60)),

  -- Re-import the standings from RaceResult before each scheduled push.
  --
  -- WHY THIS EXISTS. `hyfit_v2.results` is written by exactly one thing —
  -- `HjudgeResultsService.store()`, the Results screen's "Import into database"
  -- — and the judge app writes back to RaceResult, not here. So without this a
  -- timer would faithfully re-send the same stored snapshot all afternoon while
  -- the race carried on being scored, and the interval would only ever mean
  -- "notice that somebody pressed Import".
  --
  -- WHY IT IS OPT-IN AND DEFAULTS TO FALSE. Storing is deliberately an ACT in
  -- this codebase: a live pull writes the cache and nothing else, precisely so
  -- an operator can look at a half-finished race twenty times without the
  -- database's answer to "what happened" changing under anybody. Turning this on
  -- says "for this event, keep the stored standings current" — which is the
  -- right thing during a race and the wrong thing after one, so it stays a
  -- switch the operator throws rather than a behaviour they inherit.
  auto_import_results   boolean NOT NULL DEFAULT false,

  athletes_pushed_at    timestamptz,
  athletes_pushed_rows  integer,
  results_pushed_at     timestamptz,
  results_pushed_rows   integer,

  -- The last time the standings were written to prod's TABLES rather than its
  -- cache. Null all race long and set once at the end, which is exactly the
  -- shape of the question "have we actually kept these anywhere yet".
  results_stored_at     timestamptz,
  results_stored_rows   integer,

  -- The digest of the last results payload that landed. A race in progress is
  -- pulled far more often than it changes, and re-sending an identical
  -- standings table sixty times an hour over venue wifi buys nothing.
  results_fingerprint   text,

  last_attempt_at       timestamptz,
  last_status           text
                          CONSTRAINT hyfit_v2_push_targets_status_check
                          CHECK (last_status IS NULL OR last_status IN ('ok','error','skipped')),
  last_error            text,
  -- Drives the scheduler's backoff. Reset to 0 by any success.
  consecutive_failures  integer NOT NULL DEFAULT 0,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE hyfit_v2.event_push_targets IS
  'Where a local server pushes one offline event''s athletes + results, and how often. One row per event. `token` is a secret and must never leave this database.';

-- CREATE TABLE IF NOT EXISTS is not a migration.
--
-- Editing the table body above does nothing at all to a database that already
-- ran an earlier version of this file — the CREATE is skipped whole, and the
-- columns added to it since are silently absent. Which is precisely how this
-- was found: the push wrote its rows and then failed on the bookkeeping UPDATE
-- with `column "results_stored_at" does not exist`, on a database that had
-- "successfully" re-run this migration moments earlier.
--
-- So every column added after this file first shipped is also stated as an
-- explicit ALTER. They are no-ops on a fresh database and the whole point on an
-- existing one.
ALTER TABLE hyfit_v2.event_push_targets
  ADD COLUMN IF NOT EXISTS auto_import_results boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS results_stored_at   timestamptz,
  ADD COLUMN IF NOT EXISTS results_stored_rows integer;

-- Every attempt, kept.
--
-- The question this answers is asked at the worst possible moment — an hour
-- into the event, with somebody saying the site is behind — and "when did we
-- last successfully send, and what did it say" has to be answerable without a
-- log file on a laptop nobody can reach. `event_push_targets` carries the last
-- outcome; this carries the shape of the last few hours.
--
-- `trigger_source` and not `trigger`: TRIGGER is reserved in Postgres, and a
-- column that needs quoting everywhere it is read is a column that will
-- eventually be read wrong.
CREATE TABLE IF NOT EXISTS hyfit_v2.push_runs (
  id              bigserial PRIMARY KEY,
  event_id        uuid NOT NULL REFERENCES hyfit_v2.events (id) ON DELETE CASCADE,

  -- Three, because the results go to two different places for two different
  -- reasons: `results` is the fast provisional push into prod's Valkey that the
  -- timer drives all race long, `results_final` is the one deliberate push that
  -- writes prod's tables so the standings outlive the cache. See the ingest
  -- service for why both exist.
  kind            text NOT NULL
                    CONSTRAINT hyfit_v2_push_runs_kind_check
                    CHECK (kind IN ('athletes','results','results_final')),
  trigger_source  text NOT NULL
                    CONSTRAINT hyfit_v2_push_runs_trigger_check CHECK (trigger_source IN ('manual','schedule')),
  status          text NOT NULL
                    CONSTRAINT hyfit_v2_push_runs_status_check CHECK (status IN ('ok','error','skipped')),

  rows_sent       integer NOT NULL DEFAULT 0,
  chunks          integer NOT NULL DEFAULT 0,
  bytes_sent      bigint  NOT NULL DEFAULT 0,
  duration_ms     integer,
  -- The error, or the reason a run was skipped. Empty on a clean push.
  message         text NOT NULL DEFAULT '',

  started_at      timestamptz NOT NULL DEFAULT now()
);

-- The console reads the newest first, per event.
CREATE INDEX IF NOT EXISTS hyfit_v2_push_runs_event_time
  ON hyfit_v2.push_runs (event_id, started_at DESC);

COMMENT ON TABLE hyfit_v2.push_runs IS
  'Append-only history of every push attempt from this server. Pruned to the most recent runs per event by the push service; nothing else deletes from it.';

-- Same reason as above, and the same discovery: a CHECK written into a CREATE
-- TABLE body does not widen on a re-run, so `results_final` was rejected by a
-- constraint the migration believed it had just installed. Dropped and re-added
-- rather than ALTERed, because there is no ALTER CONSTRAINT for a CHECK.
ALTER TABLE hyfit_v2.push_runs
  DROP CONSTRAINT IF EXISTS hyfit_v2_push_runs_kind_check;
ALTER TABLE hyfit_v2.push_runs
  ADD CONSTRAINT hyfit_v2_push_runs_kind_check
  CHECK (kind IN ('athletes','results','results_final'));

COMMIT;
