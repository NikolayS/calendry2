-- Verify availability_rules
--
-- Assert the table and the exclusion constraint both exist.

begin;

-- Table shape
select id, provider_id, weekday, start_local, end_local,
       slot_minutes, buffer_minutes, valid_from, valid_to,
       created_at, updated_at
from availability_rules
where false;

-- Exclusion constraint exists
select conname
from pg_constraint
where conrelid = 'availability_rules'::regclass
  and contype = 'x'
  and conname = 'availability_rules_no_overlap';

rollback;
