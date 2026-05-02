-- Revert idempotency_keys

begin;

drop table if exists idempotency_keys cascade;

commit;
