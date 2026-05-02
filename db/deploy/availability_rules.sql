-- Deploy availability_rules
-- requires: providers
--
-- Weekly recurring availability windows for a provider.
-- Rules are stored in the provider's home timezone (start_local, end_local
-- are wall-clock times); the slot generator expands them to UTC instants.
--
-- Overlap constraint: two rules for the same (provider_id, weekday) whose
-- [valid_from, valid_to] date ranges overlap are rejected at the DB level.
-- This uses an EXCLUSION CONSTRAINT with btree_gist operating on:
--   - provider_id and weekday  with the = operator (exact match)
--   - daterange(valid_from, valid_to, '[]') with the && operator (overlaps)
--
-- Per SPEC §Availability rule semantics: overlapping windows for the same
-- weekday are rejected at write time (HTTP 409) rather than resolved by
-- precedence, to avoid silent ambiguity.

begin;

create table if not exists availability_rules (
  id             int8        not null generated always as identity,
  provider_id    uuid        not null,
  weekday        smallint    not null check (weekday between 0 and 6),
  start_local    time        not null,
  end_local      time        not null,
  slot_minutes   smallint    not null check (slot_minutes > 0),
  buffer_minutes smallint    not null default 0 check (buffer_minutes >= 0),
  valid_from     date        not null,
  valid_to       date        not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint availability_rules_pkey primary key (id),
  constraint availability_rules_provider_fk
    foreign key (provider_id) references providers (id) on delete cascade,
  constraint availability_rules_end_after_start
    check (end_local > start_local),
  constraint availability_rules_valid_to_after_from
    check (valid_to >= valid_from),
  -- Exclusion constraint: no two rules for the same provider+weekday
  -- may have overlapping validity date ranges.
  -- btree_gist is required for the mixed = / && operator combination.
  constraint availability_rules_no_overlap
    exclude using gist (
      provider_id with =,
      weekday     with =,
      daterange(valid_from, valid_to, '[]') with &&
    )
);

comment on table  availability_rules                is 'Weekly recurring availability windows per provider, with validity date ranges.';
comment on column availability_rules.id             is 'Surrogate primary key.';
comment on column availability_rules.provider_id    is 'FK → providers.id.';
comment on column availability_rules.weekday        is 'ISO weekday: 0=Sunday … 6=Saturday.';
comment on column availability_rules.start_local    is 'Window open time in provider home_tz (wall-clock).';
comment on column availability_rules.end_local      is 'Window close time in provider home_tz (wall-clock).';
comment on column availability_rules.slot_minutes   is 'Duration of each bookable slot in minutes.';
comment on column availability_rules.buffer_minutes is 'Buffer appended AFTER each slot (not before). Affects slot grid spacing.';
comment on column availability_rules.valid_from     is 'First date this rule is effective (inclusive).';
comment on column availability_rules.valid_to       is 'Last date this rule is effective (inclusive).';
comment on column availability_rules.created_at     is 'Row creation timestamp (UTC).';
comment on column availability_rules.updated_at     is 'Row last-update timestamp (UTC).';

commit;
