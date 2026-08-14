-- ============================================================================
-- hyfit_v2 — the field-operations schema, as one CREATE script.
--
-- This is the end state of migrations 080 and 082 flattened into a single
-- file, the way hyfit_schema.sql flattens the `hyfit` chain. Use this to stand
-- up a new database. Use the numbered files only to move an existing database
-- forward: 082 exists purely to bring a schema built by the FIRST version of
-- 080 up to this shape, and it has nothing to add to a schema created here.
--
-- Six tables, and the shape of them is the point:
--
--   * WHERE an event's RaceResult endpoints are, so the apps can find them;
--   * WHO our field staff are, so they can sign in;
--   * WHAT they did to this system's own configuration.
--
-- Participant and race data are deliberately absent. There is no participants
-- table, no start list, no check-in state, no splits, and no record of what
-- equipment was handed to whom: the counter reads an athlete from the event's
-- RaceResult feed at the moment it needs them, and writes the result back to
-- the same place. RaceResult carries the hand-over itself — `wristbandid`
-- alongside `wristbandidAssignedBy` and `stage1checkintime` — so a copy here
-- would be a second thing to keep in step. One store, one truth.
--
-- RELATIONSHIP TO `hyfit`. This schema does not read, write or reference the
-- `hyfit` schema, with two deliberate exceptions, both nullable pointers and
-- neither a foreign key:
--
--   events.platform_event_id  → hyfit.events(id)
--   users.platform_user_id    → hyfit.users(id)
--
-- They are how one real-world event or person is recognised on both sides.
-- They are NOT foreign keys because the two schemas are meant to be separable:
-- an event that is run in the field but never listed publicly has no platform
-- row at all, and a constraint would make that state unrepresentable. That is
-- also why this script stands on its own — it can be applied to a database
-- that has no `hyfit` schema at all.
--
-- The backend reaches these tables two ways, and both are already accounted
-- for: HjudgeDbService sets `search_path TO hyfit_v2,public` on every
-- connection and queries them unqualified, while the hyfitgames roster
-- importer names `hyfit_v2.raceresults_endpoints` explicitly across its own
-- `hyfit`-pinned pool.
--
-- Ordered by dependency: events → endpoints → users → sessions →
-- refresh_tokens → audit_events. Idempotent: safe to re-run.
--
--   psql -d hyfit_local -f sql/hyfit_v2_schema.sql
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS hyfit_v2;
-- gen_random_uuid() for every primary key below.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 1. Events
-- ============================================================================

-- --------------------------------------------------------------------- events
-- The operational event: the thing a crew turns up and runs. It carries no
-- public face — no city, no edition, no results status — because publishing an
-- event is the athlete platform's job and duplicating those columns here is how
-- two tables start disagreeing about the same race.
CREATE TABLE IF NOT EXISTS hyfit_v2.events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL
                       CONSTRAINT hyfit_v2_events_name_check CHECK (btrim(name) <> ''),
  venue              text,

  -- Every timestamp the field apps show an athlete is rendered in this zone,
  -- and RaceResult is written in it too — its time fields are local, not UTC.
  timezone           text NOT NULL DEFAULT 'Asia/Kolkata',
  starts_at          timestamptz,
  ends_at            timestamptz,

  -- The day the event runs, as a calendar date rather than an instant. The
  -- check-in window needs it: an athlete's slot is a wall-clock label ("6:00 PM
  -- - 8:00 PM") and needs a day to be anchored to. A multi-day event carries
  -- the day per athlete on RaceResult's ContestDate; this is the fallback for
  -- everyone without one, which on a single-day event is everyone.
  event_date         date,

  status             text NOT NULL DEFAULT 'draft'
                       CONSTRAINT hyfit_v2_events_status_check
                       CHECK (status IN ('draft','ready','live','closed','archived')),

  -- The single event the field apps are currently running. A tablet resolves
  -- "my event" through this when its operator is not bound to one.
  is_active          boolean NOT NULL DEFAULT false,

  -- The same event on the athlete platform, when it is also listed there.
  -- NULL = field-only. See the header for why this is not a foreign key.
  platform_event_id  uuid,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT hyfit_v2_events_window CHECK (
    starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);

