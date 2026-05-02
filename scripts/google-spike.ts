#!/usr/bin/env bun
/**
 * google-spike.ts — Sprint 0 CLI spike for the Google Calendar client.
 *
 * Default (no env): fixture-replay mode. Simulates an OAuth → events.insert
 * → events.delete round-trip against the synthetic fixtures in
 * packages/google/fixtures/. Exits 0 on success.
 *
 * With GOOGLE_REFRESH_TOKEN set (deploy time only): performs a real OAuth
 * exchange then a real events.insert + events.delete round-trip against
 * the Google Calendar API test calendar.
 *
 * NEVER print OAuth tokens or refresh secrets.
 *
 * Usage:
 *   bun scripts/google-spike.ts                        # fixture-replay
 *   GOOGLE_REFRESH_TOKEN=... GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
 *     GOOGLE_CALENDAR_ID=primary bun scripts/google-spike.ts  # live
 */

import { CalendarClient } from "../packages/google/calendarClient";
import { exchangeRefreshToken } from "../packages/google/oauthClient";
import type { CalendarEvent } from "../packages/google/types";

// ---------------------------------------------------------------------------
// Fixture-replay mode helpers
// ---------------------------------------------------------------------------

import happyInsertFixture from "../packages/google/fixtures/happy-path-insert.json";
import happyTokenFixture from "../packages/google/fixtures/happy-path-token.json";

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFixtureFetch(): typeof globalThis.fetch {
  const handler: FetchHandler = async (url: string) => {
    // OAuth token endpoint
    if (url.includes("oauth2.googleapis.com/token")) {
      return jsonResponse(happyTokenFixture, 200);
    }
    // events.insert (POST .../events?requestId=...)
    if (url.includes("/events?requestId=")) {
      return jsonResponse(happyInsertFixture, 200);
    }
    // events.delete (DELETE .../events/<id>)
    if (url.includes("/events/") && !url.includes("/watch")) {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ error: "unexpected fixture call" }), { status: 500 });
  };
  return handler as unknown as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Fixture-replay round-trip
// ---------------------------------------------------------------------------

async function runFixtureReplay(): Promise<void> {
  console.log("no creds — running against record/replay fixtures");
  console.log();

  const mockFetch = makeFixtureFetch();

  // Step 1: OAuth exchange (fixture)
  console.log("[1/3] OAuth token exchange (fixture) …");
  const tokenResult = await exchangeRefreshToken(
    {
      clientId: "fixture-client-id",
      clientSecret: "fixture-client-secret",
      refreshToken: "fixture-refresh-token",
    },
    mockFetch,
  );
  console.log(`      access_token: [redacted, len=${tokenResult.accessToken.length}]`);
  console.log(`      scope: ${tokenResult.scope}`);

  // Step 2: events.insert (fixture)
  console.log("[2/3] events.insert (fixture) …");
  const client = new CalendarClient({
    accessToken: tokenResult.accessToken,
    calendarId: "primary",
    fetch: mockFetch,
  });
  const event: CalendarEvent = await client.insert({
    requestId: `spike-${Date.now()}`,
    resource: {
      summary: "Calendry spike fixture event",
      start: { dateTime: "2026-05-10T14:00:00+02:00", timeZone: "Europe/Madrid" },
      end: { dateTime: "2026-05-10T14:50:00+02:00", timeZone: "Europe/Madrid" },
    },
  });
  console.log(`      event.id: ${event.id}`);
  console.log(`      event.status: ${event.status}`);

  // Step 3: events.delete (fixture)
  console.log("[3/3] events.delete (fixture) …");
  await client.delete({ eventId: event.id });
  console.log("      deleted (204)");

  console.log();
  console.log("Fixture round-trip complete. All fixture tests passed.");
}

// ---------------------------------------------------------------------------
// Live round-trip (deploy-time only)
// ---------------------------------------------------------------------------

async function runLive(): Promise<void> {
  // GOOGLE_REFRESH_TOKEN is checked by hasCredentials before runLive() is called
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN ?? "";
  const clientId =
    process.env.GOOGLE_CLIENT_ID ??
    (() => {
      throw new Error("GOOGLE_CLIENT_ID required");
    })();
  const clientSecret =
    process.env.GOOGLE_CLIENT_SECRET ??
    (() => {
      throw new Error("GOOGLE_CLIENT_SECRET required");
    })();
  const calendarId = process.env.GOOGLE_CALENDAR_ID ?? "primary";

  console.log("GOOGLE_REFRESH_TOKEN present — running live round-trip against Google Calendar.");
  console.log(`Calendar: ${calendarId}`);
  console.log();

  // Step 1: OAuth
  console.log("[1/3] OAuth token exchange (live) …");
  const tokenResult = await exchangeRefreshToken({ clientId, clientSecret, refreshToken });
  console.log(`      access_token: [redacted, len=${tokenResult.accessToken.length}]`);
  console.log(`      scope: ${tokenResult.scope}`);

  // Step 2: events.insert
  console.log("[2/3] events.insert (live) …");
  const client = new CalendarClient({
    accessToken: tokenResult.accessToken,
    calendarId,
  });
  const requestId = `calendry-spike-${Date.now()}`;
  const event: CalendarEvent = await client.insert({
    requestId,
    resource: {
      summary: "Calendry Sprint 0 spike (safe to delete)",
      description: "Created by google-spike.ts — will be deleted immediately.",
      start: { dateTime: "2026-05-10T14:00:00+02:00", timeZone: "Europe/Madrid" },
      end: { dateTime: "2026-05-10T14:50:00+02:00", timeZone: "Europe/Madrid" },
    },
  });
  console.log(`      event.id: ${event.id}`);
  console.log(`      event.status: ${event.status}`);
  console.log(`      event.htmlLink: ${event.htmlLink ?? "(no link)"}`);

  // Step 3: events.delete
  console.log("[3/3] events.delete (live) …");
  await client.delete({ eventId: event.id });
  console.log("      deleted (204)");

  console.log();
  console.log("Live round-trip complete. Google Calendar event created and deleted successfully.");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const hasCredentials = Boolean(process.env.GOOGLE_REFRESH_TOKEN);

try {
  if (hasCredentials) {
    await runLive();
  } else {
    await runFixtureReplay();
  }
  process.exit(0);
} catch (err) {
  console.error("Spike failed:", err);
  process.exit(1);
}
