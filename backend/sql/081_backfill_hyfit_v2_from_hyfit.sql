-- ============================================================================
-- 081: give the existing events and staff their hyfit_v2 rows.
--
-- 080 creates the schema empty. Nothing carries over on its own, which means
-- that until this runs:
--
--   * the admin console's Events screen shows every event from `hyfit` and none
--     of them can be activated, staffed or given endpoints, because none of
--     them exists operationally;
--   * nobody can sign in to the check-in or judge apps, because hyfit_v2.users
--     is empty;
--   * the roster importer refuses ("no operational record yet").
--
-- This is the data half of the cutover. It reads `hyfit` and writes `hyfit_v2`,
-- and it is the ONLY thing that ever should — the application no longer joins
-- the two schemas at all.
--
-- WHAT IT DOES NOT MOVE. Athletes, registrations, entries, categories, results,
-- splits, certificates and protests all stay in `hyfit`. They are the athlete
-- platform's and are not field-ops data; the field apps read their roster from
-- RaceResult now. Check-in state and race data are not moved either, because
-- they no longer exist anywhere but RaceResult.
--
-- Idempotent: re-running adds nothing and overwrites nothing. Safe to run
-- before or after 079.
-- ============================================================================

BEGIN;

-- --------------------------------------------------------------------- events
-- One operational event per existing event, linked back to it.
--
-- Every event, not only those with an ops_status: that column was a gate an
-- admin had to open before an edition could be staffed, and an event that was
-- never gated is still an event somebody may now want to run. An event nobody
-- runs costs one row.
--
-- `name` and `venue` are copied as the starting operational label. They may
-- drift afterwards and that is fine — see the note in hjudge-admin.service.ts:
-- an ops label and a public title are different sentences.
-- Guarded, like every other read of `hyfit` below: this migration must run to
-- completion on a database that has only some of the old schema, or none of it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'hyfit' AND table_name = 'events'
  ) THEN
    RAISE NOTICE 'hyfit.events does not exist — no events to carry over.';
    RETURN;
  END IF;

  EXECUTE $sql$
    INSERT INTO hyfit_v2.events
      (name, venue, timezone, starts_at, ends_at, event_date, status, is_active,
       platform_event_id, created_at)
    SELECT e.name,
           e.venue,
           COALESCE(e.timezone, 'Asia/Kolkata'),
           e.starts_at,
           e.ends_at,
           e.event_date,
           -- hyfit.ops_status uses the same vocabulary, except that NULL there
           -- means "never gated into operations" rather than a state.
           COALESCE(e.ops_status, 'draft'),
           COALESCE(e.is_active, false),
           e.id,
           e.created_at
      FROM hyfit.events e
     WHERE NOT EXISTS (
             SELECT 1 FROM hyfit_v2.events v WHERE v.platform_event_id = e.id
           )
  $sql$;
END $$;

-- hyfit_v2_events_one_active permits a single active row. `hyfit` enforced the
-- same rule, so at most one row can have arrived active — but an event marked
-- active there while another was already active here would break the insert
-- above. Stand everything down and re-raise the one, in that order.
DO $$
DECLARE
  active_count integer;
BEGIN
  SELECT count(*) INTO active_count FROM hyfit_v2.events WHERE is_active;
  IF active_count > 1 THEN
    UPDATE hyfit_v2.events SET is_active = false WHERE is_active;
    UPDATE hyfit_v2.events
       SET is_active = true
     WHERE platform_event_id = (SELECT id FROM hyfit.events WHERE is_active LIMIT 1);
  END IF;
END $$;

