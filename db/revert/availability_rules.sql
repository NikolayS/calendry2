-- Revert availability_rules

begin;

drop table if exists availability_rules cascade;

commit;
