-- Verify providers

begin;

select id, slug, email, home_tz, google_oauth_refresh_token, oauth_status, created_at, updated_at
from providers
where false;

rollback;
