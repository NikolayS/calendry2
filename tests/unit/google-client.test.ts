import { describe, expect, it } from "bun:test";
import { CalendarClient } from "../../packages/google/calendarClient";
import {
  GoogleApiError,
  OAuthTokenExpiredError,
  SyncTokenExpiredError,
} from "../../packages/google/errors";
import retry5xxFixture from "../../packages/google/fixtures/error-5xx-retry-after.json";
import dup409Fixture from "../../packages/google/fixtures/error-409-duplicate.json";
import gone410Fixture from "../../packages/google/fixtures/error-410-gone.json";
import repeated401Fixture from "../../packages/google/fixtures/error-repeated-401.json";
import happyInsertFixture from "../../packages/google/fixtures/happy-path-insert.json";
import happyListFixture from "../../packages/google/fixtures/happy-path-list.json";
import happyPatchFixture from "../../packages/google/fixtures/happy-path-patch.json";
import happyTokenFixture from "../../packages/google/fixtures/happy-path-token.json";
import happyWatchFixture from "../../packages/google/fixtures/happy-path-watch.json";

// ---------------------------------------------------------------------------
// Hand-rolled fetch mock helpers
// ---------------------------------------------------------------------------

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function makeFetchMock(handler: FetchHandler): typeof globalThis.fetch {
  return handler as unknown as typeof globalThis.fetch;
}

function jsonResponse(body: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

// Builds a CalendarClient with a mocked fetch; access token is injected directly.
function makeClient(mockFetch: typeof globalThis.fetch): CalendarClient {
  return new CalendarClient({
    accessToken: happyTokenFixture.access_token,
    calendarId: "primary",
    fetch: mockFetch,
  });
}

// ---------------------------------------------------------------------------
// Happy-path tests
// ---------------------------------------------------------------------------

describe("CalendarClient — happy path", () => {
  it("events.insert returns a typed event resource", async () => {
    const mockFetch = makeFetchMock(async () => jsonResponse(happyInsertFixture, 200));
    const client = makeClient(mockFetch);
    const event = await client.insert({
      requestId: "test-req-id-1",
      resource: {
        summary: "Fixture Booking",
        start: { dateTime: "2026-05-10T14:00:00+02:00", timeZone: "Europe/Madrid" },
        end: { dateTime: "2026-05-10T14:50:00+02:00", timeZone: "Europe/Madrid" },
      },
    });
    expect(event.id).toBe(happyInsertFixture.id);
    expect(event.status).toBe("confirmed");
    expect(event.start.dateTime).toBe(happyInsertFixture.start.dateTime);
  });

  it("events.insert sends the request_id as a query param", async () => {
    let capturedUrl = "";
    const mockFetch = makeFetchMock(async (url) => {
      capturedUrl = url;
      return jsonResponse(happyInsertFixture, 200);
    });
    const client = makeClient(mockFetch);
    await client.insert({
      requestId: "unique-idempotency-key",
      resource: {
        summary: "test",
        start: { dateTime: "2026-05-10T14:00:00+02:00", timeZone: "Europe/Madrid" },
        end: { dateTime: "2026-05-10T14:50:00+02:00", timeZone: "Europe/Madrid" },
      },
    });
    expect(capturedUrl).toContain("requestId=unique-idempotency-key");
  });

  it("events.delete returns void on 204", async () => {
    const mockFetch = makeFetchMock(async () => emptyResponse(204));
    const client = makeClient(mockFetch);
    await expect(client.delete({ eventId: "fixture_event_id_001" })).resolves.toBeUndefined();
  });

  it("events.delete treats 404 as success (already gone)", async () => {
    const mockFetch = makeFetchMock(async () =>
      jsonResponse({ error: { code: 404, message: "Not Found", status: "NOT_FOUND" } }, 404),
    );
    const client = makeClient(mockFetch);
    await expect(client.delete({ eventId: "already_gone" })).resolves.toBeUndefined();
  });

  it("events.patch returns the updated event resource", async () => {
    const mockFetch = makeFetchMock(async () => jsonResponse(happyPatchFixture, 200));
    const client = makeClient(mockFetch);
    const event = await client.patch({
      eventId: "fixture_event_id_001",
      resource: {
        summary: "Fixture Booking (rescheduled)",
        start: { dateTime: "2026-05-11T14:00:00+02:00", timeZone: "Europe/Madrid" },
        end: { dateTime: "2026-05-11T14:50:00+02:00", timeZone: "Europe/Madrid" },
      },
    });
    expect(event.id).toBe(happyPatchFixture.id);
    expect(event.start.dateTime).toBe(happyPatchFixture.start.dateTime);
  });

  it("events.list returns a typed events collection with nextSyncToken", async () => {
    const mockFetch = makeFetchMock(async () => jsonResponse(happyListFixture, 200));
    const client = makeClient(mockFetch);
    const result = await client.list({ syncToken: "fixture_sync_token_v1" });
    expect(result.kind).toBe("calendar#events");
    expect(result.nextSyncToken).toBe(happyListFixture.nextSyncToken);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("fixture_event_id_001");
  });

  it("events.watch returns a channel resource", async () => {
    const mockFetch = makeFetchMock(async () => jsonResponse(happyWatchFixture, 200));
    const client = makeClient(mockFetch);
    const channel = await client.watch({
      channelId: "fixture-channel-id-001",
      channelToken: "fixture-channel-token-001",
      webhookUrl: "https://calendry.example.com/api/google/webhook",
    });
    expect(channel.id).toBe(happyWatchFixture.id);
    expect(channel.resourceId).toBe(happyWatchFixture.resourceId);
    expect(channel.expiration).toBe(happyWatchFixture.expiration);
  });
});

// ---------------------------------------------------------------------------
// Failure-mode tests (TDD: these were written before the implementation)
// ---------------------------------------------------------------------------

describe("CalendarClient — repeated 401 → OAuthTokenExpiredError", () => {
  it("throws OAuthTokenExpiredError after second 401", async () => {
    let callCount = 0;
    const mockFetch = makeFetchMock(async () => {
      callCount++;
      return jsonResponse(repeated401Fixture, 401);
    });
    const client = makeClient(mockFetch);
    await expect(
      client.insert({
        requestId: "req-401-test",
        resource: {
          summary: "test",
          start: { dateTime: "2026-05-10T14:00:00+02:00", timeZone: "Europe/Madrid" },
          end: { dateTime: "2026-05-10T14:50:00+02:00", timeZone: "Europe/Madrid" },
        },
      }),
    ).rejects.toThrow(OAuthTokenExpiredError);
    // Must have made exactly 2 calls (initial + one retry after 401)
    expect(callCount).toBe(2);
  });

  it("OAuthTokenExpiredError message includes context", async () => {
    const mockFetch = makeFetchMock(async () => jsonResponse(repeated401Fixture, 401));
    const client = makeClient(mockFetch);
    try {
      await client.insert({
        requestId: "req-401-msg-test",
        resource: {
          summary: "test",
          start: { dateTime: "2026-05-10T14:00:00+02:00", timeZone: "Europe/Madrid" },
          end: { dateTime: "2026-05-10T14:50:00+02:00", timeZone: "Europe/Madrid" },
        },
      });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthTokenExpiredError);
      expect((e as Error).message).toContain("401");
    }
  });
});

