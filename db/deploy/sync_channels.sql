-- sqlever:auto-commit
-- Deploy sync_channels
-- requires: providers
--
-- Google Calendar watch-channel registry.
-- One active channel per provider; renewed ~24h before expiry.
-- channel_token is a per-channel random secret; verified on every webhook
-- receipt against X-Goog-Channel-Token to reject spoofed notifications.
-- sync_token is the Google incremental-sync token; on 410 Gone a full
-- resync resets it.
--
-- auto-commit: CONCURRENTLY index builds require no surrounding transaction.

set lock_timeout = '5s';

create table if not exists sync_channels (
  id             int8        not null generated always as identity,
  provider_id    uuid        not null,
  channel_id     text        not null,
  channel_token  text        not null default encode(gen_random_bytes(32), 'hex'),
  resource_id    text        not null,
  sync_token     text,
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint sync_channels_pkey primary key (id),
  constraint sync_channels_provider_fk
    foreign key (provider_id) references providers (id) on delete cascade,
  constraint sync_channels_channel_id_uq unique (channel_id)
);

comment on table  sync_channels               is 'Google Calendar watch channel registry; one active channel per provider.';
comment on column sync_channels.id            is 'Surrogate primary key.';
comment on column sync_channels.provider_id   is 'FK → providers.id.';
comment on column sync_channels.channel_id    is 'Google-assigned channel UUID; unique per registration.';
comment on column sync_channels.channel_token is 'Per-channel random secret; verified against X-Goog-Channel-Token on every webhook.';
comment on column sync_channels.resource_id   is 'Google resource ID; verified against X-Goog-Resource-ID on every webhook.';
comment on column sync_channels.sync_token    is 'Google incremental sync token. Null triggers a full resync on next pull.';
comment on column sync_channels.expires_at    is 'Channel expiry timestamp. Renewal cron fires when < 24h remains.';
comment on column sync_channels.created_at    is 'Row creation timestamp (UTC).';
comment on column sync_channels.updated_at    is 'Row last-update timestamp (UTC).';

-- Fast lookup by channel_id for webhook authenticity verification.
create index concurrently if not exists sync_channels_channel_id_idx
  on sync_channels (channel_id);

-- Fast lookup of channels nearing expiry for the renewal cron.
create index concurrently if not exists sync_channels_expires_at_idx
  on sync_channels (expires_at);
