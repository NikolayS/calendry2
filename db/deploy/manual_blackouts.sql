-- sqlever:auto-commit
-- Deploy manual_blackouts
-- requires: providers
--
-- Provider-created busy blocks ("out for surgery Mar 12-19").
-- reason is provider-only: never shown to bookers.
-- Inserting a blackout triggers a refresh of busy_blocks (done in application layer).
--
-- auto-commit: each statement runs in its own implicit transaction so that
-- CREATE INDEX CONCURRENTLY can be used without a surrounding BEGIN/COMMIT.

set lock_timeout = '5s';

create table if not exists manual_blackouts (
  id          int8        not null generated always as identity,
  provider_id uuid        not null,
  start_utc   timestamptz not null,
  end_utc     timestamptz not null,
  reason      text,
  created_at  timestamptz not null default now(),

  constraint manual_blackouts_pkey primary key (id),
  constraint manual_blackouts_provider_fk
    foreign key (provider_id) references providers (id) on delete cascade,
  constraint manual_blackouts_end_after_start
    check (end_utc > start_utc)
);

comment on table  manual_blackouts             is 'Provider-created busy blocks; reason is provider-only and never shown to bookers.';
comment on column manual_blackouts.id          is 'Surrogate primary key.';
comment on column manual_blackouts.provider_id is 'FK → providers.id.';
comment on column manual_blackouts.start_utc   is 'Blackout start (UTC).';
comment on column manual_blackouts.end_utc     is 'Blackout end (UTC). Must be after start_utc.';
comment on column manual_blackouts.reason      is 'Free-text reason visible only to the provider in the admin UI.';
comment on column manual_blackouts.created_at  is 'Row creation timestamp (UTC).';

create index concurrently if not exists manual_blackouts_provider_time_idx
  on manual_blackouts (provider_id, start_utc, end_utc);