-- Exactly one live operational event: two would make "which event is this
-- tablet on?" unanswerable.
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_v2_events_one_active
  ON hyfit_v2.events (is_active) WHERE is_active;
-- One field event per platform event, so the pointer resolves both ways.
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_v2_events_platform
  ON hyfit_v2.events (platform_event_id) WHERE platform_event_id IS NOT NULL;

COMMENT ON TABLE  hyfit_v2.events IS
  'One operational event, as run by the field crew. The public listing lives on the athlete platform.';
COMMENT ON COLUMN hyfit_v2.events.is_active IS
  'The single event the field apps are currently running. Enforced by hyfit_v2_events_one_active.';
COMMENT ON COLUMN hyfit_v2.events.platform_event_id IS
  'The same event in hyfit.events, when it is also listed publicly. NULL = field-only. Not an FK on purpose.';

-- ============================================================================
-- 2. RaceResult wiring
-- ============================================================================

-- ------------------------------------------------------ raceresults_endpoints
-- Where this event's RaceResult lives, and how to speak to it.
--
-- Versioned and draft-then-publish, because these URLs are the event: a typo in
-- one of them during a race does not fail loudly — `savevalue` answers HTTP 200
-- for a field name the event does not have — it silently discards check-ins.
-- Editing a live row in place is therefore the one operation this table exists
-- to prevent. The apps read the published row and nothing else.
--
-- THE URLS ARE CREDENTIALS. A RaceResult Custom API URL carries its own access
-- key inline; anyone holding the string can read the start list and write to
-- it. They must never reach a non-admin API response, a client bundle or a log
-- line. See `auth_token` below for the encryption decision still outstanding.
CREATE TABLE IF NOT EXISTS hyfit_v2.raceresults_endpoints (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              uuid NOT NULL REFERENCES hyfit_v2.events (id) ON DELETE CASCADE,
  version               integer NOT NULL
                          CONSTRAINT hyfit_v2_endpoints_version_check CHECK (version > 0),
  state                 text NOT NULL DEFAULT 'draft'
                          CONSTRAINT hyfit_v2_endpoints_state_check
                          CHECK (state IN ('draft','published','retired')),

  -- Bib lookup: called as `<bib_lookup_url>?bib={val}`. The parameter name is
  -- fixed because this one is known and in service today.
  bib_lookup_url        text NOT NULL DEFAULT '',

  -- The wristband -> BIB mapping table. Its own Custom API, and NOT derived
  -- from the bib endpoint: they share no base path.
  --
  -- Fetched WHOLE. It takes no query parameter — unlike the bib endpoint, there
  -- is no `?bib=` to give it — so the row is found in the app. That is what it
  -- is for: at Stage 2 the athlete presents the band issued at Stage 1, not a
  -- race number, and this is what turns one back into the other.
  map_lookup_url        text NOT NULL DEFAULT '',

  -- Write-back: `<update_url>?bib=&fieldname=&value=&nohistory=0`, GET, because
  -- a RaceResult Custom API answers POST with 405 whatever the API does.
  update_url            text NOT NULL DEFAULT '',

  -- Auth beyond what is already baked into the URLs. `none` is today's reality.
  auth_scheme           text NOT NULL DEFAULT 'none'
                          CONSTRAINT hyfit_v2_endpoints_auth_scheme_check
                          CHECK (auth_scheme IN ('none','header','query')),
  auth_param_name       text,
  -- PENDING a decision on storage. Left plaintext-capable for now and NOT
  -- populated by the admin console until that decision is made; the intended
  -- end state is pgcrypto with the key held outside the database. Whatever
  -- lands, this column must never be selected into an API response.
  auth_token            text,

  -- Our field key → RaceResult's spelling, for reads and writes respectively.
  -- Both may be left empty: the importer alias-matches `Bib`, `Contest`,
  -- `ContestID`, `TimeSlot`, `ContestDate` and `First Name`/`Lastname` unaided,
  -- so a standard RR14 export needs no mapping at all.
  participant_mapping   jsonb NOT NULL DEFAULT '{}'::jsonb,
  update_mapping        jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The counter's policy, versioned and published in the SAME row as the
  -- endpoints rather than in a table of its own. Publishing is one act — an
  -- endpoint change and the declaration an athlete is read are approved
  -- together, and two independently versioned rows would let a counter run a
  -- declaration nobody published against endpoints somebody did.
  declaration_text              text NOT NULL DEFAULT
    'I confirm that my participant details are correct and that I have received the assigned race equipment.',
  declaration_version           integer NOT NULL DEFAULT 1,

  -- The check-in window, relative to the athlete's timeslot. Off by default: an
  -- event that never sets it checks anyone in at any hour.
  checkin_window_enabled        boolean NOT NULL DEFAULT false,
  checkin_opens_before_minutes  integer NOT NULL DEFAULT 240
                                  CONSTRAINT hyfit_v2_endpoints_opens_check
                                  CHECK (checkin_opens_before_minutes BETWEEN 0 AND 10080),
  -- NULL = never closes, which is not the same as closing at the slot itself.
  checkin_closes_after_minutes  integer
                                  CONSTRAINT hyfit_v2_endpoints_closes_check
                                  CHECK (checkin_closes_after_minutes IS NULL
                                         OR checkin_closes_after_minutes BETWEEN 0 AND 10080),

  published_at          timestamptz,
  -- FK added after hyfit_v2.users exists; see the ALTER below that table.
  published_by          uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT hyfit_v2_endpoints_event_version UNIQUE (event_id, version),

  -- A published row must actually be usable. A draft may be half-filled while
  -- an admin is still typing; a published one with no participant endpoint is a
  -- counter that opens and then cannot find anybody.
  CONSTRAINT hyfit_v2_endpoints_published_is_usable CHECK (
    state <> 'published' OR (btrim(bib_lookup_url) <> '' AND btrim(update_url) <> '')),

  -- An auth scheme that names no parameter cannot be applied to a request.
  CONSTRAINT hyfit_v2_endpoints_auth_block CHECK (
    auth_scheme = 'none' OR btrim(COALESCE(auth_param_name, '')) <> '')
);

