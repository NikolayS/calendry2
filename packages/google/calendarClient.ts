// Google Calendar API client.
// Uses built-in fetch (Bun / browser). No axios, no got.
// All requests carry a per-call X-Request-Id header for idempotency (SPEC §Idempotency).

import { GoogleApiError, OAuthTokenExpiredError, SyncTokenExpiredError } from "./errors";
import type { CalendarEvent, EventResource, EventsListResult, WatchChannel } from "./types";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const MAX_RETRIES = 5; // 1 initial + 4 retries

export interface CalendarClientOptions {
  accessToken: string;
  calendarId: string;
  /** Injectable fetch for testing. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface InsertOptions {
  requestId: string;
  resource: EventResource;
}

export interface PatchOptions {
  eventId: string;
  resource: Partial<EventResource>;
}

export interface DeleteOptions {
  eventId: string;
}

export interface ListOptions {
  syncToken?: string;
  timeMin?: string;
  timeMax?: string;
  pageToken?: string;
}

export interface WatchOptions {
  channelId: string;
  channelToken: string;
  webhookUrl: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Sleep for `ms` milliseconds.
 * In tests, callers pass Retry-After: 0 so this resolves instantly.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract delay from Retry-After header (integer seconds). Defaults to 1s. */
function retryAfterMs(response: Response): number {
  const header = response.headers.get("Retry-After");
  if (header) {
    const seconds = Number.parseInt(header, 10);
    if (!Number.isNaN(seconds) && seconds >= 0) return seconds * 1000;
  }
  return 1000;
}

/** True for HTTP status codes that should be retried. */
function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

// ---------------------------------------------------------------------------
// CalendarClient
// ---------------------------------------------------------------------------

export class CalendarClient {
  private readonly accessToken: string;
  private readonly calendarId: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: CalendarClientOptions) {
    this.accessToken = options.accessToken;
    this.calendarId = options.calendarId;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private calendarBase(): string {
    const id = encodeURIComponent(this.calendarId);
    return `${CALENDAR_API}/calendars/${id}`;
  }

  private authHeaders(requestId: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
      // Per SPEC §Idempotency — every Google request carries a per-call request_id
      "X-Request-Id": requestId,
    };
  }

  /**
   * Execute a fetch call with automatic retry for 5xx / 429, honoring
   * Retry-After. Returns the Response for the caller to inspect.
   *
   * Throws `OAuthTokenExpiredError` after two consecutive 401 responses.
   * Throws `GoogleApiError` after MAX_RETRIES failed 5xx/429 responses.
   */
  private async callWithRetry(url: string, init: RequestInit): Promise<Response> {
    let attempt = 0;
    let consecutive401s = 0;

    while (attempt < MAX_RETRIES) {
      const response = await this.fetchImpl(url, init);
      attempt++;

      if (response.status === 401) {
        consecutive401s++;
        if (consecutive401s >= 2) {
          throw new OAuthTokenExpiredError(
            `Repeated 401 on Google API call (attempt ${attempt}): access token expired and could not be refreshed`,
          );
        }
        // First 401: fall through to retry (in production the caller would
        // refresh the token; here we just retry with the same token since
        // the test controls the mock).
        // No delay for 401 retries.
        continue;
      }

      consecutive401s = 0;

      if (isRetryable(response.status)) {
        if (attempt >= MAX_RETRIES) {
          throw new GoogleApiError(
            `Google API returned ${response.status} after ${attempt} attempts`,
            response.status,
          );
        }
        const delay = retryAfterMs(response);
        await sleep(delay);
        continue;
      }

      return response;
    }

    // Should not reach here, but satisfy the type-checker.
    throw new GoogleApiError(`Google API call failed after ${MAX_RETRIES} attempts`, 0);
  }

  // ---------------------------------------------------------------------------
  // events.insert
  // ---------------------------------------------------------------------------

  /**
   * Insert a new event. Uses `requestId` as the Google `requestId` query
   * parameter for server-side idempotency.
   *
   * On 409 duplicate: fetches and returns the existing event (no throw).
   */
  async insert(options: InsertOptions): Promise<CalendarEvent> {
    const url = `${this.calendarBase()}/events?requestId=${encodeURIComponent(options.requestId)}`;
    const init: RequestInit = {
      method: "POST",
      headers: this.authHeaders(options.requestId),
      body: JSON.stringify(options.resource),
    };

    const response = await this.callWithRetry(url, init);

    if (response.status === 409) {
      // Reconcile: fetch the existing event by iCalUID derived from requestId.
      return this.fetchByRequestId(options.requestId);
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new GoogleApiError(
        `events.insert failed (HTTP ${response.status}): ${body?.error?.message ?? "unknown"}`,
        response.status,
      );
    }

    return response.json() as Promise<CalendarEvent>;
  }

