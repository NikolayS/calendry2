// apps/worker/src/index.ts
//
// Calendry worker process — pgque consumers.
//
// Job classes wired in Sprint 1:
//   google_push  — create Google Calendar events for pending bookings
//
// Sprint 2+ will add: sync_pull, email_send, safety_resync, channel_renewal.
//
// Startup banner explains fixture-replay mode:
//   When GOOGLE_REFRESH_TOKEN is unset (dev/test), the worker uses a
//   fixture-replay fetch that returns canned JSON from
//   packages/google/fixtures/. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
//   and GOOGLE_REFRESH_TOKEN for production mode.
//
// pgque consumer pattern (direct SQL, no ORM, no framework — per CLAUDE.md):
//   1. pgque.create_queue('google_push')   — idempotent, safe on restart
//   2. pgque.register_consumer(queue, name) — idempotent
//   3. Loop: pgque.next_batch → pgque.get_batch_events → process →
//            pgque.event_retry (nack) or pgque.finish_batch (ack)
//   4. LISTEN pgque_google_push for immediate wakeup on new events

import { Client } from "pg";
import { fixtureFetch } from "./fixture-fetch";
import { processGooglePushJob } from "./google-push";
import type { GooglePushJobPayload } from "./google-push";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const QUEUE_NAME = "google_push";
const CONSUMER_NAME = "worker-google-push-1";
const POLL_INTERVAL_MS = 5_000;

// Exponential backoff delays (seconds) for retries 0..4.
// On attempt N (0-indexed), delay = 2^N seconds → 1, 2, 4, 8, 16.
const RETRY_DELAYS_SECONDS = [1, 2, 4, 8, 16] as const;

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

const fixtureMode = !process.env.GOOGLE_REFRESH_TOKEN;
// Cast fixtureFetch to the global fetch type — it satisfies the fetch contract
// (same signature for request/response), just lacks non-standard properties like
// `preconnect` that TypeScript adds to `typeof globalThis.fetch`.
const fetchImpl = (fixtureMode ? fixtureFetch : globalThis.fetch) as typeof globalThis.fetch;

console.log("╔══════════════════════════════════════════════╗");
console.log("║        Calendry Worker — google_push         ║");
console.log("╚══════════════════════════════════════════════╝");
if (fixtureMode) {
  console.log(
    "⚠  FIXTURE-REPLAY MODE: GOOGLE_REFRESH_TOKEN is unset.\n" +
      "   Google API calls return canned JSON from packages/google/fixtures/.\n" +
      "   Set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN\n" +
      "   for production mode.",
  );
} else {
  console.log("Production mode: using real Google credentials.");
}

// ---------------------------------------------------------------------------
// DB connection
// ---------------------------------------------------------------------------

const db = new Client({
  connectionString:
    process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/postgres",
});

// ---------------------------------------------------------------------------
// Startup: ensure queue exists + register consumer
// ---------------------------------------------------------------------------

async function ensureQueueAndConsumer(): Promise<void> {
  // pgque.create_queue returns 0 if already exists, 1 if created — idempotent.
  await db.query("select pgque.create_queue($1)", [QUEUE_NAME]);
  console.log(`Queue '${QUEUE_NAME}' ensured.`);

  // pgque.register_consumer returns 0 if already registered — idempotent.
  await db.query("select pgque.register_consumer($1, $2)", [QUEUE_NAME, CONSUMER_NAME]);
  console.log(`Consumer '${CONSUMER_NAME}' registered on '${QUEUE_NAME}'.`);
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

/**
 * Process one pgque batch for the google_push queue.
 * Returns true if a batch was found and processed, false if the queue was empty.
 */
async function processBatch(): Promise<boolean> {
  // next_batch returns NULL when there are no events.
  const batchResult = await db.query<{ next_batch: string | null }>(
    "select pgque.next_batch($1, $2) as next_batch",
    [QUEUE_NAME, CONSUMER_NAME],
  );
  const batchId = batchResult.rows[0]?.next_batch ?? null;
  if (batchId === null) {
    return false; // nothing to do
  }

  // Fetch all events in this batch.
  const eventsResult = await db.query<{
    ev_id: string;
    ev_data: string;
    ev_retry: number | null;
  }>("select ev_id, ev_data, ev_retry from pgque.get_batch_events($1)", [batchId]);

  for (const ev of eventsResult.rows) {
    const payload = JSON.parse(ev.ev_data) as GooglePushJobPayload;
    const attemptNumber = (ev.ev_retry ?? 0) + 1; // ev_retry is null on first attempt

    try {
      await processGooglePushJob({ db, payload, fetchImpl });
      // Success: ack this individual event (not the whole batch yet)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`google_push: job ${ev.ev_id} failed (attempt ${attemptNumber}): ${errMsg}`);

      if (attemptNumber >= 5) {
        // Exhausted all 5 attempts — log as fatal, do NOT retry further.
        console.error(
          `google_push: job ${ev.ev_id} permanently failed after ${attemptNumber} attempts — dropping`,
        );
        // Fall through: finish_batch will mark it done without retry.
      } else {
        // Nack with exponential backoff.
        const delaySec = RETRY_DELAYS_SECONDS[attemptNumber - 1] ?? 16;
        await db.query("select pgque.event_retry($1, $2, $3)", [batchId, ev.ev_id, delaySec]);
      }
    }
  }

  // Finish the batch (mark subscription advanced past this tick).
  await db.query("select pgque.finish_batch($1)", [batchId]);
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await db.connect();
  console.log("Connected to Postgres.");

  await ensureQueueAndConsumer();

  // LISTEN for pgque wakeup notifications — avoids busy-polling.
  await db.query(`listen pgque_${QUEUE_NAME}`);
  console.log(`Listening on channel pgque_${QUEUE_NAME}`);

  // Process any events already in the queue before entering the event loop.
  let drained = false;
  while (!drained) {
    drained = !(await processBatch());
  }

  console.log(`Polling for ${QUEUE_NAME} jobs (interval ${POLL_INTERVAL_MS}ms) …`);

  // Event loop: wake on NOTIFY or fall back to polling.
  db.on("notification", async (msg) => {
    if (msg.channel === `pgque_${QUEUE_NAME}`) {
      await processBatch();
    }
  });

  // Safety poll — handles the window between LISTEN and any missed NOTIFYs.
  setInterval(async () => {
    try {
      await processBatch();
    } catch (err) {
      console.error("google_push: poll error:", err);
    }
  }, POLL_INTERVAL_MS);

  // Keep the process alive.
  process.on("SIGTERM", async () => {
    console.log("SIGTERM received — shutting down.");
    await db.end();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    console.log("SIGINT received — shutting down.");
    await db.end();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Worker fatal error:", err);
  process.exit(1);
});
