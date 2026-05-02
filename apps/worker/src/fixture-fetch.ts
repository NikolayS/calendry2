// apps/worker/src/fixture-fetch.ts
//
// Fixture-replay fetch for dev/test when GOOGLE_REFRESH_TOKEN is unset.
// Returns responses from packages/google/fixtures/ based on request URL and
// body content, replicating the Google API and OAuth token endpoint behaviours
// documented in ERRORS.md.
//
// This is the local-first amendment from .samo/SPEC.amendments.md:
//   "dev/test must work without real Google credentials"

import errorInvalidGrant from "../../../packages/google/fixtures/error-invalid-grant.json";
import happyPathInsert from "../../../packages/google/fixtures/happy-path-insert.json";
import happyPathList from "../../../packages/google/fixtures/happy-path-list.json";
import happyPathToken from "../../../packages/google/fixtures/happy-path-token.json";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A fetch implementation that replays fixture JSON without hitting Google.
 *
 * Route table:
 *   POST https://oauth2.googleapis.com/token  → happy-path-token (200)
 *   POST .../events?requestId=...             → happy-path-insert (200)
 *   GET  .../events?...                       → happy-path-list (200)
 *   all other                                 → 404 with an explanatory message
 */
export async function fixtureFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = input.toString();

  // OAuth token exchange
  if (url.includes("oauth2.googleapis.com/token")) {
    const body = init?.body?.toString() ?? "";
    if (body.includes("invalid") || body.includes("revoked")) {
      return jsonResponse(errorInvalidGrant, 400);
    }
    return jsonResponse(happyPathToken, 200);
  }

  // Google Calendar API — events.insert (POST with requestId)
  if (url.includes("/events") && init?.method === "POST" && url.includes("requestId")) {
    return jsonResponse(happyPathInsert, 200);
  }

  // Google Calendar API — events.list (GET)
  if (url.includes("/events") && (!init?.method || init.method === "GET")) {
    return jsonResponse(happyPathList, 200);
  }

  // Google Calendar API — events.delete (DELETE)
  if (url.includes("/events/") && init?.method === "DELETE") {
    return new Response(null, { status: 204 });
  }

  // Google Calendar API — events.patch (PATCH)
  if (url.includes("/events/") && init?.method === "PATCH") {
    return jsonResponse(happyPathInsert, 200);
  }

  // Google Calendar API — events.watch (POST /events/watch)
  if (url.includes("/events/watch") && init?.method === "POST") {
    return jsonResponse(
      {
        kind: "api#channel",
        id: "fixture-channel-id",
        resourceId: "fixture-resource-id",
        expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      200,
    );
  }

  return new Response(JSON.stringify({ error: `fixture-fetch: no fixture for ${url}` }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}
