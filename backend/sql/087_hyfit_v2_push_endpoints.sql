-- ============================================================================
-- 087: the two push endpoints, stored as endpoints.
--
-- WHAT WAS WRONG. 086 stored a binding as `base_url` + `remote_event_id` and
-- the sender rebuilt both URLs from them:
--
--     <base_url>/api/hyfit-judge/ingest/events/<remote_event_id>/athletes
--     <base_url>/api/hyfit-judge/ingest/events/<remote_event_id>/results
--
-- Which meant the two endpoints prod hands out were never actually stored. An
-- operator pastes the results endpoint, the parser takes the origin, the event
-- id and the token off it, throws the rest away, and reconstructs a URL that
-- happens to match — until it does not. The moment prod publishes the standings
-- on a different host, behind a different prefix, or on a path this code did
-- not invent, the results endpoint an operator pasted is silently ignored and
-- there is no screen on which they can see that, let alone change it. That is
-- the "the results endpoint is not updating" symptom: it was never read.
--
-- WHAT THIS DOES. Stores each endpoint whole, as the string prod issued, minus
-- its `?k=` — the token stays in `token`, sent as a Bearer header, and keeping
-- a second copy of it in a column the console renders would undo that. The two
-- are independently editable, so a results endpoint that moves mid-event is a
-- field somebody corrects rather than a Disconnect and a fresh credential.
--
-- WHY `base_url` STAYS. It is still where the handshake goes, it is still the
-- one address the operator thinks in, and editing it rewrites the origin of
-- both endpoints below — so the existing "Change server address" control keeps
-- meaning what it says.
--
-- THE INTERVAL IS A NUMBER NOW. 086's CHECK enumerated a dropdown
-- (0,1,2,3,5,10,20,30,60), which is fine as a set of suggestions and wrong as a
-- constraint: "every 7 minutes" is not an error, and a venue asking for it got
-- a constraint name in front of them. Any whole number of minutes from 0
-- (manual only) up to a day is accepted; the console still offers the old list
-- as quick picks.
--
-- Idempotent, per the convention in this directory. Safe to re-run.
-- ============================================================================

BEGIN;

-- The endpoint each half of a push is actually POSTed to. Empty means "not set
-- yet" and the sender falls back to building one from `base_url` — which is
-- what every row written before this migration is, and what a bind from a
-- single pasted code still produces.
ALTER TABLE hyfit_v2.event_push_targets
  ADD COLUMN IF NOT EXISTS athletes_url text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS results_url  text NOT NULL DEFAULT '';

COMMENT ON COLUMN hyfit_v2.event_push_targets.athletes_url IS
  'The full URL the roster is POSTed to, as prod issued it, without its ?k=. Empty = derive it from base_url + remote_event_id.';
COMMENT ON COLUMN hyfit_v2.event_push_targets.results_url IS
  'The full URL the standings are POSTed to, as prod issued it, without its ?k=. Empty = derive it from base_url + remote_event_id.';

-- Backfill what 086's rows were implicitly pushing to, so an existing binding
-- shows the operator the same two URLs it has been using all along rather than
-- two blanks that read as "not configured".
UPDATE hyfit_v2.event_push_targets
   SET athletes_url = base_url || '/api/hyfit-judge/ingest/events/' || remote_event_id || '/athletes',
       results_url  = base_url || '/api/hyfit-judge/ingest/events/' || remote_event_id || '/results',
       updated_at   = now()
 WHERE btrim(athletes_url) = '' OR btrim(results_url) = '';

-- Any whole number of minutes. Dropped and re-added because there is no ALTER
-- CONSTRAINT for a CHECK, and named the same so a re-run replaces rather than
-- accumulates.
ALTER TABLE hyfit_v2.event_push_targets
  DROP CONSTRAINT IF EXISTS hyfit_v2_push_targets_interval_check;
ALTER TABLE hyfit_v2.event_push_targets
  ADD CONSTRAINT hyfit_v2_push_targets_interval_check
  CHECK (interval_minutes >= 0 AND interval_minutes <= 1440);

COMMENT ON COLUMN hyfit_v2.event_push_targets.interval_minutes IS
  'Minutes between automatic results pushes. 0 = manual only. Up to 1440 (a day); the console suggests 1/2/3/5/10/20/30/60 but does not require them.';

COMMIT;
