-- ============================================================================
-- hyfit_schema.sql — the `hyfit` schema as it stands after migrations 043–072
--
-- A flattened CREATE script: the end state of the schema merge, with no
-- backfills, no compatibility shims and no reference to `hyfitgames` or
-- `hyfit_judge` (both dropped before 061). Use it to stand up a fresh
-- database; use the numbered migrations to move an existing one.
--
-- Tables that existed at some point and are deliberately NOT here:
--   hyfit.teams      — dropped by 065; the club IS the team (see club_key())
--   hyfit.accounts   — dropped by 066; the account IS the athlete
--   participants     — a VIEW since 063, not a table
--
-- Ordered by dependency: events → users → the athlete spine → results →
-- sessions → field ops → views. Idempotent: safe to re-run.
--
-- Provenance is noted per object as (nnn) = the migration that last set it.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS hyfit;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

SET search_path TO hyfit, public;

-- ============================================================================
-- 1. Events and operators
-- ============================================================================

-- --------------------------------------------------------------------- events
-- One row per event, carrying two faces: the public race edition and the
-- operational event the field crew runs. A row may carry either or both. (045)
-- The registration window arrived with 056.
CREATE TABLE IF NOT EXISTS hyfit.events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,

  -- Public face. Travels as a block: an edition without a city is not a listing.
  status           text
                     CONSTRAINT hyfit_events_status_check
                     CHECK (status IN ('draft','upcoming','live','completed','cancelled')),
  results_status   text
                     CONSTRAINT hyfit_events_results_status_check
                     CHECK (results_status IN ('none','provisional','final')),
  city             text,
  edition          integer,
  event_date       date,
  protest_deadline timestamptz,

  -- Operational face. NULL ops_status = no record in the field-ops system;
  -- deliberately not defaulted to 'draft', which would claim the event is
  -- waiting to be run.
  ops_status       text
                     CONSTRAINT hyfit_events_ops_status_check
                     CHECK (ops_status IN ('draft','ready','live','closed','archived')),
  starts_at        timestamptz,
  ends_at          timestamptz,
  timezone         text NOT NULL DEFAULT 'Asia/Kolkata',
  is_active        boolean NOT NULL DEFAULT false,
  config_version   integer NOT NULL DEFAULT 1,

  venue            text,

  origin           text NOT NULL DEFAULT 'hyfit'
                     CONSTRAINT hyfit_events_origin_check
                     CHECK (origin IN ('hyfit','hyfit_judge','hyfitgames')),

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- Registration window (056). Per event, not per category.
  reg_opens_at     timestamptz,
  reg_closes_at    timestamptz,

  CONSTRAINT hyfit_events_public_block CHECK (
    (status IS NULL) = (results_status IS NULL)
    AND (status IS NULL) = (city IS NULL)
    AND (status IS NULL) = (edition IS NULL)
    AND (status IS NULL) = (event_date IS NULL)),

  -- An event with neither face is a row nothing can ever read.
  CONSTRAINT hyfit_events_has_face CHECK (
    status IS NOT NULL OR ops_status IS NOT NULL),

  CONSTRAINT hyfit_events_active_needs_ops CHECK (
    NOT is_active OR ops_status IS NOT NULL),

  -- A window that closes before it opens would silently reject every entry.
  CONSTRAINT hyfit_events_reg_window CHECK (
    reg_opens_at IS NULL OR reg_closes_at IS NULL OR reg_closes_at > reg_opens_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS hyfit_events_city_edition
  ON hyfit.events (city, edition) WHERE city IS NOT NULL;
-- Exactly one live operational event.
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_events_one_active
  ON hyfit.events (is_active) WHERE is_active;
CREATE INDEX IF NOT EXISTS hyfit_events_date
  ON hyfit.events (event_date DESC) WHERE event_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS hyfit_events_ops
  ON hyfit.events (ops_status) WHERE ops_status IS NOT NULL;

COMMENT ON TABLE  hyfit.events IS
  'Unified HYFIT event: the public race edition and the operational event. A row carries either face or both.';
COMMENT ON COLUMN hyfit.events.status IS
  'Public/publication lifecycle. NULL = not publicly listed.';
COMMENT ON COLUMN hyfit.events.ops_status IS
  'Field-operations lifecycle. NULL = no operational record.';
COMMENT ON COLUMN hyfit.events.is_active IS
  'The single event the field apps are currently running. Enforced by hyfit_events_one_active.';
COMMENT ON COLUMN hyfit.events.config_version IS
  'RaceResult integration config counter, operational only.';
COMMENT ON COLUMN hyfit.events.reg_closes_at IS
  'When entries close. NULL = no window recorded; the app must not infer "open" from NULL.';

-- ---------------------------------------------------------------------- users
-- One identity per HYFIT operator: field staff (staff_id + PIN) and console
-- admins (email + password). A person can carry either credential or both. (043/044/045)
CREATE TABLE IF NOT EXISTS hyfit.users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,

  -- Field-ops credential; staff_id stored upper-case (the login upper-cases it).
  staff_id         text CONSTRAINT hyfit_users_staff_id_key UNIQUE,
  pin_hash         text,

  -- Console credential; email stored lower-case, for the same reason.
  email            text CONSTRAINT hyfit_users_email_key UNIQUE,
  password_hash    text,

  role             text NOT NULL
                     CONSTRAINT hyfit_users_role_check
                     CHECK (role IN ('super_admin','event_admin','checkin','judge','readonly')),

  -- Event scope; NULL = global. Superseded by hyfit.user_events (060) but not
  -- dropped — the judge auth/admin services still read it.
  event_id         uuid CONSTRAINT hyfit_users_event_fk REFERENCES hyfit.events (id),
  station_number   integer,

  enabled          boolean NOT NULL DEFAULT true,
  must_change_pin  boolean NOT NULL DEFAULT true,
  last_login_at    timestamptz,

  origin           text NOT NULL DEFAULT 'hyfit'
                     CONSTRAINT hyfit_users_origin_check
                     CHECK (origin IN ('hyfit','hyfit_judge','hyfitgames')),
  legacy_role      text,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- Each credential is all-or-nothing: a staff ID with no PIN is an account
  -- that looks fine in the team list and can never sign in.
  CONSTRAINT hyfit_users_staff_credential_pair
    CHECK ((staff_id IS NULL) = (pin_hash IS NULL)),
  CONSTRAINT hyfit_users_console_credential_pair
    CHECK ((email IS NULL) = (password_hash IS NULL)),
  CONSTRAINT hyfit_users_has_credential
    CHECK (staff_id IS NOT NULL OR email IS NOT NULL),

  CONSTRAINT hyfit_users_staff_id_upper
    CHECK (staff_id IS NULL OR staff_id = upper(staff_id)),
  CONSTRAINT hyfit_users_email_lower
    CHECK (email IS NULL OR email = lower(email))
);

CREATE INDEX IF NOT EXISTS hyfit_users_event ON hyfit.users (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hyfit_users_role  ON hyfit.users (role) WHERE enabled;

COMMENT ON TABLE  hyfit.users IS
  'Unified HYFIT operator identity: field staff (staff_id + PIN) and console admins (email + password).';
COMMENT ON COLUMN hyfit.users.pin_hash IS 'scrypt:<salt>:<hash>, produced by hjudge-session.util.ts hashPin()';
COMMENT ON COLUMN hyfit.users.password_hash IS 'bcrypt, as written by the admin console';
COMMENT ON COLUMN hyfit.users.event_id IS
  'Event scope; NULL = global. Duplicated by hyfit.user_events — see 060.';

-- ---------------------------------------------------------------- user_events
-- Many-to-many crew assignment: a judge can work several events, an event has
-- a whole crew. A super_admin is global and needs NO rows here. (060)
CREATE TABLE IF NOT EXISTS hyfit.user_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id         uuid NOT NULL REFERENCES hyfit.users  (id) ON DELETE CASCADE,
  event_id        uuid NOT NULL REFERENCES hyfit.events (id) ON DELETE CASCADE,

  -- NULL = inherit users.role. Same vocabulary, so a per-event override can
  -- never introduce a role the guards do not know.
  role            text CHECK (role IN ('super_admin','event_admin','checkin','judge','readonly')),

  -- Per-event: a station number means nothing outside one event.
  station_number  integer CHECK (station_number IS NULL OR station_number > 0),

  -- Suspend one assignment without touching the user's global `enabled`.
  enabled         boolean NOT NULL DEFAULT true,
  is_primary      boolean NOT NULL DEFAULT false,

  assigned_by     uuid REFERENCES hyfit.users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT hyfit_user_events_unique UNIQUE (user_id, event_id)
);

