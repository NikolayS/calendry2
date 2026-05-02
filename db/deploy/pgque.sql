-- Deploy pgque
-- requires: extensions
--
-- Install the vendored pgque job-queue engine.
-- pgque.sql is idempotent: every object uses CREATE … IF NOT EXISTS.
-- Source: db/pgque.sql (vendored from NikolayS/pgque).
--
-- Note: pg_cron (installed in the extensions migration) is required
-- by pgque.start() to drive the ticker. Run SELECT pgque.start() once
-- after the first deploy to register the cron job.

\i pgque.sql
