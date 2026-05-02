-- Revert sync_channels

begin;

drop table if exists sync_channels cascade;

commit;
