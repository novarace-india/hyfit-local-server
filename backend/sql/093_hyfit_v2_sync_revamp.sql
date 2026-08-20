-- ============================================================================
-- 093: the pairing revamp — one prod event, one local event, ONE id, and two
--      endpoints that point in opposite directions.
--
-- WHAT 086 GOT RIGHT AND WHAT THIS CHANGES.
--
-- 086 built the sending half of this: prod mints a credential, an operator
-- carries it to the venue, and the venue pushes `athletes` and `results` up.
-- Three things about that shape did not survive contact with an actual event.
--
--   1. THE TWO DATABASES DID NOT AGREE ON WHAT THE EVENT WAS. Each side's event
--      was created by hand, so each had its own uuid and its own name, venue,
--      dates and RaceResult wiring — typed twice, by two people, on two days.
--      `event_push_targets.remote_event_id` existed to map one to the other,
--      and every screen that wanted to say something about "the event" had to
--      know which of the two it meant. The venue is also where the typing was
--      most likely to be wrong: at six in the morning, from a phone screen.
--
--   2. THERE WAS NO WAY DOWN. Sync was one-directional by design, which meant
--      configuration only ever travelled by hand. An admin who fixed the
--      check-in window on prod had fixed it on prod.
--
--   3. THE ROSTER WAS A SEPARATE THING THAT HAD TO GO FIRST. `results` carries
--      `athlete_id NOT NULL REFERENCES athletes(id)`, so the results push
--      rejected anything whose athlete prod had not already been sent — "push
--      the roster for this event first". Two endpoints, an ordering constraint
--      between them, and a failure mode whose message was about the endpoint
--      the operator had not pressed.
--
-- THE SHAPE NOW.
--
--   * ONE ID. The local event is not created by hand — it is created BY the
--     pull, carrying prod's uuid. `hyfit_v2.events.id` is the same value in
--     both databases, so there is nothing to map and no screen has to ask which
--     event it means. `remote_event_id` and `remote_event_name` are dropped
--     below because there is no longer a remote event to name: there is one
--     event, in two places.
--
--   * TWO ENDPOINTS, OPPOSITE DIRECTIONS. `pull_url` is a GET — prod hands the
--     venue the event and its whole configuration. `push_url` is a POST — the
--     venue hands prod the standings. Each is stored WHOLE, as the string prod
--     issued, minus its `?k=`: the token lives in `token` and travels as a
--     Bearer header, so it stays out of prod's access logs and out of anything
--     this console renders. They are independently editable, so an endpoint
--     that moves mid-event is a field somebody corrects rather than a
--     Disconnect and a fresh credential.
--
--   * NO ROSTER. The athletes endpoint is gone and `push_runs.kind` no longer
--     admits 'athletes'. A results push is SELF-CONTAINED — each row carries
--     its athlete with it and the receiver upserts the athlete before the
--     result. Participants are added wherever they are added; nothing has to be
--     pushed first, and there is no ordering between two endpoints to get
--     wrong. `athletes.sync_batch` stays exactly as 086 defined it, because the
--     athletes prod holds for an offline event are still the ones a push put
--     there and the batch prune is still what removes the ones it did not.
--
-- WHY THE RACERESULT URLS TRAVEL NOW, HAVING BEEN FORBIDDEN IN 086.
--
-- 086 said `raceresults_endpoints` holds URLs that ARE credentials and a sync
-- carrying them would put the venue's RaceResult keys in a second place for no
-- reader's benefit. That was about the direction it was talking about: local →
-- prod, where prod has no use for them. This is the other direction. The venue
-- laptop is precisely the machine that needs those URLs to run check-in and
-- scoring, and today it gets them by somebody typing them in again. Prod is
-- where they are already configured; the pull is how the laptop inherits them.
--
-- THIS MIGRATION SUPERSEDES THE LOCAL-ONLY 087_hyfit_v2_push_endpoints.sql.
-- That file existed only in hyfit-local-server and collided with prod's own
-- 087. Its two ideas — endpoints stored whole, interval as a number rather than
-- an enumerated dropdown — are both here. A local database that ran it is
-- rebuilt rather than migrated; see the README.
--
-- APPLIED TO BOTH DATABASES, like 086 and for the same reason: each side only
-- uses one role's tables, and the schemas staying identical is the property
-- that makes a local server a drop-in for prod.
--
-- Idempotent, per the convention in this directory. Safe to re-run.
-- ============================================================================

