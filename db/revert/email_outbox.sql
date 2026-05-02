-- Revert email_outbox

begin;

drop table if exists email_outbox cascade;

commit;
