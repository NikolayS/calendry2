-- Revert pgque
--
-- Drop the pgque schema and all its objects.
-- CASCADE removes the pg_cron job registered by pgque.start() as well.

begin;

drop schema if exists pgque cascade;

commit;
