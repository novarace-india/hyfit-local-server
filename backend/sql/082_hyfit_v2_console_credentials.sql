-- ============================================================================
-- 082: console credentials on hyfit_v2.users, for a schema already created.
--
-- 080 originally gave hyfit_v2.users the field credential only — a staff ID and
-- a PIN — because console operators were meant to keep authenticating against
-- hyfit.users and reach the field through platform_user_id. That was wrong for
-- any database whose `hyfit.users` does not exist: the console then has nothing
-- to authenticate against at all, and every login answers
--   relation "hyfit.users" does not exist
-- followed, once the query moved, by
--   column "email" does not exist
--
-- 080 now creates these columns itself. This migration is for a database that
-- ran the earlier version: `CREATE TABLE IF NOT EXISTS` will not add a column to
-- a table that already exists, so re-running 080 does nothing and the schema
-- stays half-built.
--
-- Bring a hyfit_v2 created by either version to the same place. Idempotent, and
-- a no-op on a schema created by the current 080.
--
-- Run 080 first if you have not; then this; then 081; then seed_hyfit_v2_admin.
-- ============================================================================

BEGIN;

-- ------------------------------------------------------- the console credential
ALTER TABLE hyfit_v2.users ADD COLUMN IF NOT EXISTS email         text;
ALTER TABLE hyfit_v2.users ADD COLUMN IF NOT EXISTS password_hash text;

-- A judge's post on the course. Missing from the first 080 by oversight while
-- the Team screen has always read and written it, so listUsers, createUser and
-- updateUser would all have failed on it.
ALTER TABLE hyfit_v2.users ADD COLUMN IF NOT EXISTS station_number integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hyfit_v2_users_station_check'
       AND conrelid = 'hyfit_v2.users'::regclass
  ) THEN
    ALTER TABLE hyfit_v2.users
      ADD CONSTRAINT hyfit_v2_users_station_check
      CHECK (station_number IS NULL OR station_number > 0);
  END IF;
END $$;

-- One account per address. Added as an index-backed constraint only if absent,
-- because ADD CONSTRAINT has no IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hyfit_v2_users_email_key'
       AND conrelid = 'hyfit_v2.users'::regclass
  ) THEN
    ALTER TABLE hyfit_v2.users
      ADD CONSTRAINT hyfit_v2_users_email_key UNIQUE (email);
  END IF;
END $$;

-- ------------------------------------------------------------- the constraints
-- The old shape:
--   hyfit_v2_users_credential_pair   (staff_id IS NULL) = (pin_hash IS NULL)
--   hyfit_v2_users_has_identity      staff_id IS NOT NULL OR platform_user_id IS NOT NULL
--
-- The new shape treats the two credentials symmetrically, and makes "can this
-- row sign in to anything?" the question rather than "is it linked to a row in
-- the schema we no longer read?".
DO $$
BEGIN
  -- Renamed, so drop the old name and add the new one. Dropped first: the two
  -- express the same rule and Postgres would happily hold both.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hyfit_v2_users_credential_pair'
       AND conrelid = 'hyfit_v2.users'::regclass
  ) THEN
    ALTER TABLE hyfit_v2.users DROP CONSTRAINT hyfit_v2_users_credential_pair;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hyfit_v2_users_staff_credential_pair'
       AND conrelid = 'hyfit_v2.users'::regclass
  ) THEN
    ALTER TABLE hyfit_v2.users
      ADD CONSTRAINT hyfit_v2_users_staff_credential_pair
      CHECK ((staff_id IS NULL) = (pin_hash IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hyfit_v2_users_console_credential_pair'
       AND conrelid = 'hyfit_v2.users'::regclass
  ) THEN
    ALTER TABLE hyfit_v2.users
      ADD CONSTRAINT hyfit_v2_users_console_credential_pair
      CHECK ((email IS NULL) = (password_hash IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hyfit_v2_users_email_lower'
       AND conrelid = 'hyfit_v2.users'::regclass
  ) THEN
    ALTER TABLE hyfit_v2.users
      ADD CONSTRAINT hyfit_v2_users_email_lower
      CHECK (email IS NULL OR email = lower(email));
  END IF;

  -- has_identity → has_credential. The old rule accepted a row whose only
  -- identity was a pointer into `hyfit`; the new one requires something you can
  -- actually sign in with.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hyfit_v2_users_has_identity'
       AND conrelid = 'hyfit_v2.users'::regclass
  ) THEN
    ALTER TABLE hyfit_v2.users DROP CONSTRAINT hyfit_v2_users_has_identity;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hyfit_v2_users_has_credential'
       AND conrelid = 'hyfit_v2.users'::regclass
  ) THEN
    -- Any row already there with neither credential would fail this. That can
    -- only be a console operator carried over as a bare pointer by an early
    -- 081, and it cannot sign in to anything as it stands, so it is reported
    -- rather than silently deleted or silently permitted.
    IF EXISTS (
      SELECT 1 FROM hyfit_v2.users
       WHERE staff_id IS NULL AND email IS NULL
    ) THEN
      RAISE EXCEPTION
        'hyfit_v2.users holds % row(s) with neither a staff ID nor an email. '
        'They cannot sign in to anything. Give them a credential or delete them, then re-run.',
        (SELECT count(*) FROM hyfit_v2.users WHERE staff_id IS NULL AND email IS NULL);
    END IF;

    ALTER TABLE hyfit_v2.users
      ADD CONSTRAINT hyfit_v2_users_has_credential
      CHECK (staff_id IS NOT NULL OR email IS NOT NULL);
  END IF;
