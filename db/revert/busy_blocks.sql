-- Revert busy_blocks

begin;

drop table if exists busy_blocks cascade;

commit;
