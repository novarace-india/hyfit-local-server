-- ============================================================================
-- check_hyfit_v2.sql — does the schema match what the code actually reads?
--
-- NOT a migration. Nothing is written. Run it after 080/082 and before
-- trusting anything.
--
-- Every check below is a real query from the backend, run with LIMIT 0 (or, for
-- the writes, WHERE false): no rows are touched, but Postgres still resolves
-- every column, so a missing one is reported HERE by name instead of at 6am as
-- a 500 saying `column "x" does not exist` on whichever screen someone opened.
--
-- It reports ALL of them in one run, not just the first. Finding a schema gap
-- one error at a time — fix, redeploy, hit the next screen, fix again — is the
-- loop this file exists to end.
--
-- Plain SQL, no psql meta-commands, so it runs anywhere:
--   a GUI client (pgAdmin, DBeaver, TablePlus) — just execute the whole file
--   node scripts/run-sql.mjs sql/check_hyfit_v2.sql
--   psql "$DATABASE_URL" -f backend/sql/check_hyfit_v2.sql
--
-- Output arrives as NOTICE messages. In a GUI, look at the Messages/Output pane
-- rather than the results grid.
-- ============================================================================

DO $$
DECLARE
  -- Each entry is: what it is → the query that proves the columns exist.
  checks text[][] := ARRAY[
    ['console login (adminLogin)',
     'SELECT id, name, email, password_hash, role
        FROM hyfit_v2.users WHERE enabled = true LIMIT 0'],

    ['console refresh + rotation',
     'SELECT id, user_id FROM hyfit_v2.refresh_tokens
       WHERE revoked_at IS NULL AND expires_at > now() LIMIT 0'],

    ['field login (staff ID + PIN)',
     'SELECT id, staff_id, name, pin_hash, role, event_id
        FROM hyfit_v2.users WHERE enabled = true LIMIT 0'],

    ['session resolution (auth guard)',
     'SELECT u.id, u.staff_id, u.name, u.role, u.event_id, u.checkin_stage,
             s.id, s.device_label, s.ip_address
        FROM hyfit_v2.sessions s
        JOIN hyfit_v2.users u ON u.id = s.user_id
       WHERE s.revoked_at IS NULL AND s.expires_at > now()
         AND s.audience = ''judge'' LIMIT 0'],

    ['session + audit writes (login)',
     'SELECT user_id, token_hash, device_label, ip_address, audience, expires_at
        FROM hyfit_v2.sessions LIMIT 0'],

    ['active event fallback',
     'SELECT id FROM hyfit_v2.events WHERE is_active LIMIT 0'],

    ['events list',
     'SELECT id, name, venue, starts_at, ends_at, timezone, status, is_active,
             event_date, platform_event_id, created_at, updated_at
        FROM hyfit_v2.events LIMIT 0'],

    ['ops dashboard',
     'SELECT e.id, e.name, e.venue, e.status,
             (SELECT version FROM hyfit_v2.raceresults_endpoints
               WHERE event_id = e.id AND state = ''published'')
        FROM hyfit_v2.events e LIMIT 0'],

    ['RaceResult config (loadConfig)',
     'SELECT c.bib_lookup_url, c.update_url,
             c.map_lookup_url, c.map_lookup_param, c.map_lookup_key,
             c.participant_mapping, c.update_mapping,
             c.declaration_text, c.declaration_version,
             c.checkin_window_enabled, c.checkin_opens_before_minutes,
             c.checkin_closes_after_minutes,
             e.timezone, e.event_date, e.starts_at
        FROM hyfit_v2.events e
        LEFT JOIN LATERAL (
          SELECT * FROM hyfit_v2.raceresults_endpoints
           WHERE event_id = e.id AND state = ''published''
           ORDER BY version DESC LIMIT 1
        ) c ON true LIMIT 0'],

    ['endpoint publish',
     'SELECT id, event_id, version, state, published_at, published_by, updated_at
        FROM hyfit_v2.raceresults_endpoints LIMIT 0'],

    ['team screen — read',
     'SELECT id, staff_id, name, role, enabled, station_number, checkin_stage,
             must_change_pin, last_login_at
        FROM hyfit_v2.users WHERE staff_id IS NOT NULL LIMIT 0'],

    -- The write path is checked too. A column can be readable and still missing
    -- from an INSERT the code makes; that is exactly how `origin` and
    -- `station_number` survived an earlier version of this file.
    ['team screen — write',
     'INSERT INTO hyfit_v2.users
        (staff_id, name, pin_hash, role, event_id, station_number, checkin_stage)
      SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL WHERE false'],

    ['audit',
     'SELECT id, actor_id, event_id, action, entity_type, entity_id, details,
             created_at FROM hyfit_v2.audit_events LIMIT 0']
  ];
  label    text;
  stmt     text;
  i        integer;
  failures text[] := ARRAY[]::text[];
BEGIN
  FOR i IN 1 .. array_length(checks, 1) LOOP
    label := checks[i][1];
    stmt  := checks[i][2];
    BEGIN
      EXECUTE stmt;
      RAISE NOTICE 'ok    %', label;
    EXCEPTION WHEN OTHERS THEN
      -- Kept going rather than re-raised: the whole point is the complete list.
      RAISE NOTICE 'FAIL  %  ->  %', label, SQLERRM;
      failures := failures || (label || ': ' || SQLERRM);
    END;
  END LOOP;

  RAISE NOTICE '%', '';
  IF array_length(failures, 1) IS NULL THEN
    RAISE NOTICE 'SCHEMA OK — every column the backend reads and writes exists.';
  ELSE
    RAISE NOTICE 'SCHEMA INCOMPLETE — % check(s) failed:', array_length(failures, 1);
    FOR i IN 1 .. array_length(failures, 1) LOOP
      RAISE NOTICE '  %', failures[i];
    END LOOP;
    RAISE NOTICE '%', '';
    RAISE NOTICE 'Apply sql/082_hyfit_v2_console_credentials.sql, then run this again.';
  END IF;
END $$;

-- --------------------------------------------------------------- the contents
-- Structure being right is not the same as there being anybody to sign in as.
DO $$
DECLARE
  admins    integer;
  staff     integer;
  events    integer;
  actives   integer;
  published integer;
BEGIN
  SELECT count(*) INTO admins    FROM hyfit_v2.users  WHERE email IS NOT NULL AND enabled;
  SELECT count(*) INTO staff     FROM hyfit_v2.users  WHERE staff_id IS NOT NULL AND enabled;
  SELECT count(*) INTO events    FROM hyfit_v2.events;
  SELECT count(*) INTO actives   FROM hyfit_v2.events WHERE is_active;
  SELECT count(*) INTO published FROM hyfit_v2.raceresults_endpoints WHERE state = 'published';

  RAISE NOTICE '%', '';
  RAISE NOTICE 'console admins : %', admins;
  RAISE NOTICE 'field staff    : %', staff;
  RAISE NOTICE 'events         : %  (active: %)', events, actives;
  RAISE NOTICE 'published cfg  : %', published;

  IF admins = 0 THEN
    RAISE NOTICE 'WARNING: nobody can sign in to the console. Run seed_hyfit_v2_admin.sql.';
  END IF;
  IF events = 0 THEN
    RAISE NOTICE 'WARNING: no events. Run 081 to carry them over, or create one in Event Control.';
  END IF;
  IF actives > 1 THEN
    RAISE NOTICE 'WARNING: more than one active event — the field apps cannot resolve which.';
  END IF;
END $$;
