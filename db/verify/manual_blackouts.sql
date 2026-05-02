-- Verify manual_blackouts

begin;

select id, provider_id, start_utc, end_utc, reason, created_at
from manual_blackouts
where false;

rollback;
