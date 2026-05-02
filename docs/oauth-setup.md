# Google OAuth Setup Guide

This guide covers configuring real Google OAuth for production deployments.
In development and CI, a dev-mock provider at `/api/dev/oauth-google` is used
instead — no real Google credentials are required to run locally.

## Development (local-first)

The "Sign in with Google" button on `/admin/login` points to `/api/dev/oauth-google`
when `NODE_ENV !== "production"`. This route returns a fake session for the
`admin@calendry.local` user. No Google Cloud project needed.

## Production setup

### 1. Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com).
2. Create a new project (or use an existing one).
3. Enable the **Google Calendar API** under **APIs & Services → Library**.

### 2. Create OAuth 2.0 credentials

1. Navigate to **APIs & Services → Credentials**.
2. Click **Create credentials → OAuth 2.0 Client IDs**.
3. Application type: **Web application**.
4. Add the following **Authorized redirect URI**:
   ```
   https://your-domain.com/api/auth/callback/google
   ```
   Replace `your-domain.com` with your actual domain.
5. Copy the **Client ID** and **Client Secret**.

### 3. Configure GoTrue

Add the following to your GoTrue environment (via `docker-compose.yml` or your
deployment secrets manager):

```env
GOTRUE_EXTERNAL_GOOGLE_ENABLED=true
GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID=<your-client-id>
GOTRUE_EXTERNAL_GOOGLE_SECRET=<your-client-secret>
GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI=https://your-domain.com/api/auth/callback/google
```

### 4. Set application environment variables

In `.env.local` (or your secrets manager for production):

```env
GOOGLE_CLIENT_ID=<your-client-id>
GOOGLE_CLIENT_SECRET=<your-client-secret>
```

> **Security:** Never commit real OAuth client secrets. Use `.env.local`
> (gitignored) in development and a secrets manager in production.

### 5. Verify the flow

1. Start the application in production mode.
2. Navigate to `/admin/login`.
3. Click "Sign in with Google".
4. Complete the Google consent screen.
5. You should be redirected to `/admin` with a valid session.

## Scope requirements

Calendry requires the following OAuth scopes:

| Scope | Purpose |
|---|---|
| `openid` | Authentication |
| `email` | Admin login identity |
| `https://www.googleapis.com/auth/calendar` | Read/write Google Calendar events |

The Calendar API scope is requested during provider OAuth connect (Sprint 1+),
not at admin login time.

## Bring-your-own OAuth client (self-hosters)

Self-hosted instances **must** create their own Google Cloud project and OAuth
client. Google's default quotas apply per-project; shared clients are not
supported.