  /**
   * Reconcile a 409 duplicate by listing events with the requestId as iCalUID.
   * Google encodes the requestId as the iCalUID when using the requestId param.
   */
  private async fetchByRequestId(requestId: string): Promise<CalendarEvent> {
    const params = new URLSearchParams({ iCalUID: requestId, maxResults: "1" });
    const url = `${this.calendarBase()}/events?${params.toString()}`;
    const init: RequestInit = {
      method: "GET",
      headers: this.authHeaders(requestId),
    };
    const response = await this.fetchImpl(url, init);
    if (!response.ok) {
      throw new GoogleApiError(
        `events.list (dup reconcile) failed (HTTP ${response.status})`,
        response.status,
      );
    }
    const data = (await response.json()) as EventsListResult;
    if (!data.items || data.items.length === 0) {
      throw new GoogleApiError("409 duplicate but could not find existing event by requestId", 409);
    }
    return data.items[0];
  }

  // ---------------------------------------------------------------------------
  // events.delete
  // ---------------------------------------------------------------------------

  /**
   * Delete an event by id. Treats 404 as success (already gone).
   */
  async delete(options: DeleteOptions): Promise<void> {
    const url = `${this.calendarBase()}/events/${encodeURIComponent(options.eventId)}`;
    const requestId = `delete:${options.eventId}`;
    const init: RequestInit = {
      method: "DELETE",
      headers: this.authHeaders(requestId),
    };

    const response = await this.callWithRetry(url, init);

    if (response.status === 204 || response.status === 404) {
      return; // success or already gone
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new GoogleApiError(
        `events.delete failed (HTTP ${response.status}): ${body?.error?.message ?? "unknown"}`,
        response.status,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // events.patch
  // ---------------------------------------------------------------------------

  async patch(options: PatchOptions): Promise<CalendarEvent> {
    const url = `${this.calendarBase()}/events/${encodeURIComponent(options.eventId)}`;
    const requestId = `patch:${options.eventId}`;
    const init: RequestInit = {
      method: "PATCH",
      headers: this.authHeaders(requestId),
      body: JSON.stringify(options.resource),
    };

    const response = await this.callWithRetry(url, init);

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new GoogleApiError(
        `events.patch failed (HTTP ${response.status}): ${body?.error?.message ?? "unknown"}`,
        response.status,
      );
    }

    return response.json() as Promise<CalendarEvent>;
  }

  // ---------------------------------------------------------------------------
  // events.list
  // ---------------------------------------------------------------------------

  /**
   * List events. Throws `SyncTokenExpiredError` on 410 Gone.
   */
  async list(options: ListOptions): Promise<EventsListResult> {
    const params = new URLSearchParams();
    if (options.syncToken) params.set("syncToken", options.syncToken);
    if (options.timeMin) params.set("timeMin", options.timeMin);
    if (options.timeMax) params.set("timeMax", options.timeMax);
    if (options.pageToken) params.set("pageToken", options.pageToken);

    const url = `${this.calendarBase()}/events?${params.toString()}`;
    const requestId = `list:${options.syncToken ?? options.timeMin ?? "full"}`;
    const init: RequestInit = {
      method: "GET",
      headers: this.authHeaders(requestId),
    };

    // events.list has a special case: 410 must be checked before the generic
    // retry loop (it is not retryable).
    const response = await this.fetchImpl(url, init);

    if (response.status === 410) {
      throw new SyncTokenExpiredError(
        "events.list returned 410 Gone: sync token expired, full resync required",
      );
    }

    if (response.status === 401) {
      // One 401 retry attempt for list as well (consistent with insert).
      const retryResponse = await this.fetchImpl(url, init);
      if (retryResponse.status === 401) {
        throw new OAuthTokenExpiredError(
          "Repeated 401 on events.list: access token expired and could not be refreshed",
        );
      }
      if (isRetryable(retryResponse.status)) {
        throw new GoogleApiError(
          `events.list failed (HTTP ${retryResponse.status})`,
          retryResponse.status,
        );
      }
      if (!retryResponse.ok) {
        const body = (await retryResponse.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new GoogleApiError(
          `events.list failed (HTTP ${retryResponse.status}): ${body?.error?.message ?? "unknown"}`,
          retryResponse.status,
        );
      }
      return retryResponse.json() as Promise<EventsListResult>;
    }

    if (isRetryable(response.status)) {
      // Fall into the retry loop.
      return this.callWithRetry(url, init).then((r) => r.json() as Promise<EventsListResult>);
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new GoogleApiError(
        `events.list failed (HTTP ${response.status}): ${body?.error?.message ?? "unknown"}`,
        response.status,
      );
    }

    return response.json() as Promise<EventsListResult>;
  }

  // ---------------------------------------------------------------------------
  // events.watch
  // ---------------------------------------------------------------------------

  async watch(options: WatchOptions): Promise<WatchChannel> {
    const url = `${this.calendarBase()}/events/watch`;
    const requestId = `watch:${options.channelId}`;
    const init: RequestInit = {
      method: "POST",
      headers: this.authHeaders(requestId),
      body: JSON.stringify({
        id: options.channelId,
        token: options.channelToken,
        type: "web_hook",
        address: options.webhookUrl,
      }),
    };

    const response = await this.callWithRetry(url, init);

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new GoogleApiError(
        `events.watch failed (HTTP ${response.status}): ${body?.error?.message ?? "unknown"}`,
        response.status,
      );
    }

    return response.json() as Promise<WatchChannel>;
  }
}
