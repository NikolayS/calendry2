-- Revert providers

begin;

drop table if exists providers cascade;

commit;
