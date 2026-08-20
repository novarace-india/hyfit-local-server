-- ============================================================================
-- 088: certificate templates for hyfit_v2.
--
-- WHAT THIS IS. A template is a background image plus a LAYOUT — where on that
-- image each dynamic value is printed, and in what font, size and colour. The
-- layout is the `CertConfig` JSON the certificate editor already produces for
-- the main Novarace product (`public.cert_badge.schema`, edited at
-- /admin/[slug]/badges/editor). The same editor drives this table, so the JSON
-- is the same shape and the same renderer prints it.
--
-- WHY NOT `public.cert_badge`. That table is keyed by a bigint `event_id` into
-- `public.events` and a `category_id` into `public.category`. A HYFIT event is
-- a uuid in `hyfit_v2.events` and has no row in either, so a HYFIT template has
-- nothing to point at there. The alternative — inventing shadow rows in the
-- main product's events table so HYFIT could borrow its certificate storage —
-- would put one event in two tables, which is the failure this project has paid
-- for repeatedly.
--
-- ---------------------------------------------------------------- COVERAGE
--
-- WHICH FINISHERS A DESIGN COVERS is two separate facts, and they are stored
-- separately because they are answered by different questions:
--
--     is_default            "who gets it when nothing else names them?"
--                           At most one template per event, enforced by a
--                           partial unique index.
--
--     the contests table    "which contests does this design name?"
--                           Any number, and a design covering Male Open,
--                           Female Open and Masters is ONE upload and ONE
--                           layout rather than three copies to keep in step.
--
-- A named contest beats the default. A template that is neither default nor
-- named on any contest covers nobody — harmless, and what a freshly created
-- template looks like before its coverage is chosen. That state is deliberately
-- reachable: the alternative, treating "no contests" as "everybody", makes a
-- half-finished template silently claim the whole field.
--
-- WHY A CHILD TABLE rather than a `contests text[]` column. The invariant that
-- matters is that no two templates in one event claim the same contest —
-- without it, which certificate an athlete receives depends on row order. A
-- plain UNIQUE index states that exactly, once, in the database. PostgreSQL has
-- no core GiST opclass for text[], so the array form could only be defended by
-- a trigger, and an array column plus a trigger is a worse version of a table
-- with an index on it.
--
-- `event_id` is repeated on the child so that index can be per event. It cannot
-- drift: the composite FK `(template_id, event_id)` references the parent's
-- `(id, event_id)`, so a child row naming a different event has nothing to
-- point at.
--
-- Keyed through `hyfit_v2.contest_key` for the same reason the roster is: the
-- feed spells one contest "Male Open", "MALE OPEN" and "Male  Open" depending
-- on who typed it, and a template matched on the raw string would silently miss
-- two thirds of the field. The column keeps the organiser's spelling; the
-- generated key is what matches.
--
-- ----------------------------------------------------------------------------
--
-- IS_PUBLISHED IS NOT DECORATION. Certificates download from the PUBLIC results
-- page, with no login — so an unpublished template is the only way to lay one
-- out without every spectator being able to print the half-finished draft. The
-- public read filters on it; the admin read does not.
--
-- NO ROW PER CERTIFICATE. Nothing here records that a given athlete downloaded
-- one. The document is rendered in the browser from this template plus the
-- standings row already on the page, so a download is a read — and a public,
-- unauthenticated route that INSERTs on every click is a table anybody can
-- fill. The serial printed on the certificate is derived from the event and the
-- entry rather than allocated, so re-downloading reproduces the same number
-- instead of issuing a second one.
--
-- Additive and idempotent; safe to re-run. Requires 080 (events) and 084
-- (contest_key). An earlier draft of this file gave the parent a single
-- `contest text` column and no `is_default`; where that shape was applied, the
-- migration below brings the table up to this one with guarded ALTERs, moves
-- the two meanings of `contest` into `is_default` and the coverage table, and
-- drops the column rather than leaving two rules in place. Stating the added
-- columns twice — once in the CREATE, once as an ALTER — is the price of
-- CREATE TABLE IF NOT EXISTS being all-or-nothing: it skips an existing table
-- entirely, so a file that only ever creates cannot repair one.
--
-- APPLY TO BOTH DATABASES, for a different reason than 086 and 087. Nothing
-- here is pushed between them — a template is not a result — but an offline
-- venue runs the same console against its local server, so the Certificates
-- screen 500s there on a missing table. The two copies are independent: a
-- template designed at the venue does not travel to the deployment the public
-- reads, and one designed on prod is what the public gets.
--
--   node scripts/run-sql.mjs sql/088_hyfit_v2_certificate_templates.sql
-- ============================================================================

