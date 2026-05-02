-- Revert manual_blackouts

begin;

drop table if exists manual_blackouts cascade;

commit;
