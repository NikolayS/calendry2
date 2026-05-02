-- Verify sync_channels

begin;

select id, provider_id, channel_id, channel_token, resource_id,
       sync_token, expires_at, created_at, updated_at
from sync_channels
where false;

rollback;
