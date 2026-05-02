// apps/worker/src/google-push.ts
//
// Handler for the google_push pgque job.
// Consumes { booking_id } payloads — loads booking + provider, calls
// events.insert via @calendry/google, and transitions booking state to
// confirmed on success.
//
// Error handling per SPEC §Data flow / booking creation step 4:
//   - 200: booking.state = confirmed, google_event_id stored
//   - 409 dup: reconcile409 (CalendarClient handles this internally)
//   - 5xx / 429: GoogleApiError thrown → caller nacks for exponential backoff
//   - OAuthInvalidGrantError / OAuthTokenExpiredError / OAuthScopeDowngradeError:
//       providers.oauth_status = 'revoked', email_outbox row inserted, rethrow
//   - 410 (SyncTokenExpiredError): log + rethrow (fail once, not relevant for push)
//   - degraded/revoked provider: skip job cleanly (return without error)

import type { Client } from "pg";
import {
  CalendarClient,
  OAuthInvalidGrantError,
  OAuthScopeDowngradeError,
  OAuthTokenExpiredError,
  exchangeRefreshToken,
} from "../../../packages/google/index";
import type { EventResource } from "../../../packages/google/index";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GooglePushJobPayload {
  booking_id: string;
}

export interface ProcessGooglePushOptions {
  db: Client;
  payload: GooglePushJobPayload;
  /** Injectable fetch — defaults to globalThis.fetch. Pass a fixture-replay
   *  fetch for testing. When GOOGLE_REFRESH_TOKEN is unset the worker startup
   *  injects the fixture-replay fetch automatically. */
  fetchImpl?: typeof globalThis.fetch;
}

interface BookingWithProvider {
  // booking columns
  id: string;
  provider_id: string;
  booker_email: string;
  booker_name: string;
  booker_notes: string | null;
  start_utc: Date;
  end_utc: Date;
  state: string;
  google_event_id: string | null;
  idempotency_key: string;
  // provider columns (aliased with p_ prefix)
  p_id: string;
  p_email: string;
  p_home_tz: string;
  p_google_oauth_refresh_token: string | null;
  p_oauth_status: string;
}

// ---------------------------------------------------------------------------
// OAuth failure helper
// ---------------------------------------------------------------------------

/**
 * On OAuth auth failure: mark provider revoked, insert email_outbox row,
 * then re-throw the original error so the pgque batch is nacked.
 */
