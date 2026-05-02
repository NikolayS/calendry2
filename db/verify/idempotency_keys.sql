-- Verify idempotency_keys
--
-- Assert table shape and the (key, kind) unique constraint.

begin;

select id, key, kind, result_json, created_at
from idempotency_keys
where false;

-- Unique constraint exists
select conname
from pg_constraint
where conrelid = 'idempotency_keys'::regclass
  and contype = 'u'
  and conname = 'idempotency_keys_key_kind_uq';

rollback;
