-- Verify bookings
--
-- Assert table shape and the state CHECK constraint exist.

begin;

select id, provider_id, booker_email, booker_name, booker_notes,
       start_utc, end_utc, state, google_event_id, idempotency_key,
       rescheduled_from, reschedule_sequence, created_at, updated_at
from bookings
where false;

-- State CHECK constraint exists
select conname
from pg_constraint
where conrelid = 'bookings'::regclass
  and contype = 'c'
  and conname = 'bookings_state_check';

rollback;