See [Google's quota documentation](https://developers.google.com/calendar/api/guides/quota)
for rate limit details.

---

## Google Calendar API — refresh token setup

This section walks the maintainer through obtaining the long-lived OAuth 2.0
refresh token that Calendry needs to write events to a Google Calendar.

### Prerequisites

- A Google account that owns or manages the calendar you want Calendry to
  write events to.
- A Google Cloud project with the **Google Calendar API** enabled.
- Billing is NOT required for the Calendar API at Calendry's expected volume.

---

### Step 1 — Create a Google Cloud project

1. Open https://console.cloud.google.com/
2. Click **Select a project → New Project**.
3. Name it (e.g. "Calendry") and click **Create**.

---

### Step 2 — Enable the Google Calendar API

1. In the project, go to **APIs & Services → Library**.
2. Search for "Google Calendar API" and click **Enable**.

---

### Step 3 — Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose **External** (or **Internal** if your Google Workspace org owns the calendar).
3. Fill in App name, support email, and developer email.
4. Click **Save and Continue** through the Scopes step (you'll add the scope
   in the next step).
5. Under **Scopes**, click **Add or Remove Scopes** and add:
   ```
   https://www.googleapis.com/auth/calendar
   ```
   This scope allows Calendry to create, read, update, and delete events on
   the provider's behalf.
6. **Add test users** (yourself) while the app is in "Testing" status.
   Google limits refresh tokens to 7 days for Testing apps unless the app
   is verified. For production, submit the app for verification or move
   to Internal (requires Google Workspace).

> **Note on verification:** for personal self-hosting with a Workspace org,
> use **Internal** and skip the verification step entirely — the 7-day limit
> does not apply.

---

### Step 4 — Create OAuth credentials

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Authorized redirect URIs — add both:
   - `http://localhost:4567/oauth/callback` (for local token capture)
   - Your production callback, e.g. `https://book.example.com/api/oauth/callback`
4. Click **Create**. Copy the **Client ID** and **Client Secret** — these go
   in `.env.local`:
   ```
   GOOGLE_CLIENT_ID=<paste here>
   GOOGLE_CLIENT_SECRET=<paste here>
   ```

---

### Step 5 — Obtain the refresh token (one-time)

Google does not expose refresh tokens in the Cloud Console. You must perform
a one-time OAuth authorization flow to obtain it.

#### Option A — Use the OAuth Playground (quickest for solo self-hosters)

1. Open https://developers.google.com/oauthplayground/
2. Click the gear icon (top right) → check **Use your own OAuth credentials**.
3. Enter your **Client ID** and **Client Secret** from Step 4.
4. In the Scope box on the left, enter:
   ```
   https://www.googleapis.com/auth/calendar
   ```
5. Click **Authorize APIs** → sign in with the calendar owner's Google account
   → click **Allow**.
6. Click **Exchange authorization code for tokens**.
7. Copy the **Refresh token** value. It starts with `1//`.

> **NEVER** commit the refresh token to git, post it in a GitHub issue, or
> include it in any PR comment. Treat it like a password.

#### Option B — Use the built-in OAuth callback (recommended for production)

When the Calendry web app is running, navigate to the admin UI and click
**Connect Google Calendar**. This performs the full OAuth flow via the
`/api/oauth/callback` route and stores the refresh token directly in the
database (`providers.google_oauth_refresh_token`). No manual copy-paste
required.

---

### Step 6 — Configure environment variables

Add the following to `.env.local` (gitignored):

```dotenv
GOOGLE_CLIENT_ID=<your client ID>
GOOGLE_CLIENT_SECRET=<your client secret>
GOOGLE_REFRESH_TOKEN=<your refresh token>       # used by the spike script only
GOOGLE_CALENDAR_ID=primary                       # or the specific calendar ID
```

For the deployed app, set these as secrets in your hosting environment. The
`GOOGLE_REFRESH_TOKEN` variable is only needed by the spike script
(`scripts/google-spike.ts`); the production app reads the refresh token from
the Postgres `providers` table.

---

### Step 7 — Verify with the spike script

```bash
GOOGLE_REFRESH_TOKEN=<your token> \
GOOGLE_CLIENT_ID=<your client id> \
GOOGLE_CLIENT_SECRET=<your client secret> \
bun scripts/google-spike.ts
```

Expected output:
```
GOOGLE_REFRESH_TOKEN present — running live round-trip against Google Calendar.
Calendar: primary

[1/3] OAuth token exchange (live) …
      access_token: [redacted, len=…]
      scope: https://www.googleapis.com/auth/calendar
[2/3] events.insert (live) …
      event.id: <google event id>
      event.status: confirmed
      event.htmlLink: https://www.google.com/calendar/event?eid=…
[3/3] events.delete (live) …
      deleted (204)

Live round-trip complete. Google Calendar event created and deleted successfully.
```

Without credentials (Sprint 0 / CI):
```bash
bun scripts/google-spike.ts
```
```
no creds — running against record/replay fixtures
…
Fixture round-trip complete. All fixture tests passed.
```

---

### Fixture capture procedure

Once real credentials are available, replace the synthetic fixtures with live
captures:

1. Run the spike with credentials to confirm the round-trip works.
2. Temporarily add `--capture` flag support to the spike, or intercept via
   a proxy (e.g. `mitmproxy`), to save raw HTTP responses.
3. Copy captured JSON into `packages/google/fixtures/`, matching the existing
   filenames exactly.
4. Run `bun test` to confirm all tests still pass (the fixture shapes are
   the contract).
5. Commit: `chore(google): refresh fixtures from live capture YYYY-MM-DD`

---

### Refresh token lifecycle

| Condition | Behavior |
|---|---|
| App in **Testing** mode | Token expires after 7 days |
| App **verified** or **Internal** (Workspace) | Token does not expire unless revoked |
| User revokes access | Token immediately invalid (`invalid_grant`) |
| User changes password | Token may be invalidated (Google policy varies) |
| No use for 6 months | Token may be invalidated (Google inactive-token policy) |

Calendry surfaces `invalid_grant` in the admin UI as a "Google Calendar
disconnected" banner and emails the provider with a re-authorization link.
See `packages/google/ERRORS.md` for the full error taxonomy.

---

### Bring-your-own-OAuth-client (for self-hosters)

If you self-host Calendry, you must supply your own Google OAuth client
credentials — you cannot use the maintainer's client ID/secret because they
are project-specific secrets. Follow Steps 1–5 above. This is a deliberate
design choice to avoid shared quota and to keep the self-host story clean.
See `docs/self-host.md` for the full self-host quickstart.