async function handleOAuthFailure(
  db: Client,
  providerId: string,
  providerEmail: string,
  bookingId: string,
  originalError: Error,
): Promise<never> {
  // Mark provider revoked
  await db.query(
    `update providers
        set oauth_status = $1, updated_at = now()
      where id = $2`,
    ["revoked", providerId],
  );

  // Write email_outbox row so the provider is notified
  // idempotency_key = provider_id:oauth_revoked — deduped if the job retried
  await db.query(
    `insert into email_outbox
       (booking_id, kind, recipient_email, send_after, idempotency_key)
     values ($1, 'conflict_notification', $2, now(), $3)
     on conflict (idempotency_key) do nothing`,
    [bookingId, providerEmail, `${providerId}:oauth_revoked`],
  );

  throw originalError;
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

/**
 * Process a single google_push job.
 *
 * This function is pure in the sense that all side-effects (DB, Google API)
 * are injected. The pgque poll loop calls it; on success it returns void; on
 * transient error it throws (so the caller can nack + schedule retry); on
 * permanent OAuth failure it writes the degradation row + throws.
 */
export async function processGooglePushJob(options: ProcessGooglePushOptions): Promise<void> {
  const { db, payload, fetchImpl = globalThis.fetch } = options;
  const { booking_id } = payload;

  // ------------------------------------------------------------------
  // 1. Load booking + provider in one query (avoids two round-trips)
  // ------------------------------------------------------------------
  const result = await db.query<BookingWithProvider>(
    `select
       b.id,
       b.provider_id,
       b.booker_email,
       b.booker_name,
       b.booker_notes,
       b.start_utc,
       b.end_utc,
       b.state,
       b.google_event_id,
       b.idempotency_key,
       p.id          as p_id,
       p.email       as p_email,
       p.home_tz     as p_home_tz,
       p.google_oauth_refresh_token as p_google_oauth_refresh_token,
       p.oauth_status as p_oauth_status
     from bookings b
     join providers p on p.id = b.provider_id
     where b.id = $1`,
    [booking_id],
  );

  if (result.rows.length === 0) {
    throw new Error(`google_push: booking ${booking_id} not found`);
  }

  const row = result.rows[0];

  // ------------------------------------------------------------------
  // 2. Skip if provider is paused (degraded or revoked)
  //    Per SPEC: "pause the queue for that provider — do not nack indefinitely"
  // ------------------------------------------------------------------
  if (row.p_oauth_status === "degraded" || row.p_oauth_status === "revoked") {
    console.warn(
      `google_push: skipping booking ${booking_id} — provider ${row.p_id} oauth_status=${row.p_oauth_status}`,
    );
    return;
  }

  // ------------------------------------------------------------------
  // 3. Skip if already confirmed (idempotency guard at the DB level)
  //    The calendarClient also handles 409 internally, but this avoids
  //    a redundant Google API call entirely on the second attempt.
  // ------------------------------------------------------------------
  if (row.state === "confirmed" && row.google_event_id !== null) {
    console.info(
      `google_push: booking ${booking_id} already confirmed with event ${row.google_event_id}, skipping`,
    );
    return;
  }

  // ------------------------------------------------------------------
  // 4. Refresh access token
  // ------------------------------------------------------------------
  if (!row.p_google_oauth_refresh_token) {
    throw new Error(`google_push: provider ${row.p_id} has no refresh token`);
  }

  let accessToken: string;
  try {
    const tokenResult = await exchangeRefreshToken(
      {
        clientId: process.env.GOOGLE_CLIENT_ID ?? "fixture-client-id",
        clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "fixture-client-secret",
        refreshToken: row.p_google_oauth_refresh_token,
      },
      fetchImpl,
    );
    accessToken = tokenResult.accessToken;
  } catch (err) {
    if (err instanceof OAuthInvalidGrantError || err instanceof OAuthScopeDowngradeError) {
      return handleOAuthFailure(db, row.p_id, row.p_email, booking_id, err as Error);
    }
    throw err;
  }

  // ------------------------------------------------------------------
  // 5. Build CalendarClient + call events.insert
  // ------------------------------------------------------------------
  const client = new CalendarClient({
    accessToken,
    calendarId: "primary",
    fetch: fetchImpl,
  });

  // HTML-escape booker_name (SPEC §Security: "HTML-escape booker_name everywhere rendered")
  const safeName = row.booker_name
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const resource: EventResource = {
    summary: `Booking: ${safeName}`,
    description: row.booker_notes
      ? row.booker_notes.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      : undefined,
    start: {
      dateTime: row.start_utc.toISOString(),
      timeZone: row.p_home_tz,
    },
    end: {
      dateTime: row.end_utc.toISOString(),
      timeZone: row.p_home_tz,
    },
    attendees: [{ email: row.booker_email }],
  };

  // requestId = idempotency_key + ":push" per SPEC §Idempotency
  const requestId = `${row.idempotency_key}:push`;

  let event: Awaited<ReturnType<CalendarClient["insert"]>>;
  try {
    event = await client.insert({ requestId, resource });
  } catch (err) {
    if (err instanceof OAuthTokenExpiredError) {
      // Two consecutive 401s — token is truly gone
      return handleOAuthFailure(db, row.p_id, row.p_email, booking_id, err as Error);
    }
    // GoogleApiError (5xx/429 exhausted), SyncTokenExpiredError, or anything
    // else — re-throw so the pgque batch gets nacked and retried.
    throw err;
  }

  // ------------------------------------------------------------------
  // 6. Update booking: state = confirmed, google_event_id = event.id
  // ------------------------------------------------------------------
  await db.query(
    `update bookings
        set state           = $1,
            google_event_id = $2,
            updated_at      = now()
      where id = $3`,
    ["confirmed", event.id, booking_id],
  );

  console.info(`google_push: booking ${booking_id} confirmed → google event ${event.id}`);
}
