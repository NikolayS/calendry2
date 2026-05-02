-- sqlever:auto-commit
-- Deploy busy_blocks
-- requires: providers
--
-- Materialized busy-block cache per provider.
-- Union of: Google Calendar events (source='google'), existing Calendry
-- bookings (source='booking'), manual blackouts (source='manual').
-- Refreshed on each webhook tick and on the 15-minute safety cron.
-- Window: next 60 days from last refresh.
--
-- Not a Postgres MATERIALIZED VIEW — kept as a plain table so the worker
-- can do targeted upserts rather than full REFRESH MATERIALIZED VIEW.
--
-- auto-commit: CONCURRENTLY index build requires no surrounding transaction.

set lock_timeout = '5s';

create table if not exists busy_blocks (
  id          int8        not null generated always as identity,
  provider_id uuid        not null,
  start_utc   timestamptz not null,
  end_utc     timestamptz not null,
  source      text        not null check (source in ('google', 'booking', 'manual')),
  source_id   text        not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint busy_blocks_pkey primary key (id),
  constraint busy_blocks_provider_fk
    foreign key (provider_id) references providers (id) on delete cascade,
  constraint busy_blocks_end_after_start
    check (end_utc > start_utc),
  -- Unique per (provider, source, source_id) to allow idempotent upsert
  constraint busy_blocks_source_uq unique (provider_id, source, source_id)
);

comment on table  busy_blocks             is 'Materialized busy-block cache. Union of Google events, bookings, and manual blackouts. Refreshed by worker on webhook + 15-min cron.';
comment on column busy_blocks.id          is 'Surrogate primary key.';
comment on column busy_blocks.provider_id is 'FK → providers.id.';
comment on column busy_blocks.start_utc   is 'Block start (UTC).';
comment on column busy_blocks.end_utc     is 'Block end (UTC).';
comment on column busy_blocks.source      is 'Origin of this busy block: google | booking | manual.';
comment on column busy_blocks.source_id   is 'ID of the originating row in the source table (google_event_id, booking UUID, blackout int8).';
comment on column busy_blocks.created_at  is 'Row creation timestamp (UTC).';
comment on column busy_blocks.updated_at  is 'Row last-update timestamp (UTC).';

-- Primary query pattern: find busy blocks for a provider in a time window.
create index concurrently if not exists busy_blocks_provider_start_idx
  on busy_blocks (provider_id, start_utc);
