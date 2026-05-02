// Calendry worker process — pgque consumers + cron jobs
// Job classes: google_push, sync_pull, email_send, safety_resync, channel_renewal
// Full implementations land in Sprint 1+ (see SPEC.md §Components / Worker)

console.log("calendry worker: starting");

// Boot and exit cleanly — real queue consumers land in #6
console.log("calendry worker: no queues configured yet, exiting");
process.exit(0);
