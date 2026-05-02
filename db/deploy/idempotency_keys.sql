-- sqlever:auto-commit
-- Deploy idempotency_keys
-- requires: pgque
--
-- Deduplication store for external side effects.
-- Every external call (Google write, Google delete, email send) carries a
-- deterministic key derived from the booking + side-effect type (kind).
-- Workers check this table before issuing the call; result_json caches
-- the response so retries return the same outcome without re-running the op.
--
-- The unique constraint is on (key, kind) — same key can appear with
-- different kinds (e.g. booking_id as key for both push and delete).
--
-- auto-commit: CONCURRENTLY index build requires no surrounding transaction.

set lock_timeout = '5s';

create table if not exists idempotency_keys (
  id          int8        not null generated always as identity,
  key         text        not null,
  kind        text        not null,
  result_json jsonb,
  created_at  timestamptz not null default now(),

  constraint idempotency_keys_pkey primary key (id),
  constraint idempotency_keys_key_kind_uq unique (key, kind)
);

comment on table  idempotency_keys             is 'Deduplication store for external side effects. Workers check before issuing Google or email calls.';
comment on column idempotency_keys.id          is 'Surrogate primary key.';
comment on column idempotency_keys.key         is 'Deterministic key derived from the booking + side-effect (e.g. booking_id, booking_id||":delete").';
comment on column idempotency_keys.kind        is 'Side-effect type: google_push | google_delete | email_confirmation | email_reminder | etc.';
comment on column idempotency_keys.result_json is 'Cached response from the external call. Null until the first successful response.';
comment on column idempotency_keys.created_at  is 'Row creation timestamp (UTC). Used for TTL pruning.';

-- TTL cleanup index: old keys pruned by a maintenance job.
create index concurrently if not exists idempotency_keys_created_at_idx
  on idempotency_keys (created_at);
