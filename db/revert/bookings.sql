-- Revert bookings

begin;

drop table if exists bookings cascade;

commit;
