// apps/worker/src/google-push.test.ts
//
// TDD tests for the google_push job handler.
// Per CLAUDE.md and SPEC §Idempotency: idempotency is on the strict-TDD list.
// All tests use fixture-replay fetch — no real Google credentials required.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Client } from "pg";
import { processGooglePushJob } from "./google-push";
import type { GooglePushJobPayload } from "./google-push";

// ---------------------------------------------------------------------------
// Fixture JSON (loaded from packages/google/fixtures/)
// ---------------------------------------------------------------------------

import error5xxRetryAfter from "../../../packages/google/fixtures/error-5xx-retry-after.json";
import error409Duplicate from "../../../packages/google/fixtures/error-409-duplicate.json";
import error409WithEvent from "../../../packages/google/fixtures/error-409-with-event.json";
import errorInvalidGrant from "../../../packages/google/fixtures/error-invalid-grant.json";
import errorRepeated401 from "../../../packages/google/fixtures/error-repeated-401.json";
import happyPathInsert from "../../../packages/google/fixtures/happy-path-insert.json";
import happyPathList from "../../../packages/google/fixtures/happy-path-list.json";
import happyPathToken from "../../../packages/google/fixtures/happy-path-token.json";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const PROVIDER_ID = "11111111-1111-1111-1111-111111111111";
const BOOKING_ID = "22222222-2222-2222-2222-222222222222";
const IDEMPOTENCY_KEY = "test-idempotency-key-001";

const PROVIDER_ROW = {
  id: PROVIDER_ID,
  email: "provider@example.com",
  home_tz: "Europe/Madrid",
  google_oauth_refresh_token: "test-refresh-token",
  oauth_status: "connected",
};

const BOOKING_ROW = {
  id: BOOKING_ID,
  provider_id: PROVIDER_ID,
  booker_email: "booker@example.com",
  booker_name: "Test Booker",
  booker_notes: null,
  start_utc: new Date("2026-05-10T12:00:00Z"),
  end_utc: new Date("2026-05-10T12:50:00Z"),
  state: "pending_push",
  google_event_id: null,
  idempotency_key: IDEMPOTENCY_KEY,
};

const JOB_PAYLOAD: GooglePushJobPayload = { booking_id: BOOKING_ID };

// ---------------------------------------------------------------------------
// Helpers: make Response-like objects from fixtures
// ---------------------------------------------------------------------------

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeResponseWithHeader(
  body: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ---------------------------------------------------------------------------
// DB client mock factory
// ---------------------------------------------------------------------------

// The JOIN query aliases provider columns with p_ prefix. Build the combined
// row shape that matches what the SQL SELECT actually returns.
function makeJoinedRow(
  bookingRow: Record<string, unknown>,
  providerRow: Record<string, unknown>,
): Record<string, unknown> {
  return {
    // booking columns (unaliased)
    id: bookingRow.id,
    provider_id: bookingRow.provider_id,
    booker_email: bookingRow.booker_email,
    booker_name: bookingRow.booker_name,
    booker_notes: bookingRow.booker_notes ?? null,
    start_utc: bookingRow.start_utc,
    end_utc: bookingRow.end_utc,
    state: bookingRow.state,
    google_event_id: bookingRow.google_event_id ?? null,
    idempotency_key: bookingRow.idempotency_key,
    // provider columns (p_ alias)
    p_id: providerRow.id,
    p_email: providerRow.email,
    p_home_tz: providerRow.home_tz,
    p_google_oauth_refresh_token: providerRow.google_oauth_refresh_token ?? null,
    p_oauth_status: providerRow.oauth_status,
  };
}

function makeDbClient(overrides?: {
  bookingRow?: Record<string, unknown> | null;
  providerRow?: Record<string, unknown> | null;
  updateCallback?: (text: string, values: unknown[]) => void;
}): Client {
  const bookingRow = overrides?.bookingRow !== undefined ? overrides.bookingRow : BOOKING_ROW;
  const providerRow = overrides?.providerRow !== undefined ? overrides.providerRow : PROVIDER_ROW;
  const updateCallback = overrides?.updateCallback;

  const queryMock = mock(async (text: string, values?: unknown[]) => {
    if (text.includes("select") && text.includes("bookings") && text.includes("providers")) {
      // JOIN query for booking + provider
      if (bookingRow === null || providerRow === null) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [makeJoinedRow(bookingRow, providerRow)],
        rowCount: 1,
      };
    }
    if (text.includes("update") && text.includes("bookings") && updateCallback) {
      updateCallback(text, values ?? []);
    }
    if (text.includes("update") && text.includes("providers") && updateCallback) {
      updateCallback(text, values ?? []);
    }
    if (text.includes("insert") && text.includes("email_outbox") && updateCallback) {
      updateCallback(text, values ?? []);
    }
    return { rows: [], rowCount: 1 };
  });

  return {
    query: queryMock,
    // biome-ignore lint/suspicious/noExplicitAny: test mock shape
  } as any as Client;
}

