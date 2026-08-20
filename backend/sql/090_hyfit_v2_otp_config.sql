-- ============================================================================
-- 090: WHO SENDS THE ATHLETE LOGIN CODE, configured rather than deployed.
--
-- Athlete login is mobile + OTP, and until now the gateway behind it was
-- `HFG_OTP_PROVIDER` in the backend's environment: changing it — or rotating an
-- SMSCountry key — meant an edit to a `.env` and a redeploy, by somebody with
-- shell access, while nobody could log in. This table moves that decision into
-- the HYFIT admin console (Settings → Athlete OTP).
--
-- THE CREDENTIALS ARE NOT HERE. `channel_account_id` points at a row of
-- `public.communication_channel_accounts` — the sending accounts the rest of
-- Novarace already sends SMS and WhatsApp through, with their auth key, token,
-- DLT-approved sender header or Gallabox channel id, and the masking and
-- catalog validation that come with them. A copy of one of those keys in this
-- schema would be a second one to rotate, and the failure of the copy that got
-- missed shows up only in the logins nobody is watching. The same lesson
-- `portal_config.otp_credentials` already learnt (see its entity comment):
-- reference, never copy.
--
-- `delivery` IS NULLABLE ON PURPOSE, and NULL is not "off". It means "nothing
-- has been configured here — keep following the environment", which is what
-- every existing deployment is doing right now. A NOT NULL column defaulting to
-- 'console' would have silently turned real SMS delivery into a console log on
-- the deploy that applied this migration.
--
-- WHY `delivery` NAMES A CHANNEL AND NOT A GATEWAY. The gateway is a property
-- of the account — SMSCountry, Mtalkz and BashSMS are all "an SMS account", and
-- Gallabox is "a WhatsApp account" — and it is already stored, validated and
-- rotated over there. What HYFIT has to decide is which channel carries the
-- code, because that is the part the athlete experiences and the part the
-- message has to be written for: an SMS is text approved under DLT, a WhatsApp
-- message is a template name Meta has cleared plus values for its variables,
-- and neither is sendable down the other pipe.
--
-- Idempotent, additive, safe to re-run — including over the first version of
-- this file, which had a `provider` column of ('console','smscountry').
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS hyfit_v2.otp_config (
  -- One row, always id 1. The configuration is global: an athlete logs in to
  -- HYFIT, not to one event, so there is nothing for a per-event row to key on.
  id                 smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- NULL        → follow HFG_OTP_PROVIDER, as before this migration
  -- 'console'   → print the code to the server log, send nothing (dev only)
  -- 'sms'       → send it as an SMS through the account named below
  -- 'whatsapp'  → send it as a WhatsApp template through that account
  delivery           text,

  -- The sending account, in public.communication_channel_accounts. Its own
  -- `channel` must match `delivery` — enforced by the service rather than here,
  -- because the two columns live in different databases' worth of concerns and
  -- the message an operator needs ("that account sends SMS, not WhatsApp") is
  -- not one a CHECK can give them.
  --
  -- ON DELETE SET NULL rather than RESTRICT: an operator retiring an account
  -- under Communication → Configurations must not be blocked by HYFIT, and a
  -- dangling id would be worse than none — the send path reads a missing
  -- account as "not configured" and says so, instead of quietly falling back to
  -- some other account nobody chose. (Note the console's own delete is a soft
  -- one, `is_deleted`, which this FK does not see; the send path checks that
  -- flag itself.)
  --
  -- The FK itself is added below rather than declared here: a venue's local
  -- node carries `hyfit_v2` and not necessarily the platform's communication
  -- tables, and a migration that will not apply there is a migration that gets
  -- skipped on the machine running the event.
  channel_account_id bigint,

  -- SMS: the text of the message, as the DLT template was approved. `{otp}` is
  -- the code and `{ttl}` the validity in minutes; the CHECK is there because a
  -- template that lost its `{otp}` sends a perfectly deliverable SMS with no
  -- code in it, and the athlete's only symptom is that login never works.
  --
  -- It is kept filled even on WhatsApp delivery: it is what the send is logged
  -- and previewed as, and it is what the configuration falls back to the moment
  -- somebody switches the channel back.
  message_template   text NOT NULL
                       DEFAULT '{otp} is your OTP to login to HYFIT Games. Valid for {ttl} minutes. Do not share this with anyone.'
                       CHECK (message_template LIKE '%{otp}%'),

  -- WhatsApp: the Meta-approved template this goes out as. A WhatsApp business
  -- message is not text at all — it is a template NAME plus values keyed by the
  -- template's own variable names — so there is nothing here to render, and a
  -- free-form body would simply be refused by the provider.
  wa_template_name   text,

  -- The template's variables, in the order Meta declares them, and what fills
  -- each one:
  --
  --   [{"name": "otp", "source": "otp"}]
  --   [{"name": "1", "source": "otp"}, {"name": "2", "source": "ttl"}]
  --   [{"name": "brand", "source": "static", "value": "HYFIT Games"}]
  --
  -- Every variable must be filled with something. Meta rejects a parameter left
  -- empty, and an authentication template carries no body text to read the
  -- names out of — only the operator knows what the provider expects them to be
  -- called, which is why they are stored rather than parsed.
  wa_variables       jsonb NOT NULL DEFAULT '[{"name": "otp", "source": "otp"}]'::jsonb,

  -- How long an issued code stays valid. Bounded because both ends are a
  -- support ticket: under a minute nobody can type it in time, and an hour-long
  -- login code is a credential sitting in an inbox.
  ttl_minutes        int NOT NULL DEFAULT 5 CHECK (ttl_minutes BETWEEN 1 AND 60),

  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- The console admin who last saved it. Plain text, not an FK: this is an
  -- audit note, and it must survive the account being removed.
  updated_by         text
);

