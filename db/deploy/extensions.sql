-- Deploy extensions
-- requires:
--
-- Enable the three Postgres extensions required by Calendry:
--   pgcrypto  - gen_random_uuid() used as default PK for bookings
--   btree_gist - required for the exclusion constraint on availability_rules
--   pg_cron   - drives the pgque ticker + safety resync cron
--
-- Idempotent: CREATE EXTENSION IF NOT EXISTS never errors on re-run.

begin;

create extension if not exists pgcrypto;
create extension if not exists btree_gist;
create extension if not exists pg_cron;

commit;