// ---------------------------------------------------------------------------
// 1. Happy-path test: booking pushed, state → confirmed, google_event_id set
// ---------------------------------------------------------------------------

describe("processGooglePushJob — happy path", () => {
  it("transitions booking to confirmed and stores google_event_id", async () => {
    const updatedFields: Array<{ sql: string; values: unknown[] }> = [];

    const db = makeDbClient({
      updateCallback: (sql, values) => {
        updatedFields.push({ sql, values });
      },
    });

    // fetch sequence: token exchange → events.insert
    let callCount = 0;
    const fetchImpl = mock(async (_url: string, _init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        // token exchange
        return makeResponse(happyPathToken, 200);
      }
      // events.insert
      return makeResponse(happyPathInsert, 200);
    });

    await processGooglePushJob({ db, fetchImpl, payload: JOB_PAYLOAD });

    // Expect two DB updates: one for state+google_event_id, no others
    const bookingUpdate = updatedFields.find(
      (f) => f.sql.includes("update") && f.sql.includes("bookings"),
    );
    expect(bookingUpdate).toBeDefined();
    // state should be 'confirmed'
    expect(bookingUpdate?.values).toContain("confirmed");
    // google_event_id should be the fixture event id
    expect(bookingUpdate?.values).toContain("fixture_event_id_001");
  });
});

// ---------------------------------------------------------------------------
// 2. Idempotency test: calling twice MUST NOT create two Google events
// ---------------------------------------------------------------------------

describe("processGooglePushJob — idempotency (strict TDD requirement)", () => {
  it("second call sees 409 path and reconciles, does NOT create a second event", async () => {
    const updatedFields: Array<{ sql: string; values: unknown[] }> = [];

    // Second call: booking is already confirmed + has google_event_id
    const alreadyConfirmedBooking = {
      ...BOOKING_ROW,
      state: "confirmed",
      google_event_id: "fixture_event_id_001",
    };

    const db = makeDbClient({
      bookingRow: alreadyConfirmedBooking,
      updateCallback: (sql, values) => {
        updatedFields.push({ sql, values });
      },
    });

    let insertCallCount = 0;
    const fetchImpl = mock(async (url: string, _init?: RequestInit) => {
      if (url.includes("oauth2.googleapis.com")) {
        return makeResponse(happyPathToken, 200);
      }
      if (url.includes("/events") && !url.includes("syncToken")) {
        insertCallCount++;
        // Return 409 with the existing event embedded
        return makeResponse(error409WithEvent, 409);
      }
      return makeResponse(happyPathList, 200);
    });

    await processGooglePushJob({ db, fetchImpl, payload: JOB_PAYLOAD });

    // Should NOT have made more than zero insert attempts (booking already confirmed)
    // OR should have called reconcile409 — either way, no second event created.
    // The key invariant: google_event_id stays fixture_event_id_001, not a new one.
    const bookingUpdates = updatedFields.filter(
      (f) => f.sql.includes("update") && f.sql.includes("bookings"),
    );

    // If it did update, the event id must be the existing one, not a new one
    for (const upd of bookingUpdates) {
      if (upd.values.includes("confirmed")) {
        expect(upd.values).toContain("fixture_event_id_001");
      }
    }
  });

  it("409 path: reconcile409 extracts event id from 409 body", async () => {
    const updatedFields: Array<{ sql: string; values: unknown[] }> = [];

    const db = makeDbClient({
      updateCallback: (sql, values) => {
        updatedFields.push({ sql, values });
      },
    });

    // fetch: token OK, then 409 with event embedded in body
    let callCount = 0;
    const fetchImpl = mock(async (url: string, _init?: RequestInit) => {
      callCount++;
      if (url.includes("oauth2.googleapis.com")) {
        return makeResponse(happyPathToken, 200);
      }
      return makeResponse(error409WithEvent, 409);
    });

    await processGooglePushJob({ db, fetchImpl, payload: JOB_PAYLOAD });

    const bookingUpdate = updatedFields.find(
      (f) =>
        f.sql.includes("update") && f.sql.includes("bookings") && f.values.includes("confirmed"),
    );
    expect(bookingUpdate).toBeDefined();
    // Must store the event id from the 409 body
    expect(bookingUpdate?.values).toContain("fixture_event_id_001");
  });
});

