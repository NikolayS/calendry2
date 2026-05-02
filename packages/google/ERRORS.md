# Google Calendar Client — Error Taxonomy

Every error the client can throw, its trigger condition, and the required
action the caller must take. "Provider degraded" means set
`providers.oauth_status = 'degraded'`, pause `google_push` jobs for that
provider, and surface the issue in the admin UI + send a provider email.

---

## OAuth errors

### `OAuthInvalidGrantError`

**Trigger:** Token endpoint returns HTTP 400 with `{"error":"invalid_grant"}`.

**Cause:** The refresh token was revoked by the user (they removed Calendry
from their Google account permissions), expired (Google rotates refresh tokens
after 6 months of inactivity for non-verified apps), or was invalidated by a
password reset.

**Required action:** Mark provider degraded. The provider must re-authorize
via the OAuth flow. Do NOT retry — there is nothing to retry with.

---

### `OAuthScopeDowngradeError`

**Trigger:** Token endpoint returns HTTP 200 but the `scope` field in the
response does not include `https://www.googleapis.com/auth/calendar`.

**Cause:** The user narrowed their consent after initial authorization (e.g.,
unchecked "manage calendars" during a re-consent prompt). The access token is
valid but insufficient for write operations.

**Required action:** Mark provider degraded. The provider must re-authorize
with the full scope. Do NOT attempt calendar writes with the limited token —
they will fail with 403.

---

### `OAuthTokenExpiredError`

**Trigger:** Calendar API returns HTTP 401 twice in succession on the same
call (after the client has already attempted a token refresh between the first
and second 401).

**Cause:** Access token expired mid-flight and the refresh also failed (e.g.,
the refresh token was revoked between the first request and the retry). A
single 401 triggers a silent token refresh attempt; the second 401 indicates
the refresh token itself is no longer valid.

**Required action:** Mark provider degraded. Same recovery path as
`OAuthInvalidGrantError` — the provider must re-authorize.

---

## Calendar API errors

### `SyncTokenExpiredError`

**Trigger:** `events.list` returns HTTP 410 Gone.

**Cause:** The sync token is older than ~7 days, or was invalidated by a
Google-side event (permission change, calendar deletion/recreation). Google
requires a full resync.

**Required action:** Discard the stored sync token. Perform a full `events.list`
over the next 60-day window, store the resulting `nextSyncToken`. Do NOT retry
with the old token.

---

### `GoogleApiError`

**Trigger:** Any HTTP 5xx response from the Calendar API after all retries
are exhausted (default: 5 attempts with Retry-After / exponential backoff).

**Cause:** Google service degradation or quota exhaustion (429 is treated
identically to 5xx for retry purposes).

**Required action:** After 5 failed attempts, surface the failure to the
worker job and let it re-queue with its own backoff. Do NOT mark provider
degraded — this is a transient infrastructure issue, not an auth issue.

**Retry policy implemented by the client:**
- Honors `Retry-After` header (seconds) when present.
- Falls back to exponential backoff: 1s, 2s, 4s, 8s, 16s (jitter not applied
  in Sprint 0; add in Sprint 1 when real quotas matter).
- Maximum 5 attempts total (1 initial + 4 retries).

---

### `GoogleDuplicateRequestError` (internal — not re-thrown)

**Trigger:** `events.insert` returns HTTP 409 with `reason: "duplicate"`.

**Cause:** A request with the same `request_id` (idempotency key) was already
processed. Google is telling us the event already exists.

**Required action:** The client internally fetches the existing event by
`request_id` (via `events.list?iCalUID=<request_id>` or equivalent lookup)
and returns it to the caller as if the insert had succeeded. The caller sees
a normal event resource — no error is thrown. This is the correct idempotent
behavior for a worker that retried after a crash.

---

## Error class hierarchy

```
Error
└── CalendryGoogleError          (base — all errors below extend this)
    ├── OAuthInvalidGrantError   → mark provider degraded, re-auth required
    ├── OAuthScopeDowngradeError → mark provider degraded, re-auth required
    ├── OAuthTokenExpiredError   → mark provider degraded, re-auth required
    ├── SyncTokenExpiredError    → full resync required, NOT degraded
    └── GoogleApiError           → transient; retry at job level
```

## Mapping table

| HTTP status | Body / condition | Error thrown | Worker action |
|---|---|---|---|
| 400 | `{"error":"invalid_grant"}` | `OAuthInvalidGrantError` | Degrade provider, notify |
| 200 | scope missing `calendar` | `OAuthScopeDowngradeError` | Degrade provider, notify |
| 401 (2nd consecutive) | any | `OAuthTokenExpiredError` | Degrade provider, notify |
| 403 | `forbidden` | `GoogleApiError` | Surface; check scopes |
| 404 | on delete | success (no throw) | Event already gone; ok |
| 409 | `duplicate` | (none — reconciled internally) | Return existing event |
| 410 | on list | `SyncTokenExpiredError` | Full resync |
| 429 | rate limited | `GoogleApiError` (retry) | Retry with Retry-After |
| 5xx | any | `GoogleApiError` (retry) | Retry with backoff |
