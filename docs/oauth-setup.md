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
