-- ops/postgres-init/00-supabase-roles.sql
--
-- Mounted into the postgres container as /etc/postgresql.schema.sql,
-- which supabase/postgres:15.x runs at the very end of its migrate.sh
-- (after all init-scripts and migrations have been applied, i.e. after
-- supabase_auth_admin and all other service roles already exist).
--
-- Problem: supabase/postgres:15.x creates service roles via init SQL but
-- sets NO password on them.  pg_hba.conf requires scram-sha-256 for all TCP
-- connections, so GoTrue (and other clients) fail SASL authentication with:
--   FATAL: password authentication failed for user "supabase_auth_admin"
--
-- Fix: set explicit passwords for the roles that connect over TCP.
-- DEV ONLY defaults — production MUST override via env vars / secrets manager.
-- See .env.example for the corresponding variables.

-- supabase_auth_admin — used by GoTrue to run auth schema migrations + queries
alter role supabase_auth_admin with encrypted password 'auth_admin_pw_local';

-- supabase_storage_admin — used by Supabase Storage service over TCP
alter role supabase_storage_admin with encrypted password 'storage_admin_pw_local';

-- authenticator — used by PostgREST as its DB connection role
alter role authenticator with encrypted password 'authenticator_pw_local';

-- service_role — used by privileged API clients (e.g. service_role key consumers)
alter role service_role with encrypted password 'service_role_pw_local';
