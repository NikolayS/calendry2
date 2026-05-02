-- sqlever:auto-commit
-- Deploy email_outbox
-- requires: bookings
--
-- Transactional email outbox (SPEC §Boundaries / "Email is durable").
-- Every email is written in the same Postgres transaction that triggers it.
-- The worker picks up rows where send_after <= now() AND sent_at IS NULL,
-- sends via the configured transport, then marks sent_at.
--
-- Partial index on (send_after) where sent_at is null — the only query
-- pattern the worker ever uses, keeps the index tiny as rows are processed.
--
-- auto-commit: partial CONCURRENTLY index build requires no surrounding transaction.

set lock_timeout = '5s';

create table if not exists email_outbox (
  id              int8        not null generated always as identity,
  booking_id      uuid,
  kind            text        not null
                    check (kind in (
                      'confirmation', 'reminder', 'cancellation',
                      'reschedule', 'conflict_notification'
                    )),
  recipient_email text        not null,
  send_after      timestamptz not null default now(),
  sent_at         timestamptz,
  last_error      text,
  attempt_count   int4        not null default 0,
  idempotency_key text        not null,
  created_at      timestamptz not null default now(),

  constraint email_outbox_pkey primary key (id),
  constraint email_outbox_booking_fk
    foreign key (booking_id) references bookings (id) on delete set null,
  constraint email_outbox_attempt_count_nonneg
    check (attempt_count >= 0),
  constraint email_outbox_idempotency_key_uq unique (idempotency_key)
);

comment on table  email_outbox                  is 'Transactional email outbox. Rows written in same txn as the triggering event; worker drains and marks sent_at.';
comment on column email_outbox.id               is 'Surrogate primary key.';
comment on column email_outbox.booking_id       is 'FK → bookings.id. Null for non-booking emails (e.g. provider auth alerts). Set null on booking delete.';
comment on column email_outbox.kind             is 'Email type: confirmation | reminder | cancellation | reschedule | conflict_notification.';
comment on column email_outbox.recipient_email  is 'Recipient email address.';
comment on column email_outbox.send_after       is 'Earliest send time (UTC). Worker skips rows where send_after > now().';
comment on column email_outbox.sent_at          is 'Timestamp when email was successfully sent. Null = pending or failed.';
comment on column email_outbox.last_error       is 'Last SMTP or API error message. Cleared on successful send.';
comment on column email_outbox.attempt_count    is 'Number of send attempts so far. Worker caps retries at 5.';
comment on column email_outbox.idempotency_key  is 'Dedup key preventing double-send across worker restarts.';
comment on column email_outbox.created_at       is 'Row creation timestamp (UTC).';

-- Partial index on pending rows only — the worker's sole read path.
create index concurrently if not exists email_outbox_pending_idx
  on email_outbox (send_after)
  where sent_at is null;
