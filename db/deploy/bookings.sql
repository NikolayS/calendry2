-- sqlever:auto-commit
-- Deploy bookings
-- requires: providers
--
-- Booking rows — one per booker-provider-slot interaction.
-- State machine (SPEC §Booking state machine):
--   pending_push → confirmed → cancelled  (terminal)
--                            → rescheduled (terminal; new row created)
--                 → conflicted → cancelled
--                              → rescheduled
--
-- id is a UUID (per SPEC §Key abstractions: "Booking — owns its own UUID").
-- idempotency_key is application-set; derived from booker_email + slot start.
-- rescheduled_from is a self-reference forming reschedule chains.
-- reschedule_sequence prevents double-reschedule races from stale UI forms.
--
-- auto-commit: CONCURRENTLY index builds require no surrounding transaction.

set lock_timeout = '5s';

create table if not exists bookings (
  id                  uuid        not null default gen_random_uuid(),
  provider_id         uuid        not null,
  booker_email        text        not null,
  booker_name         text        not null,
  booker_notes        text,
  start_utc           timestamptz not null,
  end_utc             timestamptz not null,
  state               text        not null default 'pending_push'
                        check (state in ('pending_push', 'confirmed', 'cancelled', 'rescheduled', 'conflicted')),
  google_event_id     text,
  idempotency_key     text        not null,
  rescheduled_from    uuid,
  reschedule_sequence int4        not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint bookings_pkey primary key (id),
  constraint bookings_provider_fk
    foreign key (provider_id) references providers (id) on delete restrict,
  constraint bookings_rescheduled_from_fk
    foreign key (rescheduled_from) references bookings (id) on delete set null,
  constraint bookings_end_after_start
    check (end_utc > start_utc),
  constraint bookings_reschedule_sequence_nonneg
    check (reschedule_sequence >= 0)
);

comment on table  bookings                    is 'One row per booking. State machine: pending_push → confirmed → cancelled|rescheduled|conflicted.';
comment on column bookings.id                 is 'UUID primary key (per SPEC §Key abstractions).';
comment on column bookings.provider_id        is 'FK → providers.id.';
comment on column bookings.booker_email       is 'Booker email address. HTML-escaped before rendering.';
comment on column bookings.booker_name        is 'Booker display name. HTML-escaped before rendering.';
comment on column bookings.booker_notes       is 'Optional free-text notes from the booker. HTML-escaped before rendering.';
comment on column bookings.start_utc          is 'Booking start (UTC).';
comment on column bookings.end_utc            is 'Booking end (UTC). Derived from start_utc + slot_minutes.';
comment on column bookings.state              is 'State machine value: pending_push | confirmed | cancelled | rescheduled | conflicted.';
comment on column bookings.google_event_id    is 'Google Calendar event ID once pushed. Null on rescheduled/cancelled original rows.';
comment on column bookings.idempotency_key    is 'Application-set dedup key (derived from booker_email + start_utc). Unique across all bookings.';
comment on column bookings.rescheduled_from   is 'Self-reference to the original booking row when this is a reschedule replacement.';
comment on column bookings.reschedule_sequence is 'Monotonically increasing per reschedule chain; prevents double-reschedule from stale UI.';
comment on column bookings.created_at         is 'Row creation timestamp (UTC).';
comment on column bookings.updated_at         is 'Row last-update timestamp (UTC).';

-- Fast lookup of active bookings per provider window (booking page, conflict detection).
create index concurrently if not exists bookings_provider_time_idx
  on bookings (provider_id, start_utc, end_utc)
  where state not in ('cancelled', 'rescheduled');

-- Fast dedup check on booking create.
create unique index concurrently if not exists bookings_idempotency_key_uq
  on bookings (idempotency_key);