CREATE INDEX IF NOT EXISTS hyfit_user_events_event_idx
  ON hyfit.user_events (event_id) WHERE enabled;
-- At most one primary event per user.
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_user_events_one_primary_idx
  ON hyfit.user_events (user_id) WHERE is_primary;

-- ============================================================================
-- 2. The athlete spine: athletes → registrations → category_entries
-- ============================================================================

-- ----------------------------------------------------------------- categories
-- A category is a row, not a string: it carries eligibility, pricing and caps. (056)
CREATE TABLE IF NOT EXISTS hyfit.categories (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES hyfit.events (id) ON DELETE CASCADE,

  name           text NOT NULL
                   CONSTRAINT hyfit_categories_name_check CHECK (btrim(name) <> ''),

  -- How many people make one entry. Drives the partner/team flow.
  format         text NOT NULL DEFAULT 'singles'
                   CONSTRAINT hyfit_categories_format_check
                   CHECK (format IN ('singles','doubles','mixed_doubles','team')),

  -- NULL = not yet decided by an admin, NOT "anyone may enter".
  gender_rule    text
                   CONSTRAINT hyfit_categories_gender_rule_check
                   CHECK (gender_rule IN ('men','women','mixed','open')),

  -- Inclusive, evaluated against the athlete's age on event_date.
  min_age        smallint
                   CONSTRAINT hyfit_categories_min_age_check CHECK (min_age BETWEEN 0 AND 120),
  max_age        smallint
                   CONSTRAINT hyfit_categories_max_age_check CHECK (max_age BETWEEN 0 AND 120),

  team_size_min  smallint NOT NULL DEFAULT 1
                   CONSTRAINT hyfit_categories_team_min_check CHECK (team_size_min BETWEEN 1 AND 8),
  team_size_max  smallint NOT NULL DEFAULT 1
                   CONSTRAINT hyfit_categories_team_max_check CHECK (team_size_max BETWEEN 1 AND 8),

  price_inr      numeric(10,2)
                   CONSTRAINT hyfit_categories_price_check CHECK (price_inr >= 0),
  entry_cap      integer
                   CONSTRAINT hyfit_categories_cap_check CHECK (entry_cap > 0),

  -- Opaque bucket ('SAT_AM'); two categories sharing one clash for an athlete.
  schedule_block text
                   CONSTRAINT hyfit_categories_block_check
                   CHECK (schedule_block IS NULL OR btrim(schedule_block) <> ''),

  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT hyfit_categories_age_order CHECK (
    min_age IS NULL OR max_age IS NULL OR min_age <= max_age),
  CONSTRAINT hyfit_categories_team_order CHECK (team_size_min <= team_size_max),

  -- Format and sizes must agree, or the partner flow and the scoring rule
  -- disagree about how many people a finish needs.
  CONSTRAINT hyfit_categories_format_sizes CHECK (
    CASE format
      WHEN 'singles'       THEN team_size_min = 1 AND team_size_max = 1
      WHEN 'doubles'       THEN team_size_min = 2 AND team_size_max = 2
      WHEN 'mixed_doubles' THEN team_size_min = 2 AND team_size_max = 2
      WHEN 'team'          THEN team_size_max >= 2
    END),

  CONSTRAINT hyfit_categories_event_name UNIQUE (event_id, name),
  -- Target for the composite FKs on entries.
  CONSTRAINT hyfit_categories_identity UNIQUE (id, event_id)
);

CREATE INDEX IF NOT EXISTS hyfit_categories_event ON hyfit.categories (event_id);
CREATE INDEX IF NOT EXISTS hyfit_categories_block ON hyfit.categories (event_id, schedule_block)
  WHERE schedule_block IS NOT NULL;

COMMENT ON TABLE  hyfit.categories IS
  'One competable category at one event. Pricing, caps and eligibility are admin-set — see hyfit.category_setup_gaps.';
COMMENT ON COLUMN hyfit.categories.gender_rule IS
  'Eligibility gate. NULL means undecided, NOT open — do not treat NULL as permissive.';
COMMENT ON COLUMN hyfit.categories.schedule_block IS
  'Opaque scheduling bucket. Two categories sharing a value clash for one athlete.';

-- ------------------------------------------------------------------- athletes
-- One human, and their login. The profile is stored once. (057, merged with
-- the former `accounts` table by 066.)
CREATE SEQUENCE IF NOT EXISTS hyfit.athlete_code_seq;

CREATE TABLE IF NOT EXISTS hyfit.athletes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Human-readable and permanent: survives a merge, a number change and a
  -- transfer, which is why partner search and printed material use it.
  athlete_code      text NOT NULL DEFAULT
                      'HYF-' || to_char(now(), 'YYYY') || '-' ||
                      lpad(nextval('hyfit.athlete_code_seq')::text, 5, '0'),

  full_name         text NOT NULL
                      CONSTRAINT hyfit_athletes_name_check CHECK (btrim(full_name) <> ''),
  email             text
                      CONSTRAINT hyfit_athletes_email_check
                      CHECK (email = lower(email) AND email LIKE '_%@_%._%'),
  dob               date
                      CONSTRAINT hyfit_athletes_dob_check
                      CHECK (dob > date '1900-01-01' AND dob < current_date),
  gender            text
                      CONSTRAINT hyfit_athletes_gender_check
                      CHECK (gender IN ('male','female','other')),
  city              text,
  state             text,
  emergency_name    text,
  emergency_phone   text
                      CONSTRAINT hyfit_athletes_emergency_phone_check
                      CHECK (emergency_phone ~ '^[0-9]{10,15}$'),
  blood_group       text
                      CONSTRAINT hyfit_athletes_blood_group_check
                      CHECK (blood_group IN ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
  tshirt_size       text
                      CONSTRAINT hyfit_athletes_tshirt_size_check
                      CHECK (tshirt_size IN ('XS','S','M','L','XL','XXL','XXXL')),
  photo_url         text,

  -- RaceResult's person id: the only key for someone who has never signed in.
  person_source_id  text,

  -- A minor, or anyone without their own phone, riding on another's number.
  is_managed        boolean NOT NULL DEFAULT false,

  claim_status      text NOT NULL DEFAULT 'unclaimed'
                      CONSTRAINT hyfit_athletes_claim_status_check
                      CHECK (claim_status IN ('claimed','unclaimed','pending_verification')),

  -- Tombstone: after a duplicate is merged away its id keeps resolving, so old
  -- leaderboard and certificate links do not 404.
  merged_into       uuid REFERENCES hyfit.athletes (id),

  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  profile_complete  boolean GENERATED ALWAYS AS (
                      gender IS NOT NULL AND dob IS NOT NULL
                      AND emergency_phone IS NOT NULL AND city IS NOT NULL
                    ) STORED,

  -- Was hyfit.accounts, folded in by 066. mobile is NOT unique on purpose.
  mobile            text
                      CONSTRAINT hyfit_athletes_mobile_check
                      CHECK (mobile ~ '^[0-9]{10,15}$'),
  created_via       text NOT NULL DEFAULT 'csv_import'
                      CONSTRAINT hyfit_athletes_created_via_check
                      CHECK (created_via IN ('self_signup','csv_import','support')),
  last_login_at     timestamptz,

  CONSTRAINT hyfit_athletes_code_unique UNIQUE (athlete_code),

  -- An emergency number nobody can be asked for by name is not a contact.
  CONSTRAINT hyfit_athletes_emergency_block CHECK (
    (emergency_name IS NULL) = (emergency_phone IS NULL)),

  -- Somebody has to be able to find this person: a number they answer on, or
  -- the timing system that put them on a start list.
  CONSTRAINT hyfit_athletes_identity CHECK (
    mobile IS NOT NULL OR person_source_id IS NOT NULL),

  -- Claimed means exactly "has a number".
  CONSTRAINT hyfit_athletes_claim_agrees CHECK (
    (claim_status = 'claimed') = (mobile IS NOT NULL)),

  CONSTRAINT hyfit_athletes_merge_not_self CHECK (merged_into IS DISTINCT FROM id)
);

