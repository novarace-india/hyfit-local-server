-- ============================================================================
-- 093 PREFLIGHT — what the sync revamp would change on THIS database.
--
-- READ-ONLY. Every statement here is a SELECT. It writes nothing, takes no
-- locks worth the name, and is safe to run against production during an event.
--
-- PURE SQL, NO psql META-COMMANDS. An earlier version of this file used `\echo`
-- to label the sections, which works in `psql` and fails with a bare syntax
-- error in pgAdmin, DBeaver, or anything else that sends the text straight to
-- the server. A preflight is precisely the file that has to run in whatever
-- client the person checking happens to have open, so it labels its sections
-- with columns instead.
--
-- QUERY 1 IS THE WHOLE ANSWER. It is one statement returning one row per check,
-- so a tool that shows only the last result grid still shows you everything
-- that matters. The queries after it are for drilling into a row that came back
-- REVIEW or STOP.
--
-- WHAT 093 TOUCHES, IN FULL. Three tables, all of them sync bookkeeping:
--
--     hyfit_v2.event_ingest_tokens   scopes rewritten, CHECK widened
--     hyfit_v2.event_push_targets    6 columns DROPPED, 8 added, CHECKs widened
--     hyfit_v2.push_runs             kind rewritten, CHECK widened
--
-- WHAT IT DOES NOT TOUCH. `events`, `athletes`, `results`, `users`, `sessions`,
-- `raceresults_endpoints`, `certificate_templates`, `otp_config` — none of them
-- are written by any statement in the migration. No online event is affected,
-- because every row it reaches belongs to the offline-sync feature.
-- ============================================================================


-- ============================================================================
-- 1. THE VERDICT. One statement, one row per check. Read the `verdict` column.
-- ============================================================================
WITH tokens AS (
  SELECT
    count(*) FILTER (WHERE 'athletes' = ANY (scopes))                   AS to_rewrite,
    count(*) FILTER (WHERE 'athletes' = ANY (scopes)
                       AND revoked_at IS NULL
                       AND expires_at > now())                          AS live_to_rewrite
  FROM hyfit_v2.event_ingest_tokens
),
targets AS (
  SELECT count(*) AS rows FROM hyfit_v2.event_push_targets
),
runs AS (
  SELECT count(*) FILTER (WHERE kind = 'athletes') AS to_rewrite
  FROM hyfit_v2.push_runs
),
at_risk AS (
  SELECT count(*) AS events
  FROM (
    SELECT e.id
    FROM hyfit_v2.events e
    LEFT JOIN hyfit_v2.event_ingest_tokens t ON t.event_id = e.id
    WHERE e.delivery_mode = 'offline'
      AND (e.status IN ('live','ready')
        OR e.is_active
        OR t.last_used_at > now() - interval '24 hours')
    GROUP BY e.id
  ) x
)
SELECT * FROM (
  SELECT
    1 AS seq,
    'Which database is this?' AS check_item,
    current_database() || ' as ' || current_user
      || coalesce(' on ' || host(inet_server_addr()), ' (local socket)') AS finding,
    'CONFIRM THIS IS THE ONE YOU MEANT' AS verdict
  UNION ALL
  SELECT
    2,
    'Credentials rescoped (athletes -> config)',
    to_rewrite::text || ' to rewrite, of which ' || live_to_rewrite::text || ' still live',
    CASE WHEN live_to_rewrite > 0
         THEN 'REVIEW - a live credential belongs to a laptop that may be paired now'
         ELSE 'OK - nothing usable is affected' END
  FROM tokens
  UNION ALL
  SELECT
    3,
    'Rows that would LOSE columns (irreversible)',
    rows::text || ' row(s) in event_push_targets',
    CASE WHEN rows = 0
         THEN 'OK - the six DROP COLUMNs take no data (expected on prod)'
         ELSE 'STOP IF THIS IS PROD - prod receives, it never sends' END
  FROM targets
  UNION ALL
  SELECT
    4,
    'Activity log rows rewritten',
    to_rewrite::text || ' push_runs row(s) change kind athletes -> results',
    'OK - append-only log the service already prunes'
  FROM runs
  UNION ALL
  SELECT
    5,
    'Offline events at risk from the DEPLOY (not the migration)',
    events::text || ' live/active offline event(s)',
    CASE WHEN events = 0
         THEN 'OK - nothing running to break'
         ELSE 'STOP - finish the event before deploying; see note below' END
  FROM at_risk
) checks
ORDER BY seq;

-- Why check 5 is the one that bites. The migration is not the risk; the deploy
-- after it is. Once 093 lands AND the new backend ships, POST
-- /ingest/events/:id/athletes no longer exists — a results push now carries its
-- own athletes. A venue laptop still on the old build starts failing its roster
-- push immediately, mid-event, with nobody at the prod console able to see why.
-- Update the laptop and prod together: both halves of this contract changed at
-- once.


-- ============================================================================
-- 2. DETAIL: every credential, and what its scopes would become.
--    Rows already carrying {config,results} are left alone — re-running 093 is
--    safe. Read `state`: an expired or revoked credential is rewritten but
--    cannot be used by anything, so it carries no risk.
-- ============================================================================
SELECT t.id,
       t.label,
       t.token_prefix,
       t.scopes                              AS scopes_now,
       CASE WHEN 'athletes' = ANY (t.scopes)
            THEN ARRAY(SELECT DISTINCT s
                         FROM unnest(array_replace(t.scopes,'athletes','config')) AS s
                        ORDER BY s)
            ELSE t.scopes
       END                                   AS scopes_after,
       CASE WHEN t.revoked_at IS NOT NULL THEN 'revoked'
            WHEN t.expires_at <= now()       THEN 'expired'
            ELSE 'LIVE'
       END                                   AS state,
       t.expires_at,
       t.last_used_at,
       t.use_count,
       e.name                                AS event,
       e.delivery_mode
  FROM hyfit_v2.event_ingest_tokens t
  JOIN hyfit_v2.events e ON e.id = t.event_id
 ORDER BY (t.revoked_at IS NULL AND t.expires_at > now()) DESC, t.created_at DESC;


-- ============================================================================
-- 3. DETAIL: the rows that would lose columns.
--    Empty on a prod node. If this returns rows on a machine you believe is
--    prod, stop — either HYFIT_NODE_ROLE is wrong somewhere, or this is not the
--    database you think it is.
-- ============================================================================
SELECT event_id,
       base_url,
       token_prefix,
       enabled,
       interval_minutes,
       last_status,
       results_pushed_at
  FROM hyfit_v2.event_push_targets
 ORDER BY updated_at DESC;


-- ============================================================================
-- 4. DETAIL: offline events that are live, active, or recently synced.
--    This is check 5 expanded. Empty means there is nothing to break.
-- ============================================================================
SELECT e.id,
       e.name,
       e.status,
       e.is_active,
       e.results_mode,
       e.event_date,
       max(t.last_used_at) AS credential_last_used
  FROM hyfit_v2.events e
  LEFT JOIN hyfit_v2.event_ingest_tokens t ON t.event_id = e.id
 WHERE e.delivery_mode = 'offline'
   AND (e.status IN ('live','ready')
     OR e.is_active
     OR t.last_used_at > now() - interval '24 hours')
 GROUP BY e.id, e.name, e.status, e.is_active, e.results_mode, e.event_date
 ORDER BY e.is_active DESC, e.status;
