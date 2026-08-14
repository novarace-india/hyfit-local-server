-- ============================================================================
-- seed_hyfit_admin.sql
--
-- Creates (or resets) the admin-console super_admin in `hyfit.users`.
-- NOT a migration -- deliberately unnumbered so it never enters the 0NN chain.
--
-- DEV CREDENTIALS ONLY. `admin123` is a throwaway password for the dev DB.
-- Do not run this against production; seed a real password there instead.
--
-- Matches what POST /api/hyfitgames/auth/admin/login actually does
-- (hfg-auth.controller.ts):
--     SELECT id, name, email, password_hash, role
--       FROM hyfit.users WHERE email = $1 AND enabled = true
--   then bcrypt.compare(password, password_hash)
-- so the row needs: lowercase email, a bcrypt hash, enabled = true.
--
-- The hash is generated here by pgcrypto's crypt()/gen_salt('bf', 10), which
-- emits a standard $2a$ bcrypt hash that node's `bcrypt.compare` verifies.
-- Nothing is hardcoded, so re-running rotates the salt.
--
-- Column rules enforced by hyfit.users CHECK constraints, all satisfied below:
--   hyfit_users_console_credential_pair  (email IS NULL) = (password_hash IS NULL)
--   hyfit_users_staff_credential_pair    (staff_id IS NULL) = (pin_hash IS NULL)
--   hyfit_users_has_credential           staff_id IS NOT NULL OR email IS NOT NULL
--   hyfit_users_email_lower              email = lower(email)
--   hyfit_users_role_check               role IN (super_admin, event_admin, checkin, judge, readonly)
--   hyfit_users_origin_check             origin IN (hyfit, hyfit_judge, hyfitgames)
--
-- staff_id/pin_hash stay NULL: this is a console-only account, and a NULL
-- staff_id is what keeps it out of the field-staff Team roster (see 047).
--
-- Idempotent: re-running resets the password and re-enables the account.
--
-- Usage:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/sql/seed_hyfit_admin.sql
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO hyfit.users (name, email, password_hash, role, origin, enabled, must_change_pin)
VALUES (
    'Race Admin',
    lower('admin@hyfitgames.com'),
    crypt('admin123', gen_salt('bf', 10)),
    'super_admin',
    'hyfit',
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
    FROM hyfit.users WHERE email = 'admin@hyfitgames.com';

    IF v_ok IS NOT TRUE THEN
        RAISE EXCEPTION 'seeded hash does not verify against the intended password';
    END IF;
    RAISE NOTICE 'admin@hyfitgames.com seeded and hash verified';
END $$;

COMMIT;

SELECT id, name, email, role, origin, enabled,
       left(password_hash, 7) AS hash_prefix,
       staff_id, event_id
FROM hyfit.users
WHERE email = 'admin@hyfitgames.com';
