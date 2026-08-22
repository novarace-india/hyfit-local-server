-- Has 093 actually been applied to THIS database?
--
-- The whole migration is one BEGIN…COMMIT, so a failure part-way through rolls
-- ALL of it back — including the CHECK on event_ingest_tokens.scopes. Running
-- the new backend against a database where that rollback happened produces a
-- mint that fails with a bare "Internal server error", because the code writes
-- {config,results} and 086's constraint still only permits {athletes,results}.
--
-- Read-only. One row per check.
SELECT 'scopes CHECK (event_ingest_tokens)' AS check_item,
       pg_get_constraintdef(oid)            AS live_definition,
       CASE WHEN pg_get_constraintdef(oid) LIKE '%config%'
            THEN '093 APPLIED' ELSE '093 NOT APPLIED - re-run it' END AS verdict
  FROM pg_constraint
 WHERE conname = 'hyfit_v2_ingest_tokens_scopes_check'
UNION ALL
SELECT 'push_runs kind CHECK',
       pg_get_constraintdef(oid),
       CASE WHEN pg_get_constraintdef(oid) LIKE '%config_pull%'
            THEN '093 APPLIED' ELSE '093 NOT APPLIED' END
  FROM pg_constraint
 WHERE conname = 'hyfit_v2_push_runs_kind_check'
UNION ALL
SELECT 'event_push_targets.pull_url column',
       coalesce(max(column_name), '(absent)'),
       CASE WHEN count(*) > 0 THEN '093 APPLIED' ELSE '093 NOT APPLIED' END
  FROM information_schema.columns
 WHERE table_schema = 'hyfit_v2'
   AND table_name   = 'event_push_targets'
   AND column_name  = 'pull_url';
