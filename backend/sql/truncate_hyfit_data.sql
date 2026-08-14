-- ============================================================================
-- truncate_hyfit_data.sql
--
-- DESTRUCTIVE, NOT A MIGRATION. Deliberately unnumbered so it never enters the
-- 0NN migration chain. Deletes every row from every base table in the `hyfit`
-- schema EXCEPT `hyfit.users`. Structure is kept; only data goes.
--
-- ---------------------------------------------------------------------------
-- READ THIS BEFORE RUNNING -- two things are not obvious:
--
-- 1. CASCADE IS NOT OPTIONAL, AND IT LEAVES THE SCHEMA.
--    27 tables in `hyfit_judge` and `hyfitgames` hold foreign keys onto
--    `hyfit.events`. Truncating it necessarily truncates them too -- Postgres
--    rejects the statement outright otherwise. As of 2026-08-06 the cascade
--    reaches 40 tables / ~49,816 rows:
--
--      hyfit (12)       accounts, athletes, categories, category_entries,
--                       certificates, events, protests, registrations,
--                       results, splits, stations, teams
--      hyfit_judge (18) asset_assignments, audit_events,
--                       checkin_identity_exceptions, checkin_media,
--                       checkin_stage_records, checkin_station_assignments,
--                       checkin_stations, checkins, cognitive_attempts,
--                       event_configs, outbox_operations, participants,
--                       penalty_events, race_session_participants,
--                       race_sessions, race_splits, station_outcomes, sync_runs
--      hyfitgames (10)  announcements, certificates, import_batches, protests,
--                       registrations, results, splits, stations, teams,
--                       timing_raw
--
--    NOT touched (nothing references them, so the cascade never arrives):
--      hyfitgames.athletes, hyfitgames.otp_codes, hyfitgames.refresh_tokens,
--      hyfit_judge.sessions
--
-- 2. `hyfit.users` IS ITSELF A CHILD OF `hyfit.events`.
--    `hyfit_users_event_fk` (the interim staff->event link from 044) makes it a
--    cascade target, and TRUNCATE ... CASCADE empties a child table wholesale
--    regardless of its row values. So a plain
--        TRUNCATE hyfit.events, ... CASCADE
--    WIPES THE VERY TABLE YOU MEANT TO KEEP. This script drops that one FK,
--    NULLs `users.event_id` (the events it pointed at are about to stop
--    existing), truncates, then recreates the constraint verbatim.
--
--    AFTERWARDS: every field-staff account has event_id = NULL and must be
--    re-assigned to an event in the admin console before the judge apps scope
--    correctly. Logins still work (pin_hash/password_hash are untouched).
--
-- ---------------------------------------------------------------------------
-- Everything runs in ONE transaction: any failure rolls the whole thing back.
-- The DO block enumerates `hyfit` tables from the catalog at run time, so
-- tables added later are covered without editing this file.
--
-- Usage:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/sql/truncate_hyfit_data.sql
-- Target: the dev DB (novarace.ct2w2i0quq3x.ap-south-1.rds.amazonaws.com/dev)
--         -- the only database that has the hyfit schemas.
-- ============================================================================

BEGIN;

DO $$
DECLARE
    v_fk_name  CONSTANT text := 'hyfit_users_event_fk';
    v_fk_def   CONSTANT text := 'FOREIGN KEY (event_id) REFERENCES hyfit.events(id)';
    v_live_def text;
    v_tables   text;
    v_count    int;
    v_pinned   int;
    v_seq      record;
BEGIN
    RAISE NOTICE 'database = %, user = %', current_database(), current_user;

    IF to_regnamespace('hyfit') IS NULL THEN
        RAISE EXCEPTION 'schema `hyfit` does not exist in database % -- wrong target?',
                        current_database();
    END IF;

    -- ---- guard: the FK must be exactly what we intend to restore ----------
    SELECT pg_get_constraintdef(con.oid) INTO v_live_def
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'hyfit' AND c.relname = 'users' AND con.conname = v_fk_name;

    IF v_live_def IS NULL THEN
        RAISE EXCEPTION 'constraint %.% not found -- schema changed, review this script first',
                        'hyfit.users', v_fk_name;
    END IF;
    IF v_live_def <> v_fk_def THEN
        RAISE EXCEPTION 'constraint % is not what this script expects -- restoring it '
                        'verbatim would alter the schema. live: [%] expected: [%]',
                        v_fk_name, v_live_def, v_fk_def;
    END IF;

    -- ---- release the FK so `users` stops being a cascade target -----------
    EXECUTE format('ALTER TABLE hyfit.users DROP CONSTRAINT %I', v_fk_name);

    SELECT count(*) INTO v_pinned FROM hyfit.users WHERE event_id IS NOT NULL;
    UPDATE hyfit.users SET event_id = NULL WHERE event_id IS NOT NULL;
    RAISE NOTICE 'cleared event_id on % user(s) -- re-assign staff to an event afterwards', v_pinned;

    -- ---- truncate every hyfit base table except users --------------------
    SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname),
           count(*)
      INTO v_tables, v_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'hyfit'
      AND c.relkind = 'r'
      AND c.relname <> 'users';

    IF v_count = 0 THEN
        RAISE EXCEPTION 'no tables found in schema hyfit -- refusing to continue';
    END IF;

    RAISE NOTICE 'truncating % hyfit tables (+ cascade): %', v_count, v_tables;
    EXECUTE format('TRUNCATE TABLE %s RESTART IDENTITY CASCADE', v_tables);

    -- ---- restore the FK exactly as it was --------------------------------
    EXECUTE format('ALTER TABLE hyfit.users ADD CONSTRAINT %I %s', v_fk_name, v_fk_def);

    -- ---- reset sequences RESTART IDENTITY cannot see ---------------------
    -- RESTART IDENTITY only resets sequences OWNED by a truncated column.
    -- Hand-made ones (e.g. hyfit.athlete_code_seq, and hyfit.splits_id_seq from
    -- 053) keep their high-water mark unless reset explicitly.
    FOR v_seq IN
        SELECT n.nspname AS ns, c.relname AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'S'
          AND n.nspname = 'hyfit'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d
                          WHERE d.objid = c.oid AND d.deptype = 'a')
    LOOP
        EXECUTE format('ALTER SEQUENCE %I.%I RESTART', v_seq.ns, v_seq.name);
        RAISE NOTICE 'reset unowned sequence %.%', v_seq.ns, v_seq.name;
    END LOOP;

    -- ---- verify ----------------------------------------------------------
    SELECT count(*) INTO v_count FROM hyfit.users;
    IF v_count = 0 THEN
        RAISE EXCEPTION 'hyfit.users came out empty -- rolling back';
    END IF;
    RAISE NOTICE 'done: hyfit.users retained % rows', v_count;
END $$;

COMMIT;

-- ---------------------------------------------------------------------------
-- Post-run check: every hyfit table should read 0 except users.
-- ---------------------------------------------------------------------------
SELECT c.relname AS table_name,
       (xpath('/row/c/text()',
              query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname),
                           false, true, '')))[1]::text::bigint AS rows
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'hyfit' AND c.relkind = 'r'
ORDER BY c.relname;