BEGIN;

-- ============================================================================
-- The prod role: what a receiving server holds
-- ============================================================================

-- What a credential may do, restated.
--
-- 086 wrote 'athletes' and 'results' — two writes. The pair is now one read and
-- one write, and they are not the same kind of thing: `config` hands the venue
-- everything about the event including the RaceResult keys, `results` lets it
-- write standings back. An event that wants a laptop to read its setup without
-- being able to publish anything is a real thing to want, and it is one row.
--
-- 'athletes' is dropped from the permitted set rather than left as a tolerated
-- no-op: a scope that names an endpoint which no longer exists is a scope
-- somebody will grant and then wonder why nothing happens.
--
-- DROP THE CONSTRAINT BEFORE REWRITING THE ROWS, NOT AFTER.
--
-- The two constraints — 086's and this one — deliberately share a NAME, so that
-- re-running this file replaces rather than accumulates. The cost of that is
-- that the old one is still enforcing while any UPDATE below it runs, and the
-- old one is `scopes <@ ARRAY['athletes','results']`. Rewriting a row to
-- `{config,results}` under it fails with 23514 naming a constraint that, read
-- from the migration alone, looks like the one being installed:
--
--     new row for relation "event_ingest_tokens" violates check constraint
--     "hyfit_v2_ingest_tokens_scopes_check"
--     Failing row contains (…, {config,results}, …)
--
-- — a row that satisfies the constraint this file adds, rejected by the
-- constraint this file is replacing. The order is the whole fix.
ALTER TABLE hyfit_v2.event_ingest_tokens
  DROP CONSTRAINT IF EXISTS hyfit_v2_ingest_tokens_scopes_check;

UPDATE hyfit_v2.event_ingest_tokens
   SET scopes = ARRAY(
         SELECT DISTINCT s FROM unnest(
           array_replace(scopes, 'athletes', 'config')
         ) AS s
         ORDER BY s
       )
 WHERE 'athletes' = ANY (scopes);

ALTER TABLE hyfit_v2.event_ingest_tokens
  ADD CONSTRAINT hyfit_v2_ingest_tokens_scopes_check
  CHECK (
    scopes <@ ARRAY['config','results']::text[]
    AND cardinality(scopes) > 0
  );

ALTER TABLE hyfit_v2.event_ingest_tokens
  ALTER COLUMN scopes SET DEFAULT ARRAY['config','results']::text[];

COMMENT ON COLUMN hyfit_v2.event_ingest_tokens.scopes IS
  'config = may GET this event and its whole configuration. results = may POST standings for it. Nothing else in the module is reachable with this credential.';

-- ============================================================================
-- The local role: what a sending server holds
-- ============================================================================

-- The two endpoints, stored whole.
--
-- Empty means "not paired for that half yet". There is deliberately no
-- fallback that rebuilds a URL from an origin and an event id: that fallback is
-- what made 086's stored endpoints unreadable — the sender invented a path,
-- the invented path happened to match, and the endpoint an operator actually
-- pasted was never read. If it is not stored, nothing is sent, and the screen
-- says so.
ALTER TABLE hyfit_v2.event_push_targets
  ADD COLUMN IF NOT EXISTS pull_url text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS push_url text NOT NULL DEFAULT '';

COMMENT ON COLUMN hyfit_v2.event_push_targets.pull_url IS
  'GET. The full URL this server reads the event and its configuration from, as prod issued it, without its ?k=. Empty = not paired.';
COMMENT ON COLUMN hyfit_v2.event_push_targets.push_url IS
  'POST. The full URL this server writes the standings to, as prod issued it, without its ?k=. Empty = not paired.';

