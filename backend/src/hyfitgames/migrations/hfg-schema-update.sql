-- ═══════════════════════════════════════════════════════════════════════════════
-- HYFIT Games Schema Update — Contest Category Width
--
-- The timing_raw table, import_batches columns (event_id, source, payload), and
-- splits columns (split_raw, source) already exist from migration 026.
-- This migration only widens registrations.category for contest names.
-- ═══════════════════════════════════════════════════════════════════════════════

SET search_path TO hyfitgames, public;

-- Widen category from VARCHAR(20) to VARCHAR(80) to accommodate contest names
-- like "Grand Masters Female", "Bloodline Doubles", etc.
ALTER TABLE registrations ALTER COLUMN category TYPE VARCHAR(80);

RESET search_path;

