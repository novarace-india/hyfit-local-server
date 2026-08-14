-- ============================================================================
-- seed_hyfit_v2_admin.sql
--
-- Creates (or resets) the console super_admin in `hyfit_v2.users`.
-- NOT a migration — deliberately unnumbered so it never enters the 0NN chain.
-- The hyfit_v2 counterpart of seed_hyfit_admin.sql, which seeds the old schema.
--
-- Run this when there is nobody to sign in as: a fresh hyfit_v2, or a database
-- whose `hyfit.users` never existed, so 081 had no staff to carry over. Without
-- it the console answers "Invalid email or password" to every login, because
-- the table it authenticates against is empty.
--
-- DEV CREDENTIALS ONLY. `admin123` is a throwaway password for a dev database.
-- Do not run this against production; seed a real password there instead.
--
-- Matches what POST /api/hyfitgames/auth/admin/login actually does
-- (hfg-auth.controller.ts):
--     SELECT id, name, email, password_hash, role
--       FROM hyfit_v2.users WHERE email = $1 AND enabled = true
--   then bcrypt.compare(password, password_hash)
-- so the row needs: lowercase email, a bcrypt hash, enabled = true.
--
-- The hash is generated here by pgcrypto's crypt()/gen_salt('bf', 10), which
-- emits a standard $2a$ bcrypt hash that node's `bcrypt.compare` verifies.
-- Nothing is hardcoded, so re-running rotates the salt.
--
-- Constraints on hyfit_v2.users, all satisfied below:
--   hyfit_v2_users_console_credential_pair  (email IS NULL) = (password_hash IS NULL)
--   hyfit_v2_users_staff_credential_pair    (staff_id IS NULL) = (pin_hash IS NULL)
--   hyfit_v2_users_has_credential           staff_id IS NOT NULL OR email IS NOT NULL
--   hyfit_v2_users_email_lower              email = lower(email)
--   hyfit_v2_users_role_check               role IN (super_admin, ...)
--   hyfit_v2_users_stage_role               a stage only on checkin/admin roles
--
-- staff_id and pin_hash stay NULL: this is a console account. A NULL staff_id
-- is what keeps it out of the field-staff Team roster. Signing in still opens a
-- field session — openLinkedSession hangs it off the row, not the credential —
-- so Team and Operations work immediately.
--
-- Idempotent: re-running resets the password and re-enables the account.
--
-- Usage:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/sql/seed_hyfit_v2_admin.sql
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO hyfit_v2.users (name, email, password_hash, role, enabled, must_change_pin)
VALUES (
    'Race Admin',
    lower('admin@hyfitgames.com'),
    crypt('admin123', gen_salt('bf', 10)),
    'super_admin',
    true,
    false            -- console accounts sign in with a password, not a PIN
)
ON CONFLICT (email) DO UPDATE
   SET password_hash = EXCLUDED.password_hash,
       role          = EXCLUDED.role,
       enabled       = true,
       updated_at    = now();

DO $$
DECLARE
    v_ok boolean;
BEGIN
    SELECT (password_hash = crypt('admin123', password_hash)) INTO v_ok
    FROM hyfit_v2.users WHERE email = 'admin@hyfitgames.com';

    IF v_ok IS NOT TRUE THEN
        RAISE EXCEPTION 'seeded hash does not verify against the intended password';
    END IF;
    RAISE NOTICE 'admin@hyfitgames.com seeded in hyfit_v2 and hash verified';
END $$;

COMMIT;

SELECT id, name, email, role, enabled,
       left(password_hash, 7) AS hash_prefix,
       staff_id, event_id
FROM hyfit_v2.users
WHERE email = 'admin@hyfitgames.com';