-- Carry a binding written by 086 or by the local-only 087 forward, so a
-- database that is migrated rather than rebuilt shows the operator the two URLs
-- it has been using rather than two blanks that read as "not configured".
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'hyfit_v2'
       AND table_name   = 'event_push_targets'
       AND column_name  = 'results_url'
  ) THEN
    EXECUTE $sql$
      UPDATE hyfit_v2.event_push_targets
         SET push_url = results_url,
             updated_at = now()
       WHERE btrim(push_url) = '' AND btrim(results_url) <> ''
    $sql$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'hyfit_v2'
       AND table_name   = 'event_push_targets'
       AND column_name  = 'remote_event_id'
  ) THEN
    EXECUTE $sql$
      UPDATE hyfit_v2.event_push_targets
         SET pull_url = base_url || '/api/hyfit-judge/ingest/events/' || remote_event_id || '/config',
             updated_at = now()
       WHERE btrim(pull_url) = ''
    $sql$;
  END IF;
END $$;

-- Say out loud what is about to be dropped, and from how many rows.
--
-- The DROPs below are the only irreversible statements in this file. On a PROD
-- database `event_push_targets` is the other role's table and is expected to be
-- EMPTY — prod receives, it never sends (see 086) — so the drops take nothing
-- with them. On a venue laptop it has exactly one row per paired event, and
-- that row is being reshaped on purpose.
--
-- Either way the count belongs in the transcript of the run, because "it was
-- empty" and "there was one row and we reshaped it" are the two outcomes, and
-- the person running this should not have to infer which one happened.
DO $$
DECLARE
  target_rows bigint;
BEGIN
  SELECT count(*) INTO target_rows FROM hyfit_v2.event_push_targets;
  IF target_rows = 0 THEN
    RAISE NOTICE '093: event_push_targets is empty — the column drops below take no data with them (expected on a prod node).';
  ELSE
    RAISE NOTICE '093: event_push_targets has % row(s). Dropping athletes_url, results_url, athletes_pushed_at, athletes_pushed_rows, remote_event_id, remote_event_name from them. pull_url/push_url were backfilled above.', target_rows;
  END IF;
END $$;

-- The roster columns and the id mapping, gone.
--
-- `remote_event_id` was NOT NULL and is the one drop here that cannot be
-- undone by re-running: a paired local database that is rolled back to 086 has
-- to be re-paired. That is the trade for the single id, and re-pairing is one
-- paste.
ALTER TABLE hyfit_v2.event_push_targets
  DROP COLUMN IF EXISTS athletes_url,
  DROP COLUMN IF EXISTS results_url,
  DROP COLUMN IF EXISTS athletes_pushed_at,
  DROP COLUMN IF EXISTS athletes_pushed_rows,
  DROP COLUMN IF EXISTS remote_event_id,
  DROP COLUMN IF EXISTS remote_event_name;

-- How often each direction runs on its own.
--
-- TWO INTERVALS, BECAUSE THEY ANSWER TO DIFFERENT THINGS. The standings change
-- continuously while a race is being scored, so the push is the fast one. The
-- configuration changes when an admin edits it, which is rare and never
-- urgent — but "rare" is not "never", and the whole reason the pull exists is
-- that a correction made on prod used to reach the venue only by telephone. A
-- quarter of an hour is often enough for that and cheap enough to leave on.
--
-- 0 = manual only, on both. Up to 1440 (a day), past which "automatic" has
-- stopped meaning anything. Any whole number in between: 086 enumerated a
-- dropdown in a CHECK, which is fine as a set of suggestions and wrong as a
-- constraint — "every 7 minutes" is not an error, and a venue asking for it got
-- a constraint name in front of them.
ALTER TABLE hyfit_v2.event_push_targets
  ADD COLUMN IF NOT EXISTS pull_interval_minutes integer NOT NULL DEFAULT 15;

ALTER TABLE hyfit_v2.event_push_targets
  DROP CONSTRAINT IF EXISTS hyfit_v2_push_targets_interval_check;
ALTER TABLE hyfit_v2.event_push_targets
  ADD CONSTRAINT hyfit_v2_push_targets_interval_check
  CHECK (interval_minutes >= 0 AND interval_minutes <= 1440);

ALTER TABLE hyfit_v2.event_push_targets
  DROP CONSTRAINT IF EXISTS hyfit_v2_push_targets_pull_interval_check;
ALTER TABLE hyfit_v2.event_push_targets
  ADD CONSTRAINT hyfit_v2_push_targets_pull_interval_check
  CHECK (pull_interval_minutes >= 0 AND pull_interval_minutes <= 1440);