BEGIN;

SET search_path TO hyfit_v2, public;

DO $$
BEGIN
  IF to_regclass('hyfit_v2.events') IS NULL THEN
    RAISE EXCEPTION 'hyfit_v2.events does not exist — run 080 first';
  END IF;
  IF to_regprocedure('hyfit_v2.contest_key(text)') IS NULL THEN
    RAISE EXCEPTION 'hyfit_v2.contest_key does not exist — run 084 first';
  END IF;
END $$;

-- ---------------------------------------------------------------- templates
CREATE TABLE IF NOT EXISTS hyfit_v2.certificate_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  event_id        uuid NOT NULL
                    REFERENCES hyfit_v2.events (id) ON DELETE CASCADE,

  -- What the admin calls this template in the list. Never printed.
  name            text NOT NULL DEFAULT 'Certificate'
                    CONSTRAINT hyfit_v2_cert_templates_name_check
                    CHECK (btrim(name) <> ''),

  -- The design every finisher gets whose contest no template names.
  is_default      boolean NOT NULL DEFAULT false,

  -- The uploaded artwork, in the assets bucket. NULL until one is imported —
  -- a template with no background has nothing to print on and is refused
  -- publication below.
  background_url  text,

  -- The CertConfig produced by the editor: canvas size, variables, and one
  -- field per printed value with its font, size, weight, colour, alignment,
  -- spacing, rotation and opacity. Read by utils/schemaCertRenderer.ts.
  schema          jsonb NOT NULL DEFAULT '{}'::jsonb,

  is_published    boolean NOT NULL DEFAULT false,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- Publishing a template with no artwork or no layout would put a Download
  -- button on the public page that produces an error, or a blank page. Both
  -- halves are required at the moment it goes public, and neither before.
  CONSTRAINT hyfit_v2_cert_templates_publishable CHECK (
    NOT is_published
    OR (btrim(COALESCE(background_url, '')) <> ''
        AND jsonb_typeof(schema -> 'fields') = 'array'
        AND jsonb_array_length(schema -> 'fields') > 0)
  ),

  -- The target of the child table's composite FK. Redundant against the PK on
  -- its own, and the only way to make a coverage row's event provably the
  -- template's event rather than merely usually so.
  CONSTRAINT hyfit_v2_cert_templates_id_event UNIQUE (id, event_id)
);

-- ------------------------------------- bringing an existing table up to shape
-- CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so a
-- database carrying the earlier single-contest draft would skip straight past
-- every column added since — and then fail on the partial index below, which
-- names one of them. The carry-across block further down could never run,
-- because it sits after that index. The columns and constraints this file adds
-- are therefore stated again here as ALTERs, guarded, before anything reads
-- them.
ALTER TABLE hyfit_v2.certificate_templates
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

-- The target of the coverage table's composite FK. Guarded by hand: ADD
-- CONSTRAINT has no IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'hyfit_v2.certificate_templates'::regclass
       AND conname = 'hyfit_v2_cert_templates_id_event'
  ) THEN
    ALTER TABLE hyfit_v2.certificate_templates
      ADD CONSTRAINT hyfit_v2_cert_templates_id_event UNIQUE (id, event_id);
  END IF;
END $$;

-- One fallback per event. Two would make "which certificate does an athlete in
-- an unnamed contest get" depend on row order, which is the same failure the
-- coverage index below prevents for named ones.
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_v2_cert_templates_one_default
  ON hyfit_v2.certificate_templates (event_id)
  WHERE is_default;

COMMENT ON TABLE hyfit_v2.certificate_templates IS
  'Certificate designs for a HYFIT event (migration 088): background artwork plus the editor''s CertConfig layout. Coverage is is_default (the fallback) plus the contests named in hyfit_v2.certificate_template_contests. Rendered in the browser — no row is written per download.';
