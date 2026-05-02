-- Verify email_outbox
--
-- Assert table shape and the partial pending index.

begin;

select id, booking_id, kind, recipient_email, send_after,
       sent_at, last_error, attempt_count, idempotency_key, created_at
from email_outbox
where false;

-- Partial index exists
select indexname
from pg_indexes
where tablename = 'email_outbox'
  and indexname = 'email_outbox_pending_idx';

rollback;