CREATE INDEX IF NOT EXISTS hyfit_athletes_source ON hyfit.athletes (person_source_id)
  WHERE person_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hyfit_athletes_merged ON hyfit.athletes (merged_into)
  WHERE merged_into IS NOT NULL;
-- Non-unique: this answers "who is on this number" for the login picker, and
-- there may be more than one answer.
CREATE INDEX IF NOT EXISTS hyfit_athletes_mobile ON hyfit.athletes (mobile)
  WHERE mobile IS NOT NULL;

COMMENT ON TABLE  hyfit.athletes IS
  'One human, and their login. The mobile number lives here and is NOT unique: a shared phone means several athletes, and OTP lists them.';
COMMENT ON COLUMN hyfit.athletes.mobile IS
  'The number that signs in. NOT unique — a family shares a phone.';
COMMENT ON COLUMN hyfit.athletes.created_via IS
  'How this profile first appeared: self_signup | csv_import | support.';
COMMENT ON COLUMN hyfit.athletes.last_login_at IS 'Last successful OTP login as this athlete.';
COMMENT ON COLUMN hyfit.athletes.merged_into IS
  'Set when this profile was merged into another; the row is kept so old ids keep resolving.';

-- -------------------------------------------------------------- registrations
-- One athlete at one event. Categories hang beneath it as entries. (057, 066)
CREATE TABLE IF NOT EXISTS hyfit.registrations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id     uuid NOT NULL REFERENCES hyfit.athletes (id) ON DELETE CASCADE,
  event_id       uuid NOT NULL REFERENCES hyfit.events   (id) ON DELETE CASCADE,

  status         text NOT NULL DEFAULT 'active'
                   CONSTRAINT hyfit_registrations_status_check
                   CHECK (status IN ('active','withdrawn')),

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- Who did the registering — a parent, a coach, the athlete themselves.
  registered_by  uuid CONSTRAINT hyfit_registrations_registered_by_fk
                   REFERENCES hyfit.athletes (id) ON DELETE SET NULL,

  CONSTRAINT hyfit_registrations_athlete_event UNIQUE (athlete_id, event_id),
  -- Target for the entries' composite FK, pinning an entry's denormalised
  -- event_id to its registration's.
  CONSTRAINT hyfit_registrations_identity UNIQUE (id, event_id)
);

CREATE INDEX IF NOT EXISTS hyfit_registrations_event   ON hyfit.registrations (event_id);
CREATE INDEX IF NOT EXISTS hyfit_registrations_athlete ON hyfit.registrations (athlete_id);
CREATE INDEX IF NOT EXISTS hyfit_registrations_registered_by
  ON hyfit.registrations (registered_by) WHERE registered_by IS NOT NULL;

COMMENT ON TABLE  hyfit.registrations IS
  'One athlete at one event. Withdrawing a category does not touch this row.';
COMMENT ON COLUMN hyfit.registrations.registered_by IS
  'The athlete who made this registration — a parent, a coach, or the athlete themselves.';

