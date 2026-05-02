-- Verify extensions
--
-- Assert that all three required extensions are installed.

begin;

select count(*) as installed_count
from pg_extension
where extname in ('pgcrypto', 'btree_gist', 'pg_cron')
having count(*) = 3;

rollback;