-- ---------------------------------------------------------------------------
-- Upgrading a database that got the first version of this file, where the
-- column was `provider` and its only sending value was 'smscountry'. On a fresh
-- CREATE above, every statement here is a no-op.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'hyfit_v2' AND table_name = 'otp_config'
       AND column_name = 'provider'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'hyfit_v2' AND table_name = 'otp_config'
       AND column_name = 'delivery'
  ) THEN
    ALTER TABLE hyfit_v2.otp_config RENAME COLUMN provider TO delivery;
    -- The old CHECK goes HERE, not in the ALTER further down.
    --
    -- Renaming a column does not drop the constraints on it — the CHECK is
    -- rewritten to name `delivery` and keeps its own name and its old
    -- vocabulary, ('console','smscountry'). So the UPDATE below writes 'sms'
    -- into a column that is still constrained to reject it, and the whole
    -- migration fails on a `otp_config_provider_check` violation. The drop must
    -- come between the rename and the mapping. (The identical DROP further down
    -- stays: it covers a database where the rename had already happened.)
    ALTER TABLE hyfit_v2.otp_config
      DROP CONSTRAINT IF EXISTS otp_config_provider_check;
    -- 'smscountry' meant "send it by SMS through the chosen account", which is
    -- exactly what 'sms' means now; the gateway is the account's business.
    UPDATE hyfit_v2.otp_config SET delivery = 'sms' WHERE delivery = 'smscountry';
  END IF;
END $$;

ALTER TABLE hyfit_v2.otp_config
  ADD COLUMN IF NOT EXISTS wa_template_name text,
  ADD COLUMN IF NOT EXISTS wa_variables jsonb NOT NULL
    DEFAULT '[{"name": "otp", "source": "otp"}]'::jsonb;

-- The vocabulary of `delivery`, under a name of its own so it can be replaced
-- rather than accumulated. The inline CHECK of the first version was
-- auto-named, so it is dropped by its generated name too.
ALTER TABLE hyfit_v2.otp_config
  DROP CONSTRAINT IF EXISTS otp_config_provider_check,
  DROP CONSTRAINT IF EXISTS hyfit_otp_config_delivery_check;

ALTER TABLE hyfit_v2.otp_config
  ADD CONSTRAINT hyfit_otp_config_delivery_check
  CHECK (delivery IN ('console', 'sms', 'whatsapp'));

-- The reference to the sending account, where there is something to reference.
-- Without the platform's communication tables — an offline venue node — the
-- column stays a plain bigint and the console's OTP screen is simply not a
-- screen that server is used for.
DO $$
BEGIN
  IF to_regclass('public.communication_channel_accounts') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'hyfit_otp_config_channel_account_fkey'
          AND conrelid = 'hyfit_v2.otp_config'::regclass
     )
  THEN
    ALTER TABLE hyfit_v2.otp_config
      ADD CONSTRAINT hyfit_otp_config_channel_account_fkey
      FOREIGN KEY (channel_account_id)
      REFERENCES public.communication_channel_accounts (id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- The row exists from the start so the settings screen has something to read
-- and the send path never has to distinguish "no row" from "not configured".
INSERT INTO hyfit_v2.otp_config (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

COMMIT;