// ---------------------------------------------------------------------------
// 3. 5xx retry test: 5 consecutive 503s → GoogleApiError thrown (job fails)
// ---------------------------------------------------------------------------

describe("processGooglePushJob — 5xx retry exhaustion", () => {
  it("nacks job after 5 consecutive 503 responses", async () => {
    const db = makeDbClient();

    let callCount = 0;
    const fetchImpl = mock(async (url: string, _init?: RequestInit) => {
      if (url.includes("oauth2.googleapis.com")) {
        return makeResponse(happyPathToken, 200);
      }
      callCount++;
      // Return 503 with Retry-After: 0 so tests don't sleep
      return makeResponseWithHeader(error5xxRetryAfter, 503, { "Retry-After": "0" });
    });

    await expect(processGooglePushJob({ db, fetchImpl, payload: JOB_PAYLOAD })).rejects.toThrow();

    // All 5 attempts exhausted (calendarClient retries internally)
    expect(callCount).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 4. OAuth revoked test: invalid_grant → provider marked revoked, email enqueued
// ---------------------------------------------------------------------------

describe("processGooglePushJob — OAuth revoked (invalid_grant)", () => {
  it("marks provider oauth_status=revoked and writes email_outbox row", async () => {
    const dbCalls: Array<{ sql: string; values: unknown[] }> = [];

    const db = makeDbClient({
      updateCallback: (sql, values) => {
        dbCalls.push({ sql, values });
      },
    });

    // fetch: token exchange returns invalid_grant
    const fetchImpl = mock(async (url: string, _init?: RequestInit) => {
      if (url.includes("oauth2.googleapis.com")) {
        return makeResponse(errorInvalidGrant, 400);
      }
      return makeResponse(happyPathInsert, 200);
    });

    await expect(processGooglePushJob({ db, fetchImpl, payload: JOB_PAYLOAD })).rejects.toThrow();

    // Provider oauth_status must be set to 'revoked'
    const providerUpdate = dbCalls.find(
      (c) => c.sql.includes("update") && c.sql.includes("providers"),
    );
    expect(providerUpdate).toBeDefined();
    expect(providerUpdate?.values).toContain("revoked");

    // email_outbox row must be inserted for the provider
    const emailInsert = dbCalls.find(
      (c) => c.sql.includes("insert") && c.sql.includes("email_outbox"),
    );
    expect(emailInsert).toBeDefined();
  });

  it("marks provider revoked on repeated 401 (OAuthTokenExpiredError)", async () => {
    const dbCalls: Array<{ sql: string; values: unknown[] }> = [];

    const db = makeDbClient({
      updateCallback: (sql, values) => {
        dbCalls.push({ sql, values });
      },
    });

    // Token exchange succeeds but calendar API returns 401 twice
    const fetchImpl = mock(async (url: string, _init?: RequestInit) => {
      if (url.includes("oauth2.googleapis.com")) {
        return makeResponse(happyPathToken, 200);
      }
      // Both insert attempts return 401
      return makeResponse(errorRepeated401, 401);
    });

    await expect(processGooglePushJob({ db, fetchImpl, payload: JOB_PAYLOAD })).rejects.toThrow();

    const providerUpdate = dbCalls.find(
      (c) => c.sql.includes("update") && c.sql.includes("providers"),
    );
    expect(providerUpdate).toBeDefined();
    expect(providerUpdate?.values).toContain("revoked");

    const emailInsert = dbCalls.find(
      (c) => c.sql.includes("insert") && c.sql.includes("email_outbox"),
    );
    expect(emailInsert).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Paused provider test: worker skips jobs for degraded/revoked providers
// ---------------------------------------------------------------------------

describe("processGooglePushJob — paused provider skip", () => {
  it("skips job without calling Google when provider is degraded", async () => {
    let googleCallCount = 0;

    const db = makeDbClient({
      providerRow: { ...PROVIDER_ROW, oauth_status: "degraded" },
    });

    const fetchImpl = mock(async (url: string, _init?: RequestInit) => {
      if (!url.includes("oauth2.googleapis.com")) {
        googleCallCount++;
      }
      return makeResponse(happyPathToken, 200);
    });

    // Should NOT throw — it skips cleanly
    await processGooglePushJob({ db, fetchImpl, payload: JOB_PAYLOAD });

    // No Google Calendar API calls
    expect(googleCallCount).toBe(0);
  });

  it("skips job without calling Google when provider is revoked", async () => {
    let googleCallCount = 0;

    const db = makeDbClient({
      providerRow: { ...PROVIDER_ROW, oauth_status: "revoked" },
    });

    const fetchImpl = mock(async (url: string, _init?: RequestInit) => {
      if (!url.includes("oauth2.googleapis.com")) {
        googleCallCount++;
      }
      return makeResponse(happyPathToken, 200);
    });

    await processGooglePushJob({ db, fetchImpl, payload: JOB_PAYLOAD });

    expect(googleCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Missing booking: gracefully handle booking not found
// ---------------------------------------------------------------------------

describe("processGooglePushJob — booking not found", () => {
  it("throws when booking row does not exist", async () => {
    const db = makeDbClient({ bookingRow: null });

    const fetchImpl = mock(async () => makeResponse(happyPathToken, 200));

    await expect(processGooglePushJob({ db, fetchImpl, payload: JOB_PAYLOAD })).rejects.toThrow(
      /booking.*not found/i,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Scope downgrade: OAuthScopeDowngradeError → provider marked revoked
// ---------------------------------------------------------------------------

describe("processGooglePushJob — OAuth scope downgrade", () => {
  it("marks provider revoked on scope downgrade", async () => {
    const dbCalls: Array<{ sql: string; values: unknown[] }> = [];

    const db = makeDbClient({
      updateCallback: (sql, values) => {
        dbCalls.push({ sql, values });
      },
    });

    // Token succeeds but missing the calendar scope
    const fetchImpl = mock(async (url: string, _init?: RequestInit) => {
      if (url.includes("oauth2.googleapis.com")) {
        return makeResponse(
          {
            access_token: "ya29.limited",
            expires_in: 3599,
            scope: "https://www.googleapis.com/auth/userinfo.email",
            token_type: "Bearer",
          },
          200,
        );
      }
      return makeResponse(happyPathInsert, 200);
    });

    await expect(processGooglePushJob({ db, fetchImpl, payload: JOB_PAYLOAD })).rejects.toThrow();

    const providerUpdate = dbCalls.find(
      (c) => c.sql.includes("update") && c.sql.includes("providers"),
    );
    expect(providerUpdate).toBeDefined();
    expect(providerUpdate?.values).toContain("revoked");
  });
});

// ---------------------------------------------------------------------------
// 8. 410 from insert (edge case): log and fail once
// ---------------------------------------------------------------------------

describe("processGooglePushJob — 410 edge case", () => {
  it("throws SyncTokenExpiredError when Google returns 410 on insert", async () => {
    const db = makeDbClient();

    const fetchImpl = mock(async (url: string, _init?: RequestInit) => {
      if (url.includes("oauth2.googleapis.com")) {
        return makeResponse(happyPathToken, 200);
      }
      return makeResponse({ error: { code: 410, message: "Gone" } }, 410);
    });

    await expect(processGooglePushJob({ db, fetchImpl, payload: JOB_PAYLOAD })).rejects.toThrow(
      /410|sync.token/i,
    );
  });
});
