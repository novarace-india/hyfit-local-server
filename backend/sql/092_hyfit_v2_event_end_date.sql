-- ============================================================================
-- 092: hyfit_v2.events.event_end_date — the last day of a multi-day edition.
--
-- WHY. `event_date` has always been a single calendar day (see 080), and the
-- HYFIT Games editions run over two: Day 1 and Day 2. Everything that showed an
-- event a date therefore showed Day 1 and quietly claimed the event was over
-- that evening — the public list at /hyfitgames, the console's Events screen
-- and its dashboard alike.
--
-- WHY A SECOND DATE AND NOT A LIST OF DAYS. An edition runs on consecutive
-- days; what a reader needs is the span. A `date[]` would let the two days be
-- a fortnight apart, which is not a thing the product does, and would make
-- every read a loop over an array to answer "when is this?".
--
-- WHAT IT DOES NOT CHANGE. `event_date` keeps its meaning and its job exactly:
-- it is Day 1, and it is still what the check-in window anchors a wall-clock
-- timeslot to for an athlete whose RaceResult ContestDate is blank. An athlete
-- racing on Day 2 is told which day by ContestDate — that is what the field
-- already reads (see hjudge-checkin-window.util.ts) — so nothing about this
-- column changes who may check in when.
--
-- Single-day events leave it NULL, which is the honest value: "this event has
-- no second day", not "the second day is the same as the first". Every reader
-- treats NULL as a one-day event.
--
-- Idempotent: safe to re-run.
-- ============================================================================

ALTER TABLE hyfit_v2.events
  ADD COLUMN IF NOT EXISTS event_end_date date;

-- The span has to be a span. An end date before the start is a typo, and an end
-- date with no start is a range with no beginning — both are states no screen
-- can render, so neither is storable. Equal is allowed and means the same as
-- NULL; the writers normalise it away, the constraint does not need to.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'hyfit_v2.events'::regclass
       AND conname  = 'hyfit_v2_events_date_span_check'
  ) THEN
    ALTER TABLE hyfit_v2.events
      ADD CONSTRAINT hyfit_v2_events_date_span_check CHECK (
        event_end_date IS NULL
        OR (event_date IS NOT NULL AND event_end_date >= event_date));
  END IF;
END $$;

COMMENT ON COLUMN hyfit_v2.events.event_date IS
  'Day 1, as a calendar date. Anchors a check-in timeslot for athletes with no RaceResult ContestDate.';
COMMENT ON COLUMN hyfit_v2.events.event_end_date IS
  'The last day of a multi-day edition. NULL = the event runs on event_date alone.';