COMMENT ON COLUMN hyfit_v2.event_push_targets.interval_minutes IS
  'Minutes between automatic results pushes. 0 = manual only, up to 1440. The console suggests 1/2/3/5/10/20/30/60 but does not require them.';
COMMENT ON COLUMN hyfit_v2.event_push_targets.pull_interval_minutes IS
  'Minutes between automatic configuration pulls. 0 = manual only, up to 1440.';

-- What the last pull did.
--
-- The mirror of the results_* bookkeeping 086 put here, and asked at the same
-- awful moment: an hour into the event, with somebody saying the laptop has the
-- wrong check-in window. `config_fingerprint` is the digest of the last
-- configuration that landed — a pull every quarter hour mostly finds nothing
-- changed, and a pull that changes nothing should say "unchanged" rather than
-- rewrite the event's rows and stamp `updated_at`.
ALTER TABLE hyfit_v2.event_push_targets
  ADD COLUMN IF NOT EXISTS config_pulled_at    timestamptz,
  ADD COLUMN IF NOT EXISTS config_fingerprint  text,
  ADD COLUMN IF NOT EXISTS last_pull_at        timestamptz,
  ADD COLUMN IF NOT EXISTS last_pull_status    text,
  ADD COLUMN IF NOT EXISTS last_pull_error     text;

ALTER TABLE hyfit_v2.event_push_targets
  DROP CONSTRAINT IF EXISTS hyfit_v2_push_targets_pull_status_check;
ALTER TABLE hyfit_v2.event_push_targets
  ADD CONSTRAINT hyfit_v2_push_targets_pull_status_check
  CHECK (last_pull_status IS NULL OR last_pull_status IN ('ok','error','skipped'));

COMMENT ON COLUMN hyfit_v2.event_push_targets.config_pulled_at IS
  'When a pull last CHANGED this event''s configuration. Null = paired but never applied anything.';
COMMENT ON COLUMN hyfit_v2.event_push_targets.config_fingerprint IS
  'Digest of the last configuration applied. A pull matching it is recorded as skipped rather than rewriting the event.';

-- `base_url` keeps its meaning: the origin of both endpoints above, and the one
-- address an operator thinks in. Editing it rewrites the origin of both, which
-- is what "Change server address" has always claimed to do.
COMMENT ON COLUMN hyfit_v2.event_push_targets.base_url IS
  'Prod''s origin, no trailing slash, no path. The origin of pull_url and push_url; editing it rewrites both.';

COMMENT ON TABLE hyfit_v2.event_push_targets IS
  'Where a local server pulls one offline event''s configuration from and pushes its standings to. One row per event; the event id is prod''s. `token` is a secret and must never leave this database.';

-- ============================================================================
-- History
-- ============================================================================

-- 'athletes' out, 'config_pull' in.
--
-- A pull is a run in exactly the sense this table means: an attempt, against a
-- remote server, that succeeded or did not, at a time somebody will later want
-- to know. Keeping both directions in one table is what makes "what has this
-- pairing actually been doing" a single ordered read.
-- Same drop-then-rewrite-then-add order as the scopes above, for the same
-- reason. This particular rewrite would in fact survive the old constraint —
-- it writes 'results', which 086 already allowed — but relying on that means
-- the safety of the statement depends on which value it happens to write, and
-- the next person to change that value has no way to know they are standing on
-- it. The order costs nothing and removes the question.
ALTER TABLE hyfit_v2.push_runs
  DROP CONSTRAINT IF EXISTS hyfit_v2_push_runs_kind_check;

UPDATE hyfit_v2.push_runs SET kind = 'results' WHERE kind = 'athletes';

ALTER TABLE hyfit_v2.push_runs
  ADD CONSTRAINT hyfit_v2_push_runs_kind_check
  CHECK (kind IN ('config_pull','results','results_final'));

COMMENT ON COLUMN hyfit_v2.push_runs.kind IS
  'config_pull = prod → local, the event and its configuration. results = local → prod, the provisional standings into prod''s cache. results_final = local → prod, written to prod''s tables so they outlive the cache.';

COMMENT ON TABLE hyfit_v2.push_runs IS
  'Append-only history of every sync attempt on this server, in both directions. Pruned to the most recent runs per event by the sync service; nothing else deletes from it.';

COMMIT;