-- ------------------------------------------------------------- the club "key"
-- The team key. IMMUTABLE so it can be indexed, and byte-identical to the
-- expression the index below is built on. Same normalisation the judge apps
-- have always applied. (065)
CREATE OR REPLACE FUNCTION hyfit.club_key(club text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT lower(regexp_replace(btrim(COALESCE(club, '')), '\s+', ' ', 'g'))
$$;

COMMENT ON FUNCTION hyfit.club_key(text) IS
  'Normalised club, and therefore the team key: lower-cased, trimmed, whitespace collapsed. Two entries in one group-format category with the same club_key are the same team.';

-- ---------------------------------------------------------- category_entries
-- One athlete in one category at one event — a bib. This is the row the whole
-- field module calls a "participant" and the results spine keys off. (052 as
-- `athletes`, renamed and re-hung by 057, team_id removed by 065.)
CREATE TABLE IF NOT EXISTS hyfit.category_entries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  event_id             uuid NOT NULL REFERENCES hyfit.events (id) ON DELETE CASCADE,
  bib                  text NOT NULL
                         CONSTRAINT hyfit_category_entries_bib_check CHECK (bib ~ '^[0-9]+$'),
  wave                 text,
  -- When that wave is on the floor, as the organiser writes it ("09:40",
  -- "Slot 3"). A label, not a timestamp — start_time below is the timestamptz
  -- the results spine uses. (070)
  timeslot             text,
  -- Which DAY that slot is on (RaceResult ContestDate). NULL = the event's own
  -- event_date, which is all a single-day event ever needs. (072)
  contest_date         date,
  -- The gym/box/squad this entry races for — and, in a category with
  -- team_size_max > 1, the team it scores with (065).
  club                 text,

  -- Race outcome: what happened on the course.
  race_status          text
                         CONSTRAINT hyfit_category_entries_race_status_check
                         CHECK (race_status IN ('REG','DNS','DNF','DQ','FIN')),
  start_time           timestamptz,

  -- Operational face: on a RaceResult start list, run by the field apps.
  checkin_state        text
                         CONSTRAINT hyfit_category_entries_checkin_state_check
                         CHECK (checkin_state IN ('not_checked_in','checked_in','pending_sync','conflict')),
  entry_source_id      text,
  contest_id           text,
  source_status        text,
  source_data          jsonb,
  last_source_sync_at  timestamptz,

  -- Where this row came from: roster = an imported CSV/Excel file (073),
  -- raceresult = a participant-endpoint pull, hyfit = entered by hand.
  origin               text NOT NULL DEFAULT 'hyfit'
                         CONSTRAINT hyfit_category_entries_origin_check
                         CHECK (origin IN ('hyfitgames','hyfit_judge','hyfit','raceresult','roster')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  category_id          uuid,
  registration_id      uuid NOT NULL,

  -- Entry lifecycle, a different axis from race_status.
  entry_status         text NOT NULL DEFAULT 'pending_payment'
                         CONSTRAINT hyfit_category_entries_entry_status_check
                         CHECK (entry_status IN ('pending_payment','pending_partner','confirmed',
                                                 'waitlisted','withdrawn','disqualified')),
  seed                 integer
                         CONSTRAINT hyfit_category_entries_seed_check
                         CHECK (seed IS NULL OR seed > 0),

  -- How the person got to this event: registered on the platform, or arrived
  -- on a start list. Neither means a bib belonging to nobody's entry.
  CONSTRAINT hyfit_category_entries_has_face CHECK (
    race_status IS NOT NULL OR checkin_state IS NOT NULL),
  CONSTRAINT hyfit_category_entries_operational_block CHECK (
    (checkin_state IS NULL) = (source_status IS NULL)
    AND (checkin_state IS NULL) = (source_data IS NULL)),

  -- Composite on purpose: an entry cannot sit in another event's category, and
  -- its own event_id can never drift from its registration's.
  CONSTRAINT hyfit_category_entries_category_fk
    FOREIGN KEY (category_id, event_id) REFERENCES hyfit.categories (id, event_id),
  CONSTRAINT hyfit_category_entries_registration_fk
    FOREIGN KEY (registration_id, event_id)
    REFERENCES hyfit.registrations (id, event_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS hyfit_category_entries_event_bib
  ON hyfit.category_entries (event_id, bib);
-- One entry per category per registration.
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_category_entries_registration_category
  ON hyfit.category_entries (registration_id, category_id);
CREATE INDEX IF NOT EXISTS hyfit_category_entries_event        ON hyfit.category_entries (event_id);
CREATE INDEX IF NOT EXISTS hyfit_category_entries_registration ON hyfit.category_entries (registration_id);
CREATE INDEX IF NOT EXISTS hyfit_category_entries_category     ON hyfit.category_entries (category_id)
  WHERE category_id IS NOT NULL;
-- Every group read is "the other entries in my category with my club".
CREATE INDEX IF NOT EXISTS hyfit_category_entries_club_key
  ON hyfit.category_entries (category_id, hyfit.club_key(club))
  WHERE hyfit.club_key(club) <> '';

COMMENT ON TABLE  hyfit.category_entries IS
  'One athlete in one category at one event (was hyfit.athletes in 052). The profile lives on hyfit.athletes, reached through registration_id.';
COMMENT ON COLUMN hyfit.category_entries.race_status IS
  'What happened on the course (REG/DNS/DNF/DQ/FIN). Distinct from entry_status.';
COMMENT ON COLUMN hyfit.category_entries.entry_status IS
  'Entry lifecycle: paid for, waiting on a partner, withdrawn.';
COMMENT ON COLUMN hyfit.category_entries.club IS
  'The gym, box or squad this entry races for — and, in a category with team_size_max > 1, the team it scores with.';

-- ============================================================================
-- 3. Results
-- ============================================================================

-- ------------------------------------------------------------------- stations
CREATE TABLE IF NOT EXISTS hyfit.stations (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id  uuid NOT NULL REFERENCES hyfit.events (id) ON DELETE CASCADE,
  seq       integer NOT NULL
              CONSTRAINT hyfit_stations_seq_check CHECK (seq > 0),
  name      text NOT NULL
              CONSTRAINT hyfit_stations_name_check CHECK (btrim(name) <> '')
);

-- The course is an ordered list, so a position cannot be occupied twice.
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_stations_event_seq
  ON hyfit.stations (event_id, seq);

COMMENT ON TABLE hyfit.stations IS 'The ordered stations making up an event''s course.';

-- -------------------------------------------------------------------- results
-- One finish per entry. (053, team columns from 054, re-keyed to the club by 065.)
CREATE TABLE IF NOT EXISTS hyfit.results (
  entry_id        uuid PRIMARY KEY
                    REFERENCES hyfit.category_entries (id) ON DELETE CASCADE,

  total_ms        integer
                    CONSTRAINT hyfit_results_total_ms_check CHECK (total_ms > 0),

  -- Placings are 1-based; nullable because a result can be computed before the
  -- field is complete, but a rank of 0 has no meaning.
  overall_rank    integer CONSTRAINT hyfit_results_overall_rank_check   CHECK (overall_rank > 0),
  gender_rank     integer CONSTRAINT hyfit_results_gender_rank_check    CHECK (gender_rank > 0),
  age_group       text    CONSTRAINT hyfit_results_age_group_check      CHECK (btrim(age_group) <> ''),
  age_group_rank  integer CONSTRAINT hyfit_results_age_group_rank_check CHECK (age_group_rank > 0),

  computed_at     timestamptz NOT NULL DEFAULT now(),

  team_total_ms   integer,
  team_rank       integer,

  -- An age-group placing without the group it was placed in cannot be
  -- displayed or recomputed, so the pair travels together.
  CONSTRAINT hyfit_results_age_group_block CHECK (
    (age_group IS NULL) = (age_group_rank IS NULL)),

  -- A rank with no time behind it is a placing nobody earned.
  CONSTRAINT hyfit_results_team_block CHECK (
    team_total_ms IS NOT NULL OR team_rank IS NULL),
  CONSTRAINT hyfit_results_team_ms_check   CHECK (team_total_ms IS NULL OR team_total_ms > 0),
  CONSTRAINT hyfit_results_team_rank_check CHECK (team_rank IS NULL OR team_rank > 0)
);

CREATE INDEX IF NOT EXISTS hyfit_results_overall_rank
  ON hyfit.results (overall_rank) WHERE overall_rank IS NOT NULL;

COMMENT ON TABLE  hyfit.results IS
  'One finish per entry: elapsed time and placings.';
COMMENT ON COLUMN hyfit.results.overall_rank IS
  'Placing WITHIN this entry''s category, not across the event (054).';
COMMENT ON COLUMN hyfit.results.team_total_ms IS
  'The team''s finish: the LATEST of its members'' totals, where a team is the entries sharing a club inside one group-format category. NULL until every member has finished.';
COMMENT ON COLUMN hyfit.results.team_rank IS
  'The team''s placing within its category. NULL when the entry is not in a team, or the team is not yet complete.';

-- --------------------------------------------------------------------- splits
-- The platform's computed per-station leg. NOT race_splits (063). (053)
CREATE TABLE IF NOT EXISTS hyfit.splits (
  id           bigint PRIMARY KEY,

  entry_id     uuid NOT NULL REFERENCES hyfit.category_entries (id) ON DELETE CASCADE,
  station_id   uuid NOT NULL REFERENCES hyfit.stations         (id) ON DELETE CASCADE,

  split_ms     integer NOT NULL
                 CONSTRAINT hyfit_splits_split_ms_check CHECK (split_ms > 0),
  -- Whatever the timing source sent, kept verbatim next to the parsed value so
  -- a bad parse can be re-read rather than guessed at.
  split_raw    text,
  source       text NOT NULL
                 CONSTRAINT hyfit_splits_source_check
                 CHECK (source IN ('manual','raceresult','chip','backup')),
  recorded_at  timestamptz NOT NULL DEFAULT now()
);

-- One time per entry per station: a second reading is a correction, not
-- another split.
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_splits_entry_station
  ON hyfit.splits (entry_id, station_id);
CREATE INDEX IF NOT EXISTS hyfit_splits_entry ON hyfit.splits (entry_id);

CREATE SEQUENCE IF NOT EXISTS hyfit.splits_id_seq OWNED BY hyfit.splits.id;
ALTER TABLE hyfit.splits ALTER COLUMN id SET DEFAULT nextval('hyfit.splits_id_seq');

COMMENT ON TABLE hyfit.splits IS 'One recorded time per entry per station.';

-- --------------------------------------------------------------- certificates
CREATE TABLE IF NOT EXISTS hyfit.certificates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  entry_id    uuid NOT NULL REFERENCES hyfit.category_entries (id) ON DELETE CASCADE,

  type        text NOT NULL DEFAULT 'participation'
                CONSTRAINT hyfit_certificates_type_check
                CHECK (type IN ('participation','podium','finisher')),

  -- The verifiable number printed on the document.
  serial      text NOT NULL
                CONSTRAINT hyfit_certificates_serial_check CHECK (btrim(serial) <> ''),

  pdf_url     text,
  issued_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT hyfit_certificates_serial_unique UNIQUE (serial),
  -- One certificate of a given type per entry: an athlete can hold both a
  -- finisher and a podium certificate for the same race.
  CONSTRAINT hyfit_certificates_entry_type UNIQUE (entry_id, type)
);

CREATE INDEX IF NOT EXISTS hyfit_certificates_entry ON hyfit.certificates (entry_id);

COMMENT ON TABLE  hyfit.certificates IS 'Certificates issued against an entry.';
COMMENT ON COLUMN hyfit.certificates.pdf_url IS
  'Stored artefact, or NULL to render on demand (the current behaviour).';

-- ------------------------------------------------------------------- protests
CREATE TABLE IF NOT EXISTS hyfit.protests (
  id           bigint PRIMARY KEY,

  entry_id     uuid NOT NULL REFERENCES hyfit.category_entries (id) ON DELETE CASCADE,

  message      text NOT NULL
                 CONSTRAINT hyfit_protests_message_check CHECK (btrim(message) <> ''),

  status       text NOT NULL DEFAULT 'open'
                 CONSTRAINT hyfit_protests_status_check
                 CHECK (status IN ('open','resolved','rejected')),

  response     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,

  -- An open protest has not been resolved, and a closed one was resolved at
  -- some point — the admin queue sorts on exactly this column.
  CONSTRAINT hyfit_protests_resolution_block CHECK (
    (status = 'open') = (resolved_at IS NULL)),
  CONSTRAINT hyfit_protests_resolution_order CHECK (
    resolved_at IS NULL OR resolved_at >= created_at)
);

CREATE INDEX IF NOT EXISTS hyfit_protests_entry ON hyfit.protests (entry_id);
-- The admin queue reads open protests oldest-first.
CREATE INDEX IF NOT EXISTS hyfit_protests_open
  ON hyfit.protests (created_at) WHERE status = 'open';

CREATE SEQUENCE IF NOT EXISTS hyfit.protests_id_seq OWNED BY hyfit.protests.id;
ALTER TABLE hyfit.protests ALTER COLUMN id SET DEFAULT nextval('hyfit.protests_id_seq');

COMMENT ON TABLE hyfit.protests IS 'An athlete disputing their result. Keyed on the entry, like results and splits.';

-- ============================================================================
-- 4. Login, sessions and audit
-- ============================================================================

-- ------------------------------------------------------------------ otp_codes
-- One issued athlete login code. The code itself is never stored, only its
-- bcrypt hash; `consumed_at` is what makes a code single-use. No FK to
-- athletes: a code is issued against a NUMBER, before anyone knows which
-- athlete is on the other end. (067)
CREATE TABLE IF NOT EXISTS hyfit.otp_codes (
  id          bigserial PRIMARY KEY,
  mobile      varchar(15) NOT NULL,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The resend throttle counts recent rows for a number; verification takes the
-- newest live one.
CREATE INDEX IF NOT EXISTS hyfit_otp_codes_mobile_time
  ON hyfit.otp_codes (mobile, created_at DESC);

-- ------------------------------------------------------------- refresh_tokens
-- Console and athlete refresh tokens. Exactly one of athlete_id/admin_id is
-- set; the row is looked up by token_hash on every refresh. (061)
CREATE TABLE IF NOT EXISTS hyfit.refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id  uuid REFERENCES hyfit.athletes (id) ON DELETE CASCADE,
  admin_id    uuid REFERENCES hyfit.users    (id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hyfit_refresh_tokens_hash_idx
  ON hyfit.refresh_tokens (token_hash);

-- ------------------------------------------------------------------- sessions
-- Field-ops session. `audience` (069) makes "signed in to check-in" and
-- "signed in to judging" two states a device holds and loses separately.
CREATE TABLE IF NOT EXISTS hyfit.sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES hyfit.users (id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  device_label  text,
  ip_address    text,
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  audience      text NOT NULL DEFAULT 'judge'
                  CONSTRAINT hyfit_sessions_audience_known
                  CHECK (audience IN ('judge','checkin'))
);

CREATE INDEX IF NOT EXISTS hyfit_sessions_user_idx
  ON hyfit.sessions (user_id) WHERE revoked_at IS NULL;
-- Who is signed in at a counter right now.
CREATE INDEX IF NOT EXISTS hyfit_sessions_audience_idx
  ON hyfit.sessions (audience, user_id) WHERE revoked_at IS NULL;

-- --------------------------------------------------------------- audit_events
-- event_id is NULLABLE on purpose: openLinkedSession resolves it as
-- COALESCE(u.event_id, <the active event>), and with no events BOTH are NULL.
-- A NOT NULL here would fail every login until an event exists. (061)
CREATE TABLE IF NOT EXISTS hyfit.audit_events (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES hyfit.users  (id),
  event_id    uuid REFERENCES hyfit.events (id),
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hyfit_audit_event_time
  ON hyfit.audit_events (event_id, created_at DESC);

-- ============================================================================
-- 5. Content and imports
-- ============================================================================

-- -------------------------------------------------------------- announcements
CREATE TABLE IF NOT EXISTS hyfit.announcements (
  id         bigserial PRIMARY KEY,
  event_id   uuid NOT NULL REFERENCES hyfit.events (id) ON DELETE CASCADE,
  title      text NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The read is always "newest 20 for this event".
CREATE INDEX IF NOT EXISTS hyfit_announcements_event_time
  ON hyfit.announcements (event_id, created_at DESC);

-- -------------------------------------------------------------- import_batches
-- One row per roster/directory import attempt, successful or not. `errors`
-- holds the per-row rejections exactly as the importer reported them. (062)
CREATE TABLE IF NOT EXISTS hyfit.import_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Nullable: an import can target the athlete directory rather than one
  -- event's roster, and deleting an event should not erase the record.
  event_id      uuid REFERENCES hyfit.events (id) ON DELETE SET NULL,
  admin_id      uuid REFERENCES hyfit.users  (id) ON DELETE SET NULL,

  source        text NOT NULL
                  CONSTRAINT hyfit_import_batches_source_check
                  CHECK (source IN ('csv','raceresult')),

  -- The filename for a CSV, the endpoint for a RaceResult pull.
  origin_label  text,

  total_rows       integer NOT NULL DEFAULT 0,
  -- People and entries diverge: a re-import creates neither, while adding a
  -- category to an existing field creates entries and no athletes.
  athletes_created integer NOT NULL DEFAULT 0,
  athletes_updated integer NOT NULL DEFAULT 0,
  entries_created  integer NOT NULL DEFAULT 0,
  entries_updated  integer NOT NULL DEFAULT 0,
  error_rows       integer NOT NULL DEFAULT 0,

  errors        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT hyfit_import_batches_counts_check CHECK (
    total_rows >= 0 AND athletes_created >= 0 AND athletes_updated >= 0
    AND entries_created >= 0 AND entries_updated >= 0 AND error_rows >= 0)
);

CREATE INDEX IF NOT EXISTS hyfit_import_batches_event
  ON hyfit.import_batches (event_id, created_at DESC);

COMMENT ON TABLE hyfit.import_batches IS
  'One roster/directory import attempt. Keeps the per-row rejections after the toast has gone.';

-- ---------------------------------------------------------------- timing_raw
-- Raw timing data from RaceResult14 before processing. Retained for
-- audit/replay. (064)
CREATE TABLE IF NOT EXISTS hyfit.timing_raw (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES hyfit.events (id) ON DELETE CASCADE,
  bib             text NOT NULL,
  station_seq     integer,
  split_ms        integer,
  split_raw       text,
  chip_time       timestamptz,
  source_ip       inet,
  raw_payload     jsonb NOT NULL,
  processed       boolean NOT NULL DEFAULT false,
  processed_at    timestamptz,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hyfit_timing_raw_event
  ON hyfit.timing_raw (event_id, processed);

COMMENT ON TABLE hyfit.timing_raw IS
  'Raw timing data from RaceResult14 before processing. Retained for audit/replay.';

-- ============================================================================
-- 6. Field operations (063)
--
-- Every `participant_id` below references hyfit.category_entries (id) — one
-- person, at one event, in one category, holding one bib. The COLUMN NAME is
-- deliberately unchanged: the field module names this concept `participantId`
-- in ~190 places. ON DELETE is left off these references on purpose, so an
-- entry cannot be deleted out from under a recorded check-in or split.
-- ============================================================================

-- -------------------------------------------------------------- event_configs
-- Versioned, draft-then-publish. The roster importer reads the published row's
-- participant_api_url and participant_mapping.
CREATE TABLE IF NOT EXISTS hyfit.event_configs (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                       uuid NOT NULL REFERENCES hyfit.events (id) ON DELETE CASCADE,
  version                        integer NOT NULL,
  state                          text NOT NULL DEFAULT 'draft'
                                   CONSTRAINT hyfit_event_configs_state_check
                                   CHECK (state IN ('draft','published','retired')),
  participant_api_url            text NOT NULL DEFAULT '',
  update_api_url                 text NOT NULL DEFAULT '',
  participant_mapping            jsonb NOT NULL DEFAULT '{}'::jsonb,
  update_mapping                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  rules                          jsonb NOT NULL DEFAULT '{}'::jsonb,
  require_participant_photo      boolean NOT NULL DEFAULT false,
  require_declaratory_signature  boolean NOT NULL DEFAULT false,
  declaration_text               text NOT NULL DEFAULT
    'I confirm that my participant details are correct and that I have received the assigned race equipment.',
  declaration_version            integer NOT NULL DEFAULT 1,
  media_retention_days           integer NOT NULL DEFAULT 30
                                   CONSTRAINT hyfit_event_configs_retention_check
                                   CHECK (media_retention_days BETWEEN 1 AND 365),

  -- The check-in window (071), relative to the entry's timeslot: how early the
  -- counter opens for an athlete and how late it stays open. Off by default —
  -- an event that never sets it checks anyone in at any hour, as before.
  checkin_window_enabled         boolean NOT NULL DEFAULT false,
  checkin_opens_before_minutes   integer NOT NULL DEFAULT 240
                                   CONSTRAINT hyfit_event_configs_checkin_opens_check
                                   CHECK (checkin_opens_before_minutes BETWEEN 0 AND 10080),
  checkin_closes_after_minutes   integer            -- NULL = never closes
                                   CONSTRAINT hyfit_event_configs_checkin_closes_check
                                   CHECK (checkin_closes_after_minutes IS NULL
                                          OR checkin_closes_after_minutes BETWEEN 0 AND 10080),

  published_at                   timestamptz,
  published_by                   uuid REFERENCES hyfit.users (id),
  created_at                     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hyfit_event_configs_event_version UNIQUE (event_id, version)
);

COMMENT ON TABLE hyfit.event_configs IS
  'Versioned field-ops configuration for one event. The published row also carries the RaceResult participant endpoint the admin roster importer pulls from.';

-- ----------------------------------------------------------- checkin_stations
CREATE TABLE IF NOT EXISTS hyfit.checkin_stations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES hyfit.events (id),
  code        text NOT NULL,
  name        text NOT NULL,
  stage_type  text NOT NULL DEFAULT 'STAGE_1_WRISTBAND'
                CONSTRAINT hyfit_checkin_stations_stage_check
                CHECK (stage_type IN ('STAGE_1_WRISTBAND','STAGE_2_TRANSPONDER')),
  enabled     boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES hyfit.users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_unique_station_code
  ON hyfit.checkin_stations (event_id, lower(code));

CREATE TABLE IF NOT EXISTS hyfit.checkin_station_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES hyfit.events           (id),
  station_id     uuid NOT NULL REFERENCES hyfit.checkin_stations (id),
  volunteer_id   uuid NOT NULL REFERENCES hyfit.users            (id),
  assigned_by    uuid NOT NULL REFERENCES hyfit.users            (id),
  assigned_at    timestamptz NOT NULL DEFAULT now(),
  released_at    timestamptz,
  release_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_one_active_assignment_per_volunteer
  ON hyfit.checkin_station_assignments (event_id, volunteer_id) WHERE released_at IS NULL;

-- -------------------------------------------------------------- checkin_media
-- Created before checkin_stage_records, which references it.
CREATE TABLE IF NOT EXISTS hyfit.checkin_media (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES hyfit.events           (id),
  participant_id  uuid NOT NULL REFERENCES hyfit.category_entries (id),
  transaction_id  text NOT NULL,
  media_type      text NOT NULL
                    CONSTRAINT hyfit_checkin_media_type_check
                    CHECK (media_type IN ('participant_photo','signature')),
  storage_path    text NOT NULL,
  mime_type       text NOT NULL,
  checksum_sha256 text NOT NULL,
  byte_size       integer NOT NULL
                    CONSTRAINT hyfit_checkin_media_size_check CHECK (byte_size > 0),
  width           integer,
  height          integer,
  captured_at     timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  deleted_at      timestamptz,
  created_by      uuid NOT NULL REFERENCES hyfit.users (id)
);
CREATE INDEX IF NOT EXISTS hyfit_media_expiry
  ON hyfit.checkin_media (expires_at) WHERE deleted_at IS NULL;

-- ------------------------------------------------------------------- checkins
-- Legacy single-step check-in. Still read by getStatus.
CREATE TABLE IF NOT EXISTS hyfit.checkins (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                    uuid NOT NULL REFERENCES hyfit.events           (id),
  participant_id              uuid NOT NULL REFERENCES hyfit.category_entries (id),
  volunteer_id                uuid NOT NULL REFERENCES hyfit.users            (id),
  station_id                  uuid REFERENCES hyfit.checkin_stations            (id),
  station_assignment_id       uuid REFERENCES hyfit.checkin_station_assignments (id),
  session_id                  uuid REFERENCES hyfit.sessions                    (id),
  transaction_id              text,
  idempotency_key             text,
  desk                        text,
  state                       text NOT NULL
                                CONSTRAINT hyfit_checkins_state_check
                                CHECK (state IN ('complete','pending_sync','conflict','reversed')),
  verified_at                 timestamptz NOT NULL DEFAULT now(),
  participant_bib_snapshot    text,
  participant_name_snapshot   text,
  volunteer_staff_id_snapshot text,
  volunteer_name_snapshot     text,
  station_code_snapshot       text,
  station_name_snapshot       text,
  wristband_code_snapshot     text,
  transponder1_code_snapshot  text,
  device_label_snapshot       text,
  source_ip_snapshot          text,
  client_observed_at          timestamptz,
  event_timezone_snapshot     text,
  created_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_unique_checkin_transaction
  ON hyfit.checkins (transaction_id) WHERE transaction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_unique_checkin_idempotency
  ON hyfit.checkins (event_id, volunteer_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ------------------------------------------------------ checkin_stage_records
-- Two-stage check-in: wristband, then transponder. The snapshots are the point
-- of the table — what the desk saw when it handed equipment over, kept even if
-- the roster row is edited afterwards.
CREATE TABLE IF NOT EXISTS hyfit.checkin_stage_records (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id                 text NOT NULL UNIQUE,
  idempotency_key                text NOT NULL,
  event_id                       uuid NOT NULL REFERENCES hyfit.events           (id),
  participant_id                 uuid NOT NULL REFERENCES hyfit.category_entries (id),
  stage_type                     text NOT NULL
                                   CONSTRAINT hyfit_stage_records_stage_check
                                   CHECK (stage_type IN ('STAGE_1_WRISTBAND','STAGE_2_TRANSPONDER')),
  state                          text NOT NULL DEFAULT 'pending_sync'
                                   CONSTRAINT hyfit_stage_records_state_check
                                   CHECK (state IN ('pending_sync','completed','attention','reversed')),
  volunteer_id                   uuid NOT NULL REFERENCES hyfit.users            (id),
  station_id                     uuid NOT NULL REFERENCES hyfit.checkin_stations (id),
  station_assignment_id          uuid REFERENCES hyfit.checkin_station_assignments (id),
  session_id                     uuid REFERENCES hyfit.sessions                    (id),
  participant_bib_snapshot       text NOT NULL,
  participant_name_snapshot      text NOT NULL,
  gender_snapshot                text NOT NULL DEFAULT '',
  date_of_birth_snapshot         date,
  contest_snapshot               text NOT NULL DEFAULT '',
  wave_snapshot                  text NOT NULL DEFAULT '',
  club_snapshot                  text NOT NULL DEFAULT '',
  volunteer_staff_id_snapshot    text NOT NULL,
  volunteer_name_snapshot        text NOT NULL,
  station_code_snapshot          text NOT NULL,
  station_name_snapshot          text NOT NULL,
  asset_code_snapshot            text NOT NULL,
  government_id_verified         boolean NOT NULL DEFAULT false,
  declaration_text_snapshot      text NOT NULL DEFAULT '',
  declaration_version_snapshot   integer,
  verbal_declaration_accepted    boolean NOT NULL DEFAULT false,
  photo_media_id                 uuid CONSTRAINT hyfit_stage_photo_media_fk
                                   REFERENCES hyfit.checkin_media (id),
  signature_media_id             uuid CONSTRAINT hyfit_stage_signature_media_fk
                                   REFERENCES hyfit.checkin_media (id),
  device_label_snapshot          text,
  source_ip_snapshot             text,
  client_observed_at             timestamptz,
  event_timezone_snapshot        text NOT NULL,
  completed_at                   timestamptz NOT NULL DEFAULT now(),
  created_at                     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hyfit_stage_records_idempotency UNIQUE (event_id, volunteer_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS hyfit_stage_records_participant
  ON hyfit.checkin_stage_records (event_id, participant_id, stage_type);
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_one_active_stage_per_participant
  ON hyfit.checkin_stage_records (event_id, participant_id, stage_type) WHERE state <> 'reversed';

-- ------------------------------------------- checkin_identity_exceptions
CREATE TABLE IF NOT EXISTS hyfit.checkin_identity_exceptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES hyfit.events           (id),
  participant_id  uuid NOT NULL REFERENCES hyfit.category_entries (id),
  volunteer_id    uuid NOT NULL REFERENCES hyfit.users            (id),
  station_id      uuid NOT NULL REFERENCES hyfit.checkin_stations (id),
  reason          text NOT NULL,
  note            text NOT NULL DEFAULT '',
  state           text NOT NULL DEFAULT 'open'
                    CONSTRAINT hyfit_identity_exceptions_state_check
                    CHECK (state IN ('open','overridden','rejected')),
  resolved_by     uuid REFERENCES hyfit.users (id),
  resolution_note text,
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------- asset_assignments
CREATE TABLE IF NOT EXISTS hyfit.asset_assignments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id               uuid NOT NULL REFERENCES hyfit.events           (id),
  participant_id         uuid NOT NULL REFERENCES hyfit.category_entries (id),
  asset_type             text NOT NULL
                           CONSTRAINT hyfit_asset_assignments_type_check
                           CHECK (asset_type IN ('wristband','transponder1')),
  asset_code             text NOT NULL,
  active                 boolean NOT NULL DEFAULT true,
  assigned_by            uuid NOT NULL REFERENCES hyfit.users (id),
  replaced_assignment_id uuid REFERENCES hyfit.asset_assignments (id),
  reason                 text,
  assigned_at            timestamptz NOT NULL DEFAULT now(),
  released_at            timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_unique_active_asset_code
  ON hyfit.asset_assignments (event_id, asset_type, asset_code) WHERE active;
-- One active wristband per ENTRY: an athlete racing two categories has two
-- entries and legitimately carries two bibs.
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_unique_active_participant_asset
  ON hyfit.asset_assignments (event_id, participant_id, asset_type) WHERE active;

-- -------------------------------------------------------------- race_sessions
CREATE TABLE IF NOT EXISTS hyfit.race_sessions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                    uuid NOT NULL REFERENCES hyfit.events           (id),
  participant_id              uuid NOT NULL REFERENCES hyfit.category_entries (id),
  judge_id                    uuid NOT NULL REFERENCES hyfit.users            (id),
  config_version              integer NOT NULL,
  race_mode                   text NOT NULL DEFAULT 'single'
                                CONSTRAINT hyfit_race_sessions_mode_check
                                CHECK (race_mode IN ('single','doubles')),
  state                       text NOT NULL DEFAULT 'active'
                                CONSTRAINT hyfit_race_sessions_state_check
                                CHECK (state IN ('active','finished','cancelled')),
  current_station             integer NOT NULL DEFAULT 0,
  current_stage               text NOT NULL DEFAULT 'ready',
  manual_started_at           timestamptz,
  cognitive_recall_started_at timestamptz,
  is_ooc                      boolean NOT NULL DEFAULT false,
  team_club_snapshot          text NOT NULL DEFAULT '',
  team_contest_id_snapshot    text NOT NULL DEFAULT '',
  athlete_note                text NOT NULL DEFAULT ''
                                CONSTRAINT hyfit_race_sessions_athlete_note_length
                                CHECK (char_length(athlete_note) <= 1000),
  last_action_key             text,
  started_at                  timestamptz NOT NULL DEFAULT now(),
  finished_at                 timestamptz,
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_unique_active_race
  ON hyfit.race_sessions (event_id, participant_id) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS hyfit.race_session_participants (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  race_session_id           uuid NOT NULL REFERENCES hyfit.race_sessions (id) ON DELETE CASCADE,
  event_id                  uuid NOT NULL REFERENCES hyfit.events           (id),
  participant_id            uuid NOT NULL REFERENCES hyfit.category_entries (id),
  display_order             integer NOT NULL
                              CONSTRAINT hyfit_race_session_participants_order_check
                              CHECK (display_order IN (1, 2)),
  participant_bib_snapshot  text NOT NULL,
  participant_name_snapshot text NOT NULL,
  contest_id_snapshot       text NOT NULL DEFAULT '',
  contest_snapshot          text NOT NULL DEFAULT '',
  club_snapshot             text NOT NULL DEFAULT '',
  wristband_code_snapshot   text NOT NULL DEFAULT '',
  transponder_code_snapshot text NOT NULL DEFAULT '',
  released_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hyfit_race_session_participants_unique UNIQUE (race_session_id, participant_id),
  CONSTRAINT hyfit_race_session_participants_order  UNIQUE (race_session_id, display_order)
);
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_unique_active_race_session_participant
  ON hyfit.race_session_participants (event_id, participant_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS hyfit_race_session_participants_session
  ON hyfit.race_session_participants (race_session_id, display_order);

-- ---------------------------------------------------------------- race_splits
-- The judge tablet's raw boundary log, with its revision state and operation
-- keys. NOT hyfit.splits, which is the platform's computed per-station leg.
CREATE TABLE IF NOT EXISTS hyfit.race_splits (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  race_session_id    uuid NOT NULL REFERENCES hyfit.race_sessions     (id),
  event_id           uuid NOT NULL REFERENCES hyfit.events            (id),
  participant_id     uuid NOT NULL REFERENCES hyfit.category_entries  (id),
  judge_id           uuid NOT NULL REFERENCES hyfit.users             (id),
  operation_key      text NOT NULL UNIQUE,
  stage_id           text NOT NULL,
  stage_name         text NOT NULL,
  boundary_at        timestamptz NOT NULL,
  client_observed_at timestamptz,
  cumulative_ms      bigint NOT NULL
                       CONSTRAINT hyfit_race_splits_cumulative_check CHECK (cumulative_ms >= 0),
  segment_ms         bigint NOT NULL
                       CONSTRAINT hyfit_race_splits_segment_check CHECK (segment_ms >= 0),
  revision_state     text NOT NULL DEFAULT 'original'
                       CONSTRAINT hyfit_race_splits_revision_check
                       CHECK (revision_state IN ('original','corrected','revoked')),
  correction_reason  text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hyfit_race_splits_session_time
  ON hyfit.race_splits (race_session_id, boundary_at, created_at);

-- ----------------------------------------------------------- station_outcomes
CREATE TABLE IF NOT EXISTS hyfit.station_outcomes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  race_session_id uuid NOT NULL REFERENCES hyfit.race_sessions    (id),
  event_id        uuid NOT NULL REFERENCES hyfit.events           (id),
  participant_id  uuid NOT NULL REFERENCES hyfit.category_entries (id),
  judge_id        uuid NOT NULL REFERENCES hyfit.users            (id),
  operation_key   text NOT NULL UNIQUE,
  station_number  integer NOT NULL
                    CONSTRAINT hyfit_station_outcomes_number_check
                    CHECK (station_number BETWEEN 1 AND 6),
  outcome         text NOT NULL
                    CONSTRAINT hyfit_station_outcomes_outcome_check
                    CHECK (outcome IN ('none','penalty','ics')),
  penalty_seconds integer NOT NULL DEFAULT 0
                    CONSTRAINT hyfit_station_outcomes_penalty_check
                    CHECK (penalty_seconds IN (0, 10)),
  note            text NOT NULL DEFAULT '',
  split_id        uuid NOT NULL REFERENCES hyfit.race_splits (id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hyfit_station_outcomes_session
  ON hyfit.station_outcomes (race_session_id, station_number, created_at);

-- --------------------------------------------------------- cognitive_attempts
CREATE TABLE IF NOT EXISTS hyfit.cognitive_attempts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  race_session_id    uuid NOT NULL REFERENCES hyfit.race_sessions    (id),
  event_id           uuid NOT NULL REFERENCES hyfit.events           (id),
  participant_id     uuid NOT NULL REFERENCES hyfit.category_entries (id),
  judge_id           uuid NOT NULL REFERENCES hyfit.users            (id),
  operation_key      text NOT NULL UNIQUE,
  sequence           jsonb NOT NULL,
  response           jsonb NOT NULL,
  tap_observed_at    jsonb NOT NULL DEFAULT '[]'::jsonb,
  correct_count      integer NOT NULL
                       CONSTRAINT hyfit_cognitive_correct_check CHECK (correct_count BETWEEN 0 AND 10),
  percentage         integer NOT NULL
                       CONSTRAINT hyfit_cognitive_percentage_check CHECK (percentage BETWEEN 0 AND 100),
  penalty_seconds    integer NOT NULL
                       CONSTRAINT hyfit_cognitive_penalty_check CHECK (penalty_seconds IN (0, 30)),
  bonus_seconds      integer NOT NULL
                       CONSTRAINT hyfit_cognitive_bonus_check CHECK (bonus_seconds IN (0, 30)),
  recall_started_at  timestamptz NOT NULL,
  recall_finished_at timestamptz NOT NULL,
  recall_duration_ms bigint NOT NULL
                       CONSTRAINT hyfit_cognitive_duration_check CHECK (recall_duration_ms >= 0),
  split_id           uuid NOT NULL REFERENCES hyfit.race_splits (id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hyfit_cognitive_session
  ON hyfit.cognitive_attempts (race_session_id, created_at);

-- ------------------------------------------------------------- penalty_events
CREATE TABLE IF NOT EXISTS hyfit.penalty_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id    text NOT NULL UNIQUE,
  event_id        uuid NOT NULL REFERENCES hyfit.events           (id),
  race_session_id uuid NOT NULL REFERENCES hyfit.race_sessions    (id),
  participant_id  uuid NOT NULL REFERENCES hyfit.category_entries (id),
  judge_id        uuid NOT NULL REFERENCES hyfit.users            (id),
  field_name      text NOT NULL,
  value           integer NOT NULL
                    CONSTRAINT hyfit_penalty_events_value_check CHECK (value >= 0),
  notes           text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------- outbox_operations
CREATE TABLE IF NOT EXISTS hyfit.outbox_operations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key   text NOT NULL UNIQUE,
  event_id        uuid NOT NULL REFERENCES hyfit.events (id),
  participant_id  uuid REFERENCES hyfit.category_entries (id),
  bib             text NOT NULL,
  field_name      text NOT NULL,
  value           text NOT NULL,
  state           text NOT NULL DEFAULT 'pending'
                    CONSTRAINT hyfit_outbox_state_check
                    CHECK (state IN ('pending','processing','confirmed','failed','conflict')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  confirmed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hyfit_outbox_pending
  ON hyfit.outbox_operations (state, next_attempt_at);

-- ------------------------------------------------------------------ sync_runs
CREATE TABLE IF NOT EXISTS hyfit.sync_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES hyfit.events (id),
  kind           text NOT NULL,
  state          text NOT NULL,
  imported_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  -- What the run is working towards, known before the first chunk (075). The
  -- denominator any screen needs to render progress it did not start itself.
  total_count    integer,
  error          text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  -- Heartbeat of a background import: stamped after every committed chunk, so
  -- a stalled `running` row can be told from a working one (074).
  progress_at    timestamptz,
  finished_at    timestamptz
);
-- Partial and running-only, which is what lets a sync abandoned by a crashed
-- process be reclaimed rather than blocking the event forever.
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_one_running_sync
  ON hyfit.sync_runs (event_id, kind) WHERE state = 'running' AND kind = 'participants';

-- ============================================================================
-- 7. Views
-- ============================================================================

-- --------------------------------------------------------------- participants
-- Compatibility view (063, timeslot 070, contest_date 072): the old hyfit_judge.participants column set over
-- category_entries + registrations + athletes. READ-ONLY on purpose — the
-- roster is imported in one place, the admin console Roster tab.
CREATE OR REPLACE VIEW hyfit.participants AS
  SELECT e.id,
         e.event_id,
         e.entry_source_id                            AS source_id,
         e.bib,
         a.full_name                                  AS name,
         COALESCE(c.name, '')                         AS category,
         COALESCE(e.contest_id, '')                   AS contest_id,
         COALESCE(e.wave, '')                         AS wave,
         COALESCE(e.timeslot, '')                     AS timeslot,
         e.contest_date,
         COALESCE(a.gender, '')                       AS gender,
         a.dob                                        AS date_of_birth,
         COALESCE(e.club, '')                         AS club,
         COALESCE(e.source_status, '')                AS source_status,
         COALESCE(e.source_data, '{}'::jsonb)         AS source_data,
         COALESCE(e.checkin_state, 'not_checked_in')  AS checkin_state,
         e.last_source_sync_at,
         e.updated_at
    FROM hyfit.category_entries e
    JOIN hyfit.registrations r ON r.id = e.registration_id
    JOIN hyfit.athletes      a ON a.id = r.athlete_id
    LEFT JOIN hyfit.categories c ON c.id = e.category_id;

COMMENT ON VIEW hyfit.participants IS
  'Compatibility view: the old hyfit_judge.participants column set over category_entries + registrations + athletes. Read-only.';

-- --------------------------------------------------------- athlete_profile_gaps
-- Per-athlete list of unfilled profile fields, for the console's completeness
-- column. Merged-away tombstones are excluded. (066)
CREATE OR REPLACE VIEW hyfit.athlete_profile_gaps AS
  SELECT a.id AS athlete_id,
         a.athlete_code,
         a.full_name,
         a.mobile,
         a.claim_status,
         a.profile_complete,
         array_remove(ARRAY[
           CASE WHEN a.mobile          IS NULL THEN 'mobile'::text     END,
           CASE WHEN a.email           IS NULL THEN 'email'           END,
           CASE WHEN a.dob             IS NULL THEN 'dob'             END,
           CASE WHEN a.gender          IS NULL THEN 'gender'          END,
           CASE WHEN a.city            IS NULL THEN 'city'            END,
           CASE WHEN a.state           IS NULL THEN 'state'           END,
           CASE WHEN a.emergency_name  IS NULL THEN 'emergency_name'  END,
           CASE WHEN a.emergency_phone IS NULL THEN 'emergency_phone' END,
           CASE WHEN a.blood_group     IS NULL THEN 'blood_group'     END,
           CASE WHEN a.tshirt_size     IS NULL THEN 'tshirt_size'     END
         ], NULL::text) AS missing_fields
    FROM hyfit.athletes a
   WHERE a.merged_into IS NULL;

COMMENT ON VIEW hyfit.athlete_profile_gaps IS
  'Per-athlete list of unfilled profile fields. Merged-away tombstones are excluded.';

-- ---------------------------------------------------------- category_setup_gaps
-- Categories still missing admin-only fields. genders_seen/youngest/oldest are
-- observations of who entered, offered as evidence — NOT the eligibility rule.
-- A category that drew only men is not thereby a men's category. (057)
CREATE OR REPLACE VIEW hyfit.category_setup_gaps AS
  SELECT c.id AS category_id,
         e.city,
         e.edition,
         c.name,
         c.format,
         array_remove(ARRAY[
           CASE WHEN c.price_inr      IS NULL THEN 'price_inr'      END,
           CASE WHEN c.entry_cap      IS NULL THEN 'entry_cap'      END,
           CASE WHEN c.gender_rule    IS NULL THEN 'gender_rule'    END,
           CASE WHEN c.min_age        IS NULL THEN 'min_age'        END,
           CASE WHEN c.max_age        IS NULL THEN 'max_age'        END,
           CASE WHEN c.schedule_block IS NULL THEN 'schedule_block' END
         ], NULL) AS missing_fields,
         stat.entries,
         stat.genders_seen,
         stat.youngest,
         stat.oldest
    FROM hyfit.categories c
    JOIN hyfit.events e ON e.id = c.event_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS entries,
             array_remove(array_agg(DISTINCT a.gender), NULL) AS genders_seen,
             min(date_part('year', age(e.event_date, a.dob)))::int AS youngest,
             max(date_part('year', age(e.event_date, a.dob)))::int AS oldest
        FROM hyfit.category_entries ce
        JOIN hyfit.registrations r ON r.id = ce.registration_id
        JOIN hyfit.athletes      a ON a.id = r.athlete_id
       WHERE ce.category_id = c.id
    ) stat ON true
   WHERE array_length(array_remove(ARRAY[
           CASE WHEN c.price_inr      IS NULL THEN 'price_inr'      END,
           CASE WHEN c.entry_cap      IS NULL THEN 'entry_cap'      END,
           CASE WHEN c.gender_rule    IS NULL THEN 'gender_rule'    END,
           CASE WHEN c.min_age        IS NULL THEN 'min_age'        END,
           CASE WHEN c.max_age        IS NULL THEN 'max_age'        END,
           CASE WHEN c.schedule_block IS NULL THEN 'schedule_block' END
         ], NULL), 1) > 0;

COMMENT ON VIEW hyfit.category_setup_gaps IS
  'Categories still missing admin-only fields. genders_seen/youngest/oldest are observations of who entered, offered as evidence — not as the eligibility rule.';

-- ----------------------------------------------------------- user_event_access
-- Effective assignment: the per-event role where one is set, else the user's
-- own. Read this instead of joining by hand, so the COALESCE rule stays in one
-- place. Disabled users and suspended assignments are filtered out here. (060)
CREATE OR REPLACE VIEW hyfit.user_event_access AS
  SELECT ue.id                     AS assignment_id,
         u.id                      AS user_id,
         u.name,
         u.staff_id,
         u.email,
         ue.event_id,
         e.name                    AS event_name,
         COALESCE(ue.role, u.role) AS effective_role,
         ue.station_number,
         ue.is_primary
    FROM hyfit.user_events ue
    JOIN hyfit.users  u ON u.id = ue.user_id
    JOIN hyfit.events e ON e.id = ue.event_id
   WHERE ue.enabled AND u.enabled;

RESET search_path;