-- One published configuration per event. This is the constraint that makes
-- "the endpoints" a well-defined phrase at runtime.
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_v2_endpoints_one_published
  ON hyfit_v2.raceresults_endpoints (event_id) WHERE state = 'published';

COMMENT ON TABLE  hyfit_v2.raceresults_endpoints IS
  'Versioned RaceResult wiring for one event. The apps read the published row. The URLs carry their own access keys — treat every one of them as a secret.';
COMMENT ON COLUMN hyfit_v2.raceresults_endpoints.map_lookup_url IS
  'The equipment assignment table, fetched whole. The counters authority on what a BIB holds and who holds a code. Blank = check-in cannot run.';
COMMENT ON COLUMN hyfit_v2.raceresults_endpoints.auth_token IS
  'Secret for auth_scheme. Storage-at-rest decision outstanding; must never appear in an API response or a log.';

-- ============================================================================
-- 3. People and sessions
-- ============================================================================

-- ---------------------------------------------------------------------- users
-- Everyone who signs in to anything HYFIT operates: the judges and check-in
-- volunteers in the field, and the administrators in the console. One table,
-- one row per person, a role to tell them apart — because two tables would mean
-- two copies of every session, guard and audit path to keep in step.
--
-- TWO CREDENTIALS, one row. Field staff sign in with a staff ID and a PIN on a
-- tablet; console operators sign in with an email and a password in a browser.
-- A person may hold either or both, and holding both is one identity, not two:
-- an event admin who works a counter is the same human as the one who published
-- the endpoints, and the audit trail has to say so.
--
-- This is where the console's credential lives now. It was in hyfit.users; the
-- console cannot authenticate against a schema this system no longer has.
CREATE TABLE IF NOT EXISTS hyfit_v2.users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL
                      CONSTRAINT hyfit_v2_users_name_check CHECK (btrim(name) <> ''),

  -- Field credential. staff_id is stored upper-case, because the login
  -- upper-cases what is typed and a case difference must not be able to produce
  -- a second account.
  staff_id          text CONSTRAINT hyfit_v2_users_staff_id_key UNIQUE,
  pin_hash          text,

  -- Console credential. email lower-case, for the same reason.
  email             text CONSTRAINT hyfit_v2_users_email_key UNIQUE,
  password_hash     text,

  role              text NOT NULL
                      CONSTRAINT hyfit_v2_users_role_check
                      CHECK (role IN ('super_admin','event_admin','judge','checkin','readonly')),

  -- Event scope. NULL = global, which is a console operator; non-null is
  -- someone hired for one event, for whom every other event is a 403.
  event_id          uuid REFERENCES hyfit_v2.events (id) ON DELETE CASCADE,

  -- Which station on the course a judge is posted to. Per-event by nature — a
  -- station number means nothing outside one event — and nullable, because
  -- plenty of judges rove and every volunteer has none.
  station_number    integer
                      CONSTRAINT hyfit_v2_users_station_check
                      CHECK (station_number IS NULL OR station_number > 0),

  -- Which check-in stage this person staffs. The stage is a fact about the
  -- shift the person is working, so it lives on the person.
  --
  -- Permitted for admins as well as volunteers: an event_admin standing in at a
  -- desk is the Help Desk override.
  checkin_stage     text
                      CONSTRAINT hyfit_v2_users_checkin_stage_check
                      CHECK (checkin_stage IN ('STAGE_1_WRISTBAND','STAGE_2_TRANSPONDER')),

  -- The same person's row on the athlete platform, if they have one. Carried
  -- for provenance after the cutover; nothing authenticates through it. See the
  -- header for why it is not a foreign key.
  platform_user_id  uuid,

  enabled           boolean NOT NULL DEFAULT true,
  must_change_pin   boolean NOT NULL DEFAULT true,
  last_login_at     timestamptz,

  created_by        uuid REFERENCES hyfit_v2.users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- Each credential is all-or-nothing. A staff ID with no PIN is an account
  -- that looks fine in the team list and can never sign in; an email with no
  -- password is the same failure in the console.
  CONSTRAINT hyfit_v2_users_staff_credential_pair
    CHECK ((staff_id IS NULL) = (pin_hash IS NULL)),
  CONSTRAINT hyfit_v2_users_console_credential_pair
    CHECK ((email IS NULL) = (password_hash IS NULL)),

  -- Somebody has to be able to sign in as this row, one way or the other.
  CONSTRAINT hyfit_v2_users_has_credential
    CHECK (staff_id IS NOT NULL OR email IS NOT NULL),

  CONSTRAINT hyfit_v2_users_staff_id_upper
    CHECK (staff_id IS NULL OR staff_id = upper(staff_id)),
  CONSTRAINT hyfit_v2_users_email_lower
    CHECK (email IS NULL OR email = lower(email)),

  -- A judge with a counter stage is a data-entry slip that would put a judging
  -- account behind a check-in desk.
  CONSTRAINT hyfit_v2_users_stage_role CHECK (
    checkin_stage IS NULL OR role IN ('checkin','event_admin','super_admin'))
);