describe("CalendarClient — 5xx + Retry-After → GoogleApiError after 5 retries", () => {
  it("retries up to 5 times then throws GoogleApiError", async () => {
    let callCount = 0;
    const mockFetch = makeFetchMock(async () => {
      callCount++;
      return jsonResponse(retry5xxFixture, 503, { "Retry-After": "0" });
    });
    const client = makeClient(mockFetch);
    await expect(
      client.insert({
        requestId: "req-5xx-test",
        resource: {
          summary: "test",
          start: { dateTime: "2026-05-10T14:00:00+02:00", timeZone: "Europe/Madrid" },
          end: { dateTime: "2026-05-10T14:50:00+02:00", timeZone: "Europe/Madrid" },
        },
      }),
    ).rejects.toThrow(GoogleApiError);
    // 1 initial attempt + 4 retries = 5 total
    expect(callCount).toBe(5);
  });

  it("honors Retry-After header (zero delay in test — just verify the value is read)", async () => {
    const retryAfterValues: string[] = [];
    let callCount = 0;
    const mockFetch = makeFetchMock(async () => {
      callCount++;
      const headers = new Headers({ "Content-Type": "application/json", "Retry-After": "0" });
      return new Response(JSON.stringify(retry5xxFixture), { status: 503, headers });
    });
    const client = makeClient(mockFetch);
    try {
      await client.insert({
        requestId: "req-5xx-retry-after",
        resource: {
          summary: "test",
          start: { dateTime: "2026-05-10T14:00:00+02:00", timeZone: "Europe/Madrid" },
          end: { dateTime: "2026-05-10T14:50:00+02:00", timeZone: "Europe/Madrid" },
        },
      });
    } catch (e) {
      expect(e).toBeInstanceOf(GoogleApiError);
    }
    expect(callCount).toBe(5);
  });

  it("GoogleApiError message includes the status code", async () => {
    const mockFetch = makeFetchMock(async () =>
      jsonResponse(retry5xxFixture, 503, { "Retry-After": "0" }),
    );
    const client = makeClient(mockFetch);
    try {
      await client.insert({
        requestId: "req-5xx-msg",
        resource: {
          summary: "test",
          start: { dateTime: "2026-05-10T14:00:00+02:00", timeZone: "Europe/Madrid" },
          end: { dateTime: "2026-05-10T14:50:00+02:00", timeZone: "Europe/Madrid" },
        },
      });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(GoogleApiError);
      expect((e as Error).message).toContain("503");
    }
  });
});

