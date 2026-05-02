-- Revert extensions
--
-- Drop extensions in reverse dependency order.
-- CASCADE drops any objects that depend on them.
-- WARNING: revert will fail in production if other objects depend on these extensions.

begin;

drop extension if exists pg_cron cascade;
drop extension if exists btree_gist cascade;
drop extension if exists pgcrypto cascade;

commit;
