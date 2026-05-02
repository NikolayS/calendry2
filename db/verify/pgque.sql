-- Verify pgque
--
-- Assert the pgque schema and its core tables exist.

begin;

select count(*) as table_count
from pg_tables
where schemaname = 'pgque'
  and tablename in ('queue', 'consumer', 'subscription', 'tick', 'retry_queue')
having count(*) = 5;

rollback;