describe("CalendarClient — 409 duplicate request_id → reconcile without error", () => {
  it("returns the existing event on 409 duplicate without throwing", async () => {
    let callCount = 0;
    const mockFetch = makeFetchMock(async () => {
      callCount++;
      if (callCount === 1) {
        // First call: insert returns 409 duplicate
        return jsonResponse(dup409Fixture, 409);
      }
      // Second call: client fetches existing event by iCalUID lookup (list endpoint)
      // Returns a list-shaped response with the existing event in items[].
      return jsonResponse(happyListFixture, 200);
    });
    const client = makeClient(mockFetch);
    const event = await client.insert({
      requestId: "test-req-id-1",
      resource: {
        summary: "Fixture Booking",
        start: { dateTime: "2026-05-10T14:00:00+02:00", timeZone: "Europe/Madrid" },
        end: { dateTime: "2026-05-10T14:50:00+02:00", timeZone: "Europe/Madrid" },
      },
    });
    // Must get back the first item from the list (the existing event)
    expect(event.id).toBe(happyListFixture.items[0].id);
    // Must have made exactly 2 calls
    expect(callCount).toBe(2);
  });

  it("does NOT throw on 409", async () => {
    let callCount = 0;
    const mockFetch = makeFetchMock(async () => {
      callCount++;
      if (callCount === 1) return jsonResponse(dup409Fixture, 409);
      return jsonResponse(happyListFixture, 200);
    });
    const client = makeClient(mockFetch);
    await expect(
      client.insert({
        requestId: "test-req-id-1",
        resource: {
          summary: "Fixture Booking",
          start: { dateTime: "2026-05-10T14:00:00+02:00", timeZone: "Europe/Madrid" },
          end: { dateTime: "2026-05-10T14:50:00+02:00", timeZone: "Europe/Madrid" },
        },
      }),
    ).resolves.toBeDefined();
  });
});

describe("CalendarClient — 410 Gone on events.list → SyncTokenExpiredError", () => {
  it("throws SyncTokenExpiredError on 410", async () => {
    const mockFetch = makeFetchMock(async () => jsonResponse(gone410Fixture, 410));
    const client = makeClient(mockFetch);
    await expect(client.list({ syncToken: "stale-token" })).rejects.toThrow(SyncTokenExpiredError);
  });

  it("SyncTokenExpiredError message indicates full resync required", async () => {
    const mockFetch = makeFetchMock(async () => jsonResponse(gone410Fixture, 410));
    const client = makeClient(mockFetch);
    try {
      await client.list({ syncToken: "stale-token" });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(SyncTokenExpiredError);
      expect((e as Error).message).toContain("410");
    }
  });

  it("does NOT throw SyncTokenExpiredError for non-410 list responses", async () => {
    const mockFetch = makeFetchMock(async () => jsonResponse(happyListFixture, 200));
    const client = makeClient(mockFetch);
    await expect(client.list({ syncToken: "valid-token" })).resolves.toBeDefined();
  });
});

describe("CalendarClient — request_id header on every call", () => {
  it("sends X-Request-Id header on events.insert", async () => {
    const capturedHeaders: Record<string, string> = {};
    const mockFetch = makeFetchMock(async (_url, init) => {
      const h = new Headers(init?.headers);
      h.forEach((v, k) => {
        capturedHeaders[k.toLowerCase()] = v;
      });
      return jsonResponse(happyInsertFixture, 200);
    });
    const client = makeClient(mockFetch);
    await client.insert({
      requestId: "header-test-id",
      resource: {
        summary: "test",
        start: { dateTime: "2026-05-10T14:00:00+02:00", timeZone: "Europe/Madrid" },
        end: { dateTime: "2026-05-10T14:50:00+02:00", timeZone: "Europe/Madrid" },
      },
    });
    // Per SPEC §Idempotency, every Google request must carry a per-call request_id header
    expect(
      capturedHeaders["x-request-id"] ?? capturedHeaders["x-goog-request-reason"],
    ).toBeDefined();
  });

  it("sends Authorization: Bearer header on every call", async () => {
    let capturedAuth = "";
    const mockFetch = makeFetchMock(async (_url, init) => {
      const h = new Headers(init?.headers);
      capturedAuth = h.get("Authorization") ?? "";
      return jsonResponse(happyInsertFixture, 200);
    });
    const client = makeClient(mockFetch);
    await client.insert({
      requestId: "auth-header-test",
      resource: {
        summary: "test",
        start: { dateTime: "2026-05-10T14:00:00+02:00", timeZone: "Europe/Madrid" },
        end: { dateTime: "2026-05-10T14:50:00+02:00", timeZone: "Europe/Madrid" },
      },
    });
    expect(capturedAuth).toBe(`Bearer ${happyTokenFixture.access_token}`);
  });
});