CREATE UNIQUE INDEX IF NOT EXISTS hyfit_v2_users_platform
  ON hyfit_v2.users (platform_user_id) WHERE platform_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hyfit_v2_users_event
  ON hyfit_v2.users (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hyfit_v2_users_role
  ON hyfit_v2.users (role) WHERE enabled;

COMMENT ON TABLE  hyfit_v2.users IS
  'Everyone who signs in: field staff by staff ID and PIN, console operators by email and password. One row per person, either credential or both.';
COMMENT ON COLUMN hyfit_v2.users.password_hash IS 'bcrypt, as written by the admin console';
COMMENT ON COLUMN hyfit_v2.users.checkin_stage IS
  'Rostering only: which shift this person is on, as the Team screen records it. It does not decide what they may hand over — a counter runs whichever hand-over the athlete in front of it is due, read from the equipment mapping table — so no sign-in or check-in consults this column. Volunteers created without one take STAGE_1_WRISTBAND.';
COMMENT ON COLUMN hyfit_v2.users.pin_hash IS
  'scrypt:<salt>:<hash>, produced by hjudge-session.util.ts hashPin()';

-- Deferred to here because the endpoints table is created before users and
-- references it. Guarded rather than plain ADD, since ADD CONSTRAINT has no
-- IF NOT EXISTS and this script is meant to be re-runnable.
ALTER TABLE hyfit_v2.raceresults_endpoints
  DROP CONSTRAINT IF EXISTS hyfit_v2_endpoints_published_by_fk;
ALTER TABLE hyfit_v2.raceresults_endpoints
  ADD CONSTRAINT hyfit_v2_endpoints_published_by_fk
  FOREIGN KEY (published_by) REFERENCES hyfit_v2.users (id) ON DELETE SET NULL;

-- ------------------------------------------------------------------- sessions
-- One signed-in device. `audience` keeps judging and check-in as two states a
-- tablet holds and loses separately, so a borrowed device can carry both and
-- signing out of one does not end the other.
CREATE TABLE IF NOT EXISTS hyfit_v2.sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES hyfit_v2.users (id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  audience      text NOT NULL
                  CONSTRAINT hyfit_v2_sessions_audience_check
                  CHECK (audience IN ('judge','checkin')),
  device_label  text,
  ip_address    text,
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hyfit_v2_sessions_user
  ON hyfit_v2.sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS hyfit_v2_sessions_audience
  ON hyfit_v2.sessions (audience, user_id) WHERE revoked_at IS NULL;

COMMENT ON TABLE hyfit_v2.sessions IS
  'One signed-in field device. Judge and check-in are separate audiences on the same tablet.';

-- ------------------------------------------------------------- refresh_tokens
-- The console's long-lived credential, rotated on every refresh.
--
-- Separate from `sessions` above because they are different things with
-- different lifetimes: a session is a signed-in tablet for twelve hours, this
-- is a browser that stays signed in for days and exchanges this token for a
-- short access token as it goes.
--
-- Console operators only. Athlete refresh tokens belong to the athlete platform
-- and stay there — they hang off an athlete, who is not a row in this schema
-- and is not going to become one.
CREATE TABLE IF NOT EXISTS hyfit_v2.refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES hyfit_v2.users (id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Every refresh is a lookup by hash.
CREATE INDEX IF NOT EXISTS hyfit_v2_refresh_tokens_hash
  ON hyfit_v2.refresh_tokens (token_hash);

COMMENT ON TABLE hyfit_v2.refresh_tokens IS
  'Console refresh tokens, rotated on use. Athlete tokens stay on the athlete platform.';

-- ============================================================================
-- 4. Our own actions
--
-- One table, and it holds nothing about an athlete.
--
-- There is deliberately no log of equipment handed over and no log of races
-- submitted. RaceResult records both — `wristbandid` with
-- `wristbandidAssignedBy` and `stage1checkintime`, and the timing and penalty
-- fields a judge submits — and a second copy here would be a second thing to
-- keep in step. Every time this system has held the same fact in two places it
-- has ended up reconciling them, so the fact lives in exactly one: RaceResult.
--
-- What remains is the part RaceResult has no view of at all — who our staff
-- are and what they did to this system's own configuration.
-- ============================================================================

-- --------------------------------------------------------------- audit_events
-- Everything else: logins, event edits, staff created and disabled, endpoints
-- published. event_id is nullable because a super_admin acting globally — or
-- signing in before any event exists — is not acting on one.
CREATE TABLE IF NOT EXISTS hyfit_v2.audit_events (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES hyfit_v2.users  (id) ON DELETE SET NULL,
  event_id    uuid REFERENCES hyfit_v2.events (id),
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hyfit_v2_audit_event_time
  ON hyfit_v2.audit_events (event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hyfit_v2_audit_actor_time
  ON hyfit_v2.audit_events (actor_id, created_at DESC);

COMMENT ON TABLE hyfit_v2.audit_events IS
  'What our staff did to this system''s own configuration. Nothing about an athlete lives here.';

COMMIT;

-- ============================================================================
-- Check:
--   \dt hyfit_v2.*
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'hyfit_v2' ORDER BY table_name;
--
-- Expected, in this order:
--   audit_events, events, raceresults_endpoints, refresh_tokens, sessions, users
--
-- Then seed a console super_admin with sql/seed_hyfit_v2_admin.sql, and see
-- sql/check_hyfit_v2.sql for the fuller verification pass.
-- ============================================================================
