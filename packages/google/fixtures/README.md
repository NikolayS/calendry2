# Google API Fixtures

Synthetic JSON that mirrors exact Google Calendar API / OAuth response shapes.
When real credentials arrive, each file is a 1:1 swap — capture the live
response and drop it here with no client-code changes.

## Capture procedure (for when real creds land)

1. Run `GOOGLE_REFRESH_TOKEN=<token> bun scripts/google-spike.ts --capture`
2. The spike writes raw responses into this directory, overwriting these
   synthetic files.
3. Commit: `chore(google): refresh fixtures from live capture YYYY-MM-DD`

---

## Files

### Happy-path sequence

| File | HTTP status | Description |
|---|---|---|
| `happy-path-token.json` | 200 | `POST https://oauth2.googleapis.com/token` — refresh token exchange returns an access token with `calendar` scope. |
| `happy-path-insert.json` | 200 | `POST .../events?requestId=<uuid>` — `events.insert` returns a full `calendar#event` resource. |
| `happy-path-patch.json` | 200 | `PATCH .../events/{eventId}` — `events.patch` returns the updated `calendar#event`. |
| `happy-path-list.json` | 200 | `GET .../events?syncToken=<token>` — `events.list` returns a `calendar#events` collection with `nextSyncToken`. |
| `happy-path-watch.json` | 200 | `POST .../events/watch` — `events.watch` returns a `api#channel` resource with `id`, `resourceId`, and `expiration`. |
| `happy-path-delete.json` | 204 | `DELETE .../events/{eventId}` — empty body, 204 No Content. |

### Failure-mode fixtures

| File | HTTP status | Error class thrown | Description |
|---|---|---|---|
| `error-invalid-grant.json` | 400 | `OAuthInvalidGrantError` | Token endpoint returns `{"error":"invalid_grant"}` — refresh token was revoked or expired. |
| `error-scope-downgrade.json` | 200 | `OAuthScopeDowngradeError` | Token endpoint returns 200 but `scope` field is missing `calendar` (only `calendar.readonly` present) — the user narrowed consent after initial OAuth. |
| `error-repeated-401.json` | 401 | `OAuthTokenExpiredError` | `events.insert` returns 401 twice in a row — access token rotated mid-flight; client throws after second 401. |
| `error-5xx-retry-after.json` | 503 | (retried; throws `GoogleApiError` after 5×) | `events.insert` returns 503 with a `Retry-After: 1` header; client honors the header and retries up to 5 times before giving up. |
| `error-409-duplicate.json` | 409 | (reconciled; no throw) | `events.insert` returns 409 `duplicate` — a request with the same `request_id` was already processed; client fetches the existing event by `request_id` and returns it. |
| `error-410-gone.json` | 410 | `SyncTokenExpiredError` | `events.list?syncToken=<stale>` returns 410 — sync token expired; caller must do a full resync. |

## Real-capture shape notes

- **Token response:** `Content-Type: application/json; charset=utf-8`. Fields:
  `access_token`, `expires_in` (seconds, integer), `scope` (space-separated),
  `token_type` ("Bearer"). No `refresh_token` in the response unless `access_type=offline`
  was passed and this is a first-grant — for refresh exchanges Google does NOT
  return a new refresh token unless rotation is configured.
- **Event resource:** all datetime fields are ISO 8601 strings. `start`/`end`
  have either `dateTime + timeZone` (timed events) or `date` (all-day). `id`
  is an opaque string, not a UUID.
- **events.list collection:** when `syncToken` is used, `nextPageToken` and
  `nextSyncToken` are mutually exclusive — `nextSyncToken` only appears on the
  last page.
- **409 response:** Google returns the duplicate error body shown; the
  `request_id` is echoed back as `location` in the error detail.
- **410 response:** Google returns this when a sync token is older than ~7
  days or was invalidated by a permissions change. Always do a full resync.
- **events.delete:** real response is 204 with an empty body (not `null`).
  The `happy-path-delete.json` fixture uses `null` as a placeholder; the
  client code treats any 204 as success regardless of body.