-- ---------------------------------------------------------------------- users
-- Everyone, in one insert: field staff by staff ID and PIN, console operators
-- by email and password, and anyone holding both on the one row they always
-- were. hyfit_v2.users carries both credentials since 080.
--
-- Hashes are copied verbatim — scrypt PINs from the same hashPin(), bcrypt
-- passwords as the console wrote them — so nobody is re-issued a credential.
-- Re-issuing PINs to a whole crew mid-cutover is not a migration, it is an
-- incident.
--
-- The whole block is guarded: a database whose `hyfit` schema has no `users`
-- table has nothing to carry over, and must not fail here. That is exactly the
-- state that produced `relation "hyfit.users" does not exist` — in which case
-- the crew is created from scratch on the Team screen, and the first console
-- admin comes from seed_hyfit_v2_admin.sql.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'hyfit' AND table_name = 'users'
  ) THEN
    RAISE NOTICE 'hyfit.users does not exist — no staff to carry over. Seed a console admin with seed_hyfit_v2_admin.sql.';
    RETURN;
  END IF;

  EXECUTE $sql$
    INSERT INTO hyfit_v2.users
      (name, staff_id, pin_hash, email, password_hash, role, event_id,
       platform_user_id, enabled, must_change_pin, last_login_at, created_at)
    SELECT u.name, u.staff_id, u.pin_hash, u.email, u.password_hash, u.role,
           v.id, u.id, u.enabled, u.must_change_pin, u.last_login_at, u.created_at
      FROM hyfit.users u
      LEFT JOIN hyfit_v2.events v ON v.platform_event_id = u.event_id
     WHERE NOT EXISTS (
             SELECT 1 FROM hyfit_v2.users w WHERE w.platform_user_id = u.id
           )
       -- A row with neither credential cannot sign in to anything and would
       -- fail hyfit_v2_users_has_credential.
       AND (u.staff_id IS NOT NULL OR u.email IS NOT NULL)
  $sql$;

  -- The counter stage, if 078 ever ran. Guarded separately: a database that
  -- went from 077 straight to 080 has no such column, and failing on it would
  -- leave the crew half-created.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'hyfit' AND table_name = 'users'
       AND column_name = 'checkin_stage'
  ) THEN
    EXECUTE $sql$
      UPDATE hyfit_v2.users w
         SET checkin_stage = u.checkin_stage
        FROM hyfit.users u
       WHERE u.id = w.platform_user_id
         AND u.checkin_stage IS NOT NULL
         AND w.checkin_stage IS NULL
    $sql$;
  END IF;
END $$;

-- Anyone hired for check-in but left without a stage defaults to Stage 1: it is
-- the stage that exists at every event, and a volunteer who can sign in but can
-- do nothing is the failure this avoids. Admins are deliberately left NULL —
-- they work whichever desk they stand at.
UPDATE hyfit_v2.users
   SET checkin_stage = 'STAGE_1_WRISTBAND'
 WHERE role = 'checkin'
   AND staff_id IS NOT NULL
   AND checkin_stage IS NULL;

-- ---------------------------------------------------------- endpoint config
-- The published RaceResult configuration, as one endpoints row per event.
--
-- Only the PUBLISHED one is carried: drafts are somebody's unfinished edit, and
-- resurrecting one as an event's live configuration is how a half-typed URL
-- ends up being the thing a counter calls.
--
-- The transponder endpoint is left blank. There was nowhere to store one before
-- 080, so there is nothing to copy, and a Stage 2 counter refuses the lookup
-- until an admin fills it in — which is the correct behaviour and not something
-- to paper over with a guess.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'hyfit' AND table_name = 'event_configs'
  ) THEN
    EXECUTE $sql$
      INSERT INTO hyfit_v2.raceresults_endpoints
        (event_id, version, state, bib_lookup_url, update_url,
         participant_mapping, update_mapping, declaration_text,
         declaration_version, checkin_window_enabled,
         checkin_opens_before_minutes, checkin_closes_after_minutes,
         published_at, created_at)
      SELECT v.id, 1, 'published',
             c.participant_api_url, c.update_api_url,
             c.participant_mapping, c.update_mapping, c.declaration_text,
             c.declaration_version, c.checkin_window_enabled,
             c.checkin_opens_before_minutes, c.checkin_closes_after_minutes,
             c.published_at, c.created_at
        FROM hyfit.event_configs c
        JOIN hyfit_v2.events v ON v.platform_event_id = c.event_id
       WHERE c.state = 'published'
         -- A published row with no participant endpoint would fail
         -- hyfit_v2_endpoints_published_is_usable. It is also not a
         -- configuration anybody can run a counter on, so it is skipped rather
         -- than downgraded to a draft nobody asked for.
         AND btrim(COALESCE(c.participant_api_url, '')) <> ''
         AND btrim(COALESCE(c.update_api_url, '')) <> ''
         AND NOT EXISTS (
               SELECT 1 FROM hyfit_v2.raceresults_endpoints r
                WHERE r.event_id = v.id
             )
    $sql$;
  END IF;
END $$;

COMMIT;

-- What to expect, and what to check before opening a counter:
--
--   SELECT count(*) FROM hyfit_v2.events;                        -- = hyfit.events
--   SELECT count(*) FROM hyfit_v2.users WHERE staff_id IS NOT NULL;
--   SELECT count(*) FROM hyfit_v2.raceresults_endpoints;         -- published configs
--   SELECT name FROM hyfit_v2.events WHERE is_active;            -- exactly one
--
-- Every event will need its transponder endpoint set in Operations before a
-- Stage 2 counter can be opened; nothing else needs re-entering.