END $$;

COMMENT ON TABLE  hyfit_v2.users IS
  'Everyone who signs in: field staff by staff ID and PIN, console operators by email and password. One row per person, either credential or both.';
COMMENT ON COLUMN hyfit_v2.users.password_hash IS 'bcrypt, as written by the admin console';

-- ------------------------------------------------------------ refresh_tokens
-- The console's long-lived credential. It could not live in hyfit.refresh_tokens
-- once the operator moved here: that table's admin_id references hyfit.users,
-- so every console login would have failed the foreign key one step after the
-- password check passed.
CREATE TABLE IF NOT EXISTS hyfit_v2.refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES hyfit_v2.users (id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hyfit_v2_refresh_tokens_hash
  ON hyfit_v2.refresh_tokens (token_hash);

COMMENT ON TABLE hyfit_v2.refresh_tokens IS
  'Console refresh tokens, rotated on use. Athlete tokens stay on the athlete platform.';

-- --------------------------------------------------------- the event day column
-- Also added to 080 after the fact: the check-in window anchors an athlete's
-- timeslot to a calendar day, and takes this as the fallback for anyone whose
-- ContestDate is blank — which on a single-day event is everyone.
ALTER TABLE hyfit_v2.events ADD COLUMN IF NOT EXISTS event_date date;

-- ------------------------------------------------------------ counter policy
-- The declaration and the check-in window are published in the SAME row as the
-- endpoints, so that an endpoint change and the declaration an athlete is read
-- are approved together. They were added to 080 after its first version, which
-- means a schema created from that version has the endpoints and none of the
-- policy — and `loadConfig` selects all of it in one statement, so a counter
-- would fail to open at all rather than fall back to a default.
ALTER TABLE hyfit_v2.raceresults_endpoints
  ADD COLUMN IF NOT EXISTS declaration_text text NOT NULL DEFAULT
    'I confirm that my participant details are correct and that I have received the assigned race equipment.';
ALTER TABLE hyfit_v2.raceresults_endpoints
  ADD COLUMN IF NOT EXISTS declaration_version integer NOT NULL DEFAULT 1;
ALTER TABLE hyfit_v2.raceresults_endpoints
  ADD COLUMN IF NOT EXISTS checkin_window_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE hyfit_v2.raceresults_endpoints
  ADD COLUMN IF NOT EXISTS checkin_opens_before_minutes integer NOT NULL DEFAULT 240;
-- NULL = never closes, which is not the same as closing at the slot itself.
ALTER TABLE hyfit_v2.raceresults_endpoints
  ADD COLUMN IF NOT EXISTS checkin_closes_after_minutes integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hyfit_v2_endpoints_opens_check'
       AND conrelid = 'hyfit_v2.raceresults_endpoints'::regclass
  ) THEN
    ALTER TABLE hyfit_v2.raceresults_endpoints
      ADD CONSTRAINT hyfit_v2_endpoints_opens_check
      CHECK (checkin_opens_before_minutes BETWEEN 0 AND 10080);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hyfit_v2_endpoints_closes_check'
       AND conrelid = 'hyfit_v2.raceresults_endpoints'::regclass
  ) THEN
    ALTER TABLE hyfit_v2.raceresults_endpoints
      ADD CONSTRAINT hyfit_v2_endpoints_closes_check
      CHECK (checkin_closes_after_minutes IS NULL
             OR checkin_closes_after_minutes BETWEEN 0 AND 10080);
  END IF;
END $$;

COMMIT;

-- Check:
--   \d hyfit_v2.users
--   SELECT count(*) FROM hyfit_v2.users WHERE email IS NOT NULL;

-- ============================================================================
-- Addendum: the map endpoint is a wristband -> BIB table, not a filtered query.
--
-- It was first modelled as a second Custom API called with a configurable query
-- parameter — `map_lookup_param`, and `map_lookup_key` for whether that
-- parameter carried a bib or a tag. That was wrong about what the endpoint is.
--
-- It is a TABLE. It takes no parameter, it is fetched whole, and the row is
-- found in the app. At Stage 2 the athlete presents the wristband issued at
-- Stage 1 — they are not carrying a race number — so the counter looks the band
-- up here to get a BIB, then asks the participant endpoint about that BIB for
-- everything else.
--
-- The two columns are dropped rather than left unused: an admin screen offering
-- a "query parameter" for an endpoint that takes none is a question with no
-- right answer.
-- ============================================================================

BEGIN;

ALTER TABLE hyfit_v2.raceresults_endpoints
  DROP CONSTRAINT IF EXISTS hyfit_v2_endpoints_map_block;
ALTER TABLE hyfit_v2.raceresults_endpoints
  DROP CONSTRAINT IF EXISTS hyfit_v2_endpoints_map_key_check;
ALTER TABLE hyfit_v2.raceresults_endpoints
  DROP COLUMN IF EXISTS map_lookup_param;
ALTER TABLE hyfit_v2.raceresults_endpoints
  DROP COLUMN IF EXISTS map_lookup_key;

-- Present on a schema created before the map endpoint existed at all.
ALTER TABLE hyfit_v2.raceresults_endpoints
  ADD COLUMN IF NOT EXISTS map_lookup_url text NOT NULL DEFAULT '';

COMMENT ON COLUMN hyfit_v2.raceresults_endpoints.map_lookup_url IS
  'The wristband -> BIB mapping table, fetched whole. Blank = Stage 2 counters cannot look anyone up.';

COMMIT;