COMMENT ON COLUMN hyfit_v2.certificate_templates.is_default IS
  'The design for finishers whose contest no template names. At most one per event.';
COMMENT ON COLUMN hyfit_v2.certificate_templates.schema IS
  'CertConfig JSON from the certificate editor — the same shape as public.cert_badge.schema, so one renderer prints both products.';
COMMENT ON COLUMN hyfit_v2.certificate_templates.is_published IS
  'Whether the public results page may print this. The public read filters on it; the admin read does not.';

-- ----------------------------------------------------------------- coverage
CREATE TABLE IF NOT EXISTS hyfit_v2.certificate_template_contests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  template_id  uuid NOT NULL,
  -- Carried so the uniqueness rule below can be per event; held true by the FK.
  event_id     uuid NOT NULL,

  -- The organiser's own spelling, for display. contest_key() is what matches.
  contest      text NOT NULL
                 CONSTRAINT hyfit_v2_cert_contests_contest_check
                 CHECK (btrim(contest) <> ''),

  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT hyfit_v2_cert_contests_template_fkey
    FOREIGN KEY (template_id, event_id)
    REFERENCES hyfit_v2.certificate_templates (id, event_id)
    ON DELETE CASCADE
);

-- THE RULE: one contest is covered by at most one design, per event. Everything
-- about resolution rests on this — without it, `publicTemplate` returns
-- whichever row the planner happened to reach first, and two finishers in one
-- contest could receive different certificates on different days.
CREATE UNIQUE INDEX IF NOT EXISTS hyfit_v2_cert_contests_event_contest
  ON hyfit_v2.certificate_template_contests
     (event_id, hyfit_v2.contest_key(contest));

CREATE INDEX IF NOT EXISTS hyfit_v2_cert_contests_template
  ON hyfit_v2.certificate_template_contests (template_id);

COMMENT ON TABLE hyfit_v2.certificate_template_contests IS
  'Which contests a certificate design covers (migration 088). Any number per template; at most one template per contest per event, which is what makes the design an athlete receives a fact rather than a race.';

-- ------------------------------------------- carrying an earlier draft across
-- The first version of this file put a single `contest text` on the parent,
-- with '' meaning the default. Where that shape exists, its two meanings are
-- split into the two above and the column is dropped, so the rule lives in one
-- place. Where it never existed this block does nothing.
DO $$
DECLARE
  moved integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'hyfit_v2'
       AND table_name = 'certificate_templates'
       AND column_name = 'contest'
  ) THEN
    RETURN;
  END IF;

  EXECUTE $sql$
    UPDATE hyfit_v2.certificate_templates
       SET is_default = true
     WHERE btrim(contest) = ''
  $sql$;

  EXECUTE $sql$
    INSERT INTO hyfit_v2.certificate_template_contests (template_id, event_id, contest)
    SELECT t.id, t.event_id, btrim(t.contest)
      FROM hyfit_v2.certificate_templates t
     WHERE btrim(t.contest) <> ''
       AND NOT EXISTS (
         SELECT 1 FROM hyfit_v2.certificate_template_contests c
          WHERE c.template_id = t.id
            AND hyfit_v2.contest_key(c.contest) = hyfit_v2.contest_key(t.contest)
       )
  $sql$;
  GET DIAGNOSTICS moved = ROW_COUNT;

  EXECUTE 'DROP INDEX IF EXISTS hyfit_v2.hyfit_v2_cert_templates_event_contest';
  EXECUTE 'ALTER TABLE hyfit_v2.certificate_templates DROP COLUMN contest';

  RAISE NOTICE 'certificate templates: % contest row(s) carried across from the single-contest draft', moved;
END $$;

-- Keeps updated_at honest without every caller remembering to set it. Written
-- as a guarded CREATE because the function is shared with whatever else in this
-- schema wants it.
CREATE OR REPLACE FUNCTION hyfit_v2.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hyfit_v2_cert_templates_touch
  ON hyfit_v2.certificate_templates;
CREATE TRIGGER hyfit_v2_cert_templates_touch
  BEFORE UPDATE ON hyfit_v2.certificate_templates
  FOR EACH ROW EXECUTE FUNCTION hyfit_v2.touch_updated_at();

COMMIT;
