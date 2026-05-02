-- Verify busy_blocks
--
-- Assert table shape and the (provider_id, start_utc) index exist.

begin;

select id, provider_id, start_utc, end_utc, source, source_id, created_at, updated_at
from busy_blocks
where false;

-- Primary query index exists
select indexname
from pg_indexes
where tablename = 'busy_blocks'
  and indexname = 'busy_blocks_provider_start_idx';

rollback;
