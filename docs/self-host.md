# Calendry — Self-Host Quickstart

> **Sprint 1 prose draft.** Sections 1–10 are fully written. Screenshots and the
> Cloudflare panel walkthrough are deferred to Sprint 3. Every command in this
> guide has been verified against `main` at PR-open time.
>
> **Track C (booking UI) dependency:** the smoke-test section (§9) currently
> documents the curl-based API flow because Track C's public booking UI has not
> yet merged to `main`. Once Track C lands, §9 will be updated to show the
> browser flow instead.

---

## 1. Prerequisites

You need the following tools and accounts installed or provisioned before you
start. Each one is load-bearing; do not skip.

**Bun** (latest stable) is the runtime for the Calendry worker process and for
running migration scripts and tests. Install it with:

```bash
curl -fsSL https://bun.sh/install | bash
```

After installation, open a new shell and confirm `bun --version` prints a
version string. Bun is used instead of Node for the worker because it has a
built-in test runner, a fast module resolver, and first-class TypeScript support
without a separate compile step. The Next.js web app is built by Bun as well and
served by the standalone Node.js output that `next build` emits.

**Docker and Docker Compose v2** are required to run the full self-hosted
Supabase stack (Postgres, GoTrue, PostgREST, Realtime, Studio, Mailpit) plus the
Calendry web and worker containers — all defined in `ops/docker-compose.yml`.
Install Docker Desktop (macOS/Windows) or Docker Engine + the Compose plugin
(Linux). Confirm both with `docker --version` and `docker compose version`; you
need Compose v2 (`docker compose`, not `docker-compose`).

**A domain you control** is needed for two things: the Google OAuth redirect URI
(which must be an `https://` address) and TLS termination via Cloudflare. A
subdomain of a domain you already own is fine — for example `book.example.com`.
For local development you can skip this and use `http://localhost:3000`, but you
will not be able to complete the Google OAuth flow without a real HTTPS URL.

**A Cloudflare account** is the documented DNS and SSL layer for Calendry. You
will point your domain's nameservers at Cloudflare, add an A record for your
(sub)domain, and configure SSL/TLS "Full (strict)" mode with an origin
certificate. If your server does not have a public IP (home lab, laptop), the
Cloudflare Tunnel option in §5 covers that case. A free Cloudflare plan is
sufficient. See §5 for the full walkthrough.

**A Google Cloud project** with the Google Calendar API enabled and an OAuth 2.0
client credential pair (`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`) is
required before provider onboarding (§8). You need this to allow Calendry to
write events to the provider's Google Calendar. Full instructions are in
`docs/oauth-setup.md`; §6 below cross-links the relevant sections.

**A Resend account** is the default transactional email provider for booking
confirmations, reminders, conflict notifications, and magic-link admin
authentication emails. Resend is not required for local development — the
in-stack Mailpit container captures all outgoing email. For a production deploy
you need a Resend API key and a verified sender domain. See §7.

---

## 2. Clone + env

Clone the repository and create your local env file:

```bash
git clone https://github.com/NikolayS/calendry2.git
cd calendry2
cp .env.example .env.local
```

`.env.local` is gitignored. Never commit it. Never put real secrets in
`.env.example` or any committed file.

Open `.env.local` in an editor. The variables fall into three groups:

### 2a. Must set before first boot

These variables need to exist in `.env.local` before you run
`docker compose up` for the first time. If they are missing, the containers will
start but GoTrue will reject requests, CSRF tokens will be insecure, and signing
operations will silently use weak defaults.

**`POSTGRES_PASSWORD`** — the password for the `postgres` superuser. In
development the default (`postgres`) is fine. In production use a strong random
value.

**`SUPABASE_JWT_SECRET`** and **`GOTRUE_JWT_SECRET`** — both must be set to the
same random string. This is the master secret that GoTrue uses to sign JWTs and
that PostgREST uses to verify them. Generate one value and assign it to both
variables:

```bash
openssl rand -base64 32
```

**`CSRF_SECRET`** — HMAC secret for the CSRF middleware in the Next.js app.
Generate with `openssl rand -base64 32`.

**`BOOKING_TOKEN_SECRET`** — HMAC secret used to sign cancel/reschedule tokens
that are embedded in confirmation emails. If unset, the app falls back to an
insecure dev default and logs a warning at startup. Generate with
`openssl rand -base64 32`. This variable ships under the name
`BOOKING_TOKEN_SECRET` (see PR #23).

**`NEXT_PUBLIC_URL`** — the full `https://` URL of your instance, no trailing
slash. Example: `https://book.example.com`. In local dev you can use
`http://localhost:3000`.

**`GOTRUE_SITE_URL`** — should be the same value as `NEXT_PUBLIC_URL`. GoTrue
embeds this in magic-link emails so the confirmation link resolves to the right
host.

**`DASHBOARD_PASSWORD`** — the Supabase Studio dashboard login password. Set
this to anything non-default before first boot to avoid leaving Studio
accessible with the default `admin`/`admin` credentials.

Also set the three internal service role passwords if you want them to be
non-default (recommended for any internet-facing deploy):

```
SUPABASE_AUTH_ADMIN_PASSWORD=<strong random value>
AUTHENTICATOR_PASSWORD=<strong random value>
SUPABASE_STORAGE_ADMIN_PASSWORD=<strong random value>
```

These passwords are set on the Postgres roles by the init script
`ops/postgres-init/00-supabase-roles.sql` at container first-start. The
Postgres data volume is created at first boot; if you change these after
the volume already exists, the init script will not re-run. To apply new
passwords on an existing volume, connect to Postgres directly and run
`ALTER ROLE <role> WITH ENCRYPTED PASSWORD '<new>'`.

### 2b. Set after first boot

The Supabase keys (`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`) are generated by the GoTrue/PostgREST stack at
startup. After running `docker compose up -d` for the first time, you will need
to copy these values from the GoTrue logs into `.env.local` and then restart the
`web` and `worker` services. §3 below explains exactly how to do this.

### 2c. Production-only additions

**`RESEND_API_KEY`** — Resend API key for transactional email. Set
`EMAIL_DRIVER=resend` alongside it. Leave unset in local dev; the default
`EMAIL_DRIVER=smtp` routes all mail to the in-stack Mailpit container.

**`EMAIL_FROM`** — the sender address, e.g. `noreply@book.example.com`. In
production this must be a Resend-verified sender domain. In dev any address
works because Mailpit accepts everything.

**`GOOGLE_CLIENT_ID`** and **`GOOGLE_CLIENT_SECRET`** — your Google OAuth client
credentials. Required before the provider can connect their Google Calendar in
§8.

**`SMTP_USER`**, **`SMTP_PASSWORD`**, **`SMTP_SECURE`** — only needed if you are
routing production email through an external SMTP relay instead of Resend. Leave
these blank for local dev.

### Rate-limit knobs

The booking POST endpoint is rate-limited out of the box:

```
RATE_LIMIT_BOOKING_IP_PER_MIN=10    # requests per IP per minute (default: 10)
RATE_LIMIT_BOOKING_EMAIL_PER_MIN=3  # requests per booker email per minute (default: 3)
```

The defaults are conservative. Corporate networks that share a NAT IP may hit
the IP limit; increase `RATE_LIMIT_BOOKING_IP_PER_MIN` for those deployments.
See `SPEC.md §Risks` for the trade-off discussion.

---

## 3. Compose up

Start all services:

```bash
docker compose -f ops/docker-compose.yml --env-file .env.local up -d
```

Docker will pull the required images on first run (expect 1–3 minutes on a fast
connection). After the command returns, poll until Postgres and Mailpit report
healthy:

```bash
until docker compose -f ops/docker-compose.yml ps --format json \
  | grep -E '"Name":"calendry-postgres"' | grep -q '"Health":"healthy"'; do
  echo "waiting for postgres…"; sleep 3
done
echo "postgres healthy"
```

The services and their default ports are:

| Service      | Default port              | Role                                                              |
|--------------|---------------------------|-------------------------------------------------------------------|
| `postgres`   | 5432 (internal to compose)| Supabase-patched Postgres (`supabase/postgres:15.8.1.060`)        |
| `gotrue`     | 9999                      | Admin auth: magic link + Google OAuth (Supabase GoTrue)           |
| `postgrest`  | 3001                      | PostgREST REST gateway used by the web app                        |
| `realtime`   | 4000                      | Supabase Realtime (websocket subscriptions)                       |
| `studio`     | 3002                      | Supabase Studio admin UI — useful for inspecting tables           |
| `meta`       | 8080 (internal to compose)| pg-meta, used by Studio; not exposed to the host                  |
| `mailpit`    | 8025 (UI), 1025 (SMTP)    | Local email capture — dev/test only; not for production           |
| `web`        | 3000                      | Calendry Next.js app (booking page + admin UI)                    |
| `worker`     | —                         | Bun pgque consumer (background jobs + crons)                      |

Port conflicts are common if you are already running Postgres on 5432 or another
service on 3000. Override any port in `.env.local`:

```
WEB_PORT=3010
POSTGRES_PORT=5433
STUDIO_PORT=3012
```

**Two-phase startup:** GoTrue needs Postgres to be healthy before it starts. The
compose `depends_on: condition: service_healthy` wiring handles this — GoTrue
will restart automatically until Postgres is ready. The `web` and `worker`
containers similarly wait on both `postgres` and `mailpit`. On first boot allow
30–60 seconds for all services to stabilise.

**Supabase keys (post-boot step):** `SUPABASE_ANON_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` are HS256 JWTs derived from `SUPABASE_JWT_SECRET`.
The `supabase/gotrue` container does not emit them to stdout, so the grep-the-logs
approach does not work. Instead, derive them directly from your secret using Bun:

```bash
SUPABASE_JWT_SECRET=<your-secret> bun -e "
  const secret = process.env.SUPABASE_JWT_SECRET;
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (payload) => {
    const header = enc({ alg: 'HS256', typ: 'JWT' });
    const body = enc(payload);
    const data = header + '.' + body;
    const sig = require('crypto').createHmac('sha256', secret).update(data).digest('base64url');
    return data + '.' + sig;
  };
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 60 * 60 * 24 * 365 * 5;
  console.log('SUPABASE_ANON_KEY=' + sign({ role: 'anon', iss: 'supabase', iat, exp }));
  console.log('SUPABASE_SERVICE_ROLE_KEY=' + sign({ role: 'service_role', iss: 'supabase', iat, exp }));
"
```

Replace `<your-secret>` with the value of `SUPABASE_JWT_SECRET` from `.env.local`.
The script prints two lines; paste them into `.env.local`:

```
SUPABASE_ANON_KEY=<paste here>
SUPABASE_SERVICE_ROLE_KEY=<paste here>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<paste here — same value as SUPABASE_ANON_KEY>
```

Then restart only the web and worker containers (no need to stop Postgres):

```bash
docker compose -f ops/docker-compose.yml --env-file .env.local \
  up -d --force-recreate web worker
```

**Viewing logs:** to follow all service output in one stream:

```bash
docker compose -f ops/docker-compose.yml logs -f
```

To tail a specific service:

```bash
docker compose -f ops/docker-compose.yml logs -f web
docker compose -f ops/docker-compose.yml logs -f worker
docker compose -f ops/docker-compose.yml logs -f gotrue
```

---

## 4. Database init

Calendry uses **sqlever** (a Sqitch-compatible migration runner with built-in
static analysis) to manage the database schema. All migrations live under `db/`.

Install sqlever via Bun (the `--global` flag puts it in your PATH):

```bash
bun add --global sqlever
```

Confirm installation:

```bash
sqlever --version
```

Export the database URL for the migration commands. In local dev:

```bash
export DATABASE_URL="postgresql://postgres:${POSTGRES_PASSWORD:-postgres}@localhost:5432/postgres"
```

Replace `${POSTGRES_PASSWORD}` with the value you set in `.env.local` if you
changed it from the default.

Deploy all migrations in dependency order:

```bash
sqlever deploy --plan db/sqitch.plan
```

The migration order, as declared in `db/sqitch.plan`, is:

1. `extensions` — enables `pgcrypto`, `btree_gist`, and `pg_cron`
2. `pgque` — vendors the pgque job queue schema (`db/pgque.sql`)
3. `providers` — the `providers` table (one row per bookable practitioner)
4. `availability_rules` — weekly availability windows with the exclusion
   constraint that prevents overlapping rules
5. `manual_blackouts` — provider-created busy blocks
6. `bookings` — the booking state machine table
7. `sync_channels` — Google watch channel registry
8. `busy_blocks` — materialized busy-block cache (Google-derived + blackouts)
9. `idempotency_keys` — deduplication keys for external side effects
10. `email_outbox` — transactional email outbox

Verify every migration applied cleanly:

```bash
sqlever verify --plan db/sqitch.plan
```

If verification passes with no errors, the schema is ready.

**Confirming pgque is loaded:** pgque is required for the worker's background
job queues. After deploy, confirm the `pgque` schema exists:

```bash
psql "$DATABASE_URL" -c '\dn' | grep pgque
```

Expected output: a row containing `pgque`.

**pgque ticker:** by default the worker self-ticks (`pgque.ticker(queue_name)`)
on every poll cycle — no extra setup required. For production scale, offload the
tick to pg_cron instead:

```sql
SELECT cron.schedule('pgque-google-push-tick', '5 seconds',
  $$SELECT pgque.ticker('google_push')$$);
```

With pg_cron driving the ticker, the self-tick call inside the worker can then
be removed.

**Revert path:** to roll back all migrations (destructive — drops all Calendry
tables):

```bash
sqlever revert --plan db/sqitch.plan
```

Individual migrations can also be reverted by passing `--to <migration-name>`.
The revert scripts live in `db/revert/` and mirror each deploy script.

**Recovering from a partial deploy:** if a migration fails mid-way (for example,
because an extension was not found), fix the underlying problem and re-run
`sqlever deploy`. sqlever tracks applied migrations in the `sqitch.changes` table
and will resume from where it left off. If a migration is partially applied and
left in an inconsistent state, revert to the last clean step with
`sqlever revert --to <last-clean-migration>`, fix the issue, then redeploy.

---

## 5. Cloudflare setup

> **Sprint 3 note:** this section references Cloudflare dashboard panels. Real
> screenshots will be added in Sprint 3. The step-by-step instructions below are
> sufficient to complete the setup without screenshots.

Skip this section for a local development setup where `NEXT_PUBLIC_URL` is
`http://localhost:3000`. Return here when you are ready to expose Calendry on a
public domain.

### 5a. Add your domain to Cloudflare

If your domain is not yet on Cloudflare, go to [dash.cloudflare.com](https://dash.cloudflare.com),
click **Add a site**, enter your domain, and follow the nameserver update
instructions. Nameserver propagation takes up to 48 hours but is usually faster.

### 5b. Add a DNS A record

In the Cloudflare dashboard for your domain, go to **DNS → Records** and add:

| Type | Name | IPv4 address | Proxy status |
|------|------|-------------|--------------|
| A | `book` (or `@` for the root) | `<your server's public IP>` | Proxied (orange cloud) |

Enable the orange-cloud proxy so that Cloudflare terminates TLS on your behalf.

### 5c. SSL/TLS mode — Full (strict)

In the Cloudflare dashboard, go to **SSL/TLS → Overview** and select
**Full (strict)**. This mode requires a valid certificate on the origin server
(not just on Cloudflare's edge). Do not use "Flexible" — it sends plain HTTP
between Cloudflare and your server, which is insecure and can cause redirect
loops with the web app's `https://` self-link generation.

### 5d. Origin certificate

In **SSL/TLS → Origin Server**, click **Create Certificate**. Accept the
defaults (RSA 2048, valid for 15 years, covering your domain and
`*.<your-domain>`). Download the certificate (`.pem`) and the private key.

Place them somewhere accessible to your Docker setup — for example,
`ops/certs/origin.pem` and `ops/certs/origin.key`. These paths are
gitignored by default; never commit certificate files.

If you are running the Next.js web app directly on the host without a reverse
proxy, you can pass the certificate paths to the Next.js server via the
`HTTPS_CERT_FILE` and `HTTPS_KEY_FILE` environment variables (if your Next.js
start command supports them), or put Caddy in front of the web container as a
minimal TLS-terminating reverse proxy using the origin cert.

Update `.env.local` to reflect your public HTTPS URL:

```
NEXT_PUBLIC_URL=https://book.example.com
GOTRUE_SITE_URL=https://book.example.com
```

Restart `web`, `worker`, and `gotrue` after changing these.

### 5e. Optional: Cloudflare Tunnel (home servers without a public IP)

If your server is behind NAT or a home router, use Cloudflare Tunnel instead of
a public IP + port-forwarding:

```bash
# Install cloudflared
brew install cloudflare/cloudflare/cloudflared   # macOS
# or: https://pkg.cloudflare.com/index.html      # Linux

# Authenticate (opens browser)
cloudflared tunnel login

# Create a tunnel
cloudflared tunnel create calendry

# Route traffic to the web container
cloudflared tunnel route dns calendry book.example.com

# Run the tunnel (point at local web port)
cloudflared tunnel run --url http://localhost:3000 calendry
```

Run `cloudflared tunnel run` as a systemd service or Docker container so it
starts automatically. With Tunnel active, you do not need to open any firewall
ports — Cloudflare's edge connects outbound to your server.

---

## 6. OAuth setup

OAuth covers two distinct concerns. Read `docs/oauth-setup.md` for the full
walkthrough of both. A brief summary:

**Admin authentication (GoTrue)** enables the provider to log into the Calendry
admin area at `/admin`. Two methods are available:

- *Magic link* — the provider enters their email address; GoTrue sends a
  one-click sign-in link. In local dev this link appears in Mailpit at
  `http://localhost:8025`. In production it is delivered via Resend.
- *Google sign-in* — uses Supabase GoTrue's Google OAuth provider. Requires
  `GOTRUE_EXTERNAL_GOOGLE_ENABLED=true`, `GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID`,
  `GOTRUE_EXTERNAL_GOOGLE_SECRET`, and `GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI` set
  in the compose environment. See `docs/oauth-setup.md §GoTrue admin OAuth`.

**Google Calendar API** grants Calendry write access to the provider's Google
Calendar so that bookings appear as events. This is a separate OAuth flow from
admin login: the provider completes it in the admin UI by clicking "Connect
Google Calendar". The resulting refresh token is stored in
`providers.google_oauth_refresh_token` and never leaves the database. See
`docs/oauth-setup.md §Google Calendar API — refresh token setup`.

**Bring-your-own OAuth client:** self-hosted instances must use their own Google
Cloud project and OAuth credentials. Do not share a client ID/secret with other
deployments. Google's quota is per-project; a shared client would exhaust quota
across all users.

The authorized redirect URI to register in Google Cloud Console is:

```
https://<your-domain>/api/auth/callback/google
```

In local dev, also add `http://localhost:3000/api/auth/callback/google` as an
authorized redirect URI during initial testing.

---

## 7. Resend setup

In local development, all outgoing email (magic links, confirmations, reminders)
is captured by Mailpit and never actually sent. Resend is only needed for
production deploys.

### 7a. API key

1. Sign in at [resend.com](https://resend.com).
2. Go to **API Keys** and click **Create API Key**.
3. Give it a name (e.g. "calendry-prod") and set the **Permission** to
   "Sending access" for your verified domain.
4. Copy the key and add it to `.env.local`:
   ```
   RESEND_API_KEY=re_<your key>
   EMAIL_DRIVER=resend
   ```

### 7b. Sender domain

You must verify the domain from which Calendry sends email. Go to
**Domains → Add Domain** in the Resend dashboard and enter your domain (e.g.
`book.example.com` or a subdomain like `mail.example.com`).

Resend will provide a set of DNS records to add to your Cloudflare zone. Add
them in **Cloudflare DNS → Records**:

| Type  | Name                          | Value (from Resend)        |
|-------|-------------------------------|----------------------------|
| TXT   | `@` or your domain root       | SPF record provided by Resend |
| TXT   | `resend._domainkey.<domain>`  | DKIM key provided by Resend |
| TXT   | `_dmarc.<domain>`             | `v=DMARC1; p=quarantine; …` |

After adding the records, click **Verify** in the Resend dashboard. Propagation
typically takes a few minutes with Cloudflare's authoritative DNS.

Set the verified sender address in `.env.local`:

```
EMAIL_FROM=noreply@book.example.com
```

### 7c. Deliverability notes

- SPF, DKIM, and DMARC must all pass before your confirmation emails reach
  users' inboxes reliably. Use [mail-tester.com](https://www.mail-tester.com)
  or send a test message via Resend's dashboard to confirm all three are green.
- Magic-link emails (sent by GoTrue) also go through the same SMTP/Resend path.
  Make sure `GOTRUE_SMTP_HOST` and `GOTRUE_SMTP_PORT` in the compose environment
  are updated to match your production relay when you switch from Mailpit to
  Resend (or leave them pointing at Resend's SMTP endpoint:
  `smtp.resend.com:465`).
- Resend's free tier allows 3,000 emails/month and 100/day. For a lightly-used
  self-hosted instance this is more than enough. Check Resend's pricing page for
  volume thresholds.

---

## 8. Provider onboarding

"Provider" is Calendry's term for the practitioner who owns the calendar — the
person whose booking page visitors will see. The provider has exactly one row in
the `providers` database table per deploy.

### 8a. First-run admin login

Navigate to `https://<your-domain>/admin/login` (or `http://localhost:3000/admin/login`
in local dev).

Two sign-in options are presented:

- **Magic link** — enter the provider's email address and click "Send magic
  link". Check Mailpit (`http://localhost:8025`) in dev, or the inbox in
  production. Click the link; you will be redirected to `/admin`.
- **Sign in with Google** — in local dev this hits the mock route
  `/api/dev/oauth-google` which returns a fake session for
  `admin@calendry.local`. In production it initiates the real GoTrue Google
  OAuth flow (requires GoTrue Google credentials — see §6).

The `GOTRUE_DISABLE_SIGNUP=true` flag in the compose file means GoTrue will only
accept sign-ins for email addresses that already exist in its `auth.users` table.
For the very first login (before any provider row exists), you must seed the
admin user. In dev, the mock `/api/dev/oauth-google` route bypasses this
entirely. In production, insert the admin user directly into GoTrue:

```bash
psql "$DATABASE_URL" \
  -c "insert into auth.users (id, email, role, aud, confirmation_token, email_confirmed_at)
      values (gen_random_uuid(), '<admin-email>', 'authenticated', 'authenticated',
              '', now())
      on conflict (email) do nothing;"
```

Replace `<admin-email>` with the provider's email address.

### 8b. Create the provider row

In v0.1 there is no first-run wizard UI; insert the provider row directly via
SQL. Connect to Postgres using the `DATABASE_URL` from `.env.local`:

```bash
psql "$DATABASE_URL"
```

Insert the provider row. Replace the placeholder values with real ones:

```sql
insert into providers (id, slug, email, home_tz)
values (
  gen_random_uuid(),
  '<url-slug>',        -- e.g. 'maya' → booking page at /book/maya
  '<admin-email>',     -- must match the GoTrue auth.users email
  '<iana-timezone>'    -- e.g. 'America/Los_Angeles'
);
```

Confirm the row was created:

```sql
select id, slug, email, home_tz from providers;
```

Note the `id` (UUID) — you will need it for availability rule setup.

### 8c. Create an availability rule

Without at least one availability rule the booking page returns no slots. Insert
a rule for the provider. This example creates Monday–Friday, 9 AM–5 PM slots in
30-minute increments with a 10-minute buffer:

```sql
insert into availability_rules
  (provider_id, weekday, start_local, end_local,
   slot_minutes, buffer_minutes, valid_from, valid_to)
values
  ('<provider-id>', 1, '09:00', '17:00', 30, 10, '2026-01-01', '2099-12-31'),  -- Monday
  ('<provider-id>', 2, '09:00', '17:00', 30, 10, '2026-01-01', '2099-12-31'),  -- Tuesday
  ('<provider-id>', 3, '09:00', '17:00', 30, 10, '2026-01-01', '2099-12-31'),  -- Wednesday
  ('<provider-id>', 4, '09:00', '17:00', 30, 10, '2026-01-01', '2099-12-31'),  -- Thursday
  ('<provider-id>', 5, '09:00', '17:00', 30, 10, '2026-01-01', '2099-12-31');  -- Friday
```

Weekday encoding: `0=Sunday, 1=Monday, …, 6=Saturday`.

The `valid_from`/`valid_to` range defines when this rule is active. Use a wide
range for a standing schedule, or narrow it for seasonal availability. Overlapping
rules for the same weekday within the same date range are rejected with HTTP 409
at write time — the exclusion constraint in the schema enforces this.

### 8d. Connect Google Calendar

After the provider row exists, the "Connect Google Calendar" button in the admin
UI (`/admin`) initiates the Google OAuth flow. This requests the
`https://www.googleapis.com/auth/calendar` scope and, on success, stores the
refresh token in `providers.google_oauth_refresh_token`.

In Sprint 1, the Google push worker is scaffolded but not yet fully wired (the
worker process exits cleanly after startup). Full two-way sync lands in Sprint 2.
For now, bookings are created in the database in `pending_push` state; the Google
Calendar write will be flushed once the worker is functional.

---

## 9. Smoke test

At the end of this section you will have confirmed that:

1. The availability API returns slots for your provider.
2. The booking endpoint accepts a POST and creates a database row.
3. A confirmation email appears in Mailpit.

> **Track C note:** the public booking UI (`/book/<slug>` form with slot picker
> and booking form) is implemented in Track C, which has not yet merged to
> `main` at the time this guide was written. The steps below use `curl` to call
> the API directly. Once Track C merges, this section will be updated with the
> browser-based flow.

### 9a. Check available slots

Confirm the availability API returns slots for your provider. Substitute your
slug and a date window that falls within your availability rule's date range and
weekdays:

```bash
curl -s \
  "http://localhost:3000/api/availability?slug=<your-slug>&from=2026-05-05T00:00:00Z&to=2026-05-05T23:59:59Z&zone=America/Los_Angeles" \
  | jq .
```

Expected response for a provider in `America/Los_Angeles` (PDT, UTC−7) with a
Tuesday `10:00–16:00` local rule. PDT is UTC−7, so 10:00 AM local = 17:00 UTC.
`2026-05-05` is a Tuesday and falls within the `valid_from`/`valid_to` range set
in §8c:

```json
{
  "slots": [
    { "start_utc": "2026-05-05T17:00:00.000Z", "end_utc": "2026-05-05T17:30:00.000Z" },
    { "start_utc": "2026-05-05T17:40:00.000Z", "end_utc": "2026-05-05T18:10:00.000Z" },
    ...
  ]
}
```

If `slots` is empty, confirm that your availability rule's `valid_from`/`valid_to`
covers the date you queried and that the queried date's weekday matches a rule row.

### 9b. Book a slot

Pick a `start_utc` value from the slot list returned above and POST a booking.
Replace `<your-slug>` and `<slot-start-utc>` with real values:

```bash
curl -s -X POST http://localhost:3000/api/bookings \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "<your-slug>",
    "start_utc": "<slot-start-utc>",
    "booker_email": "test@example.com",
    "booker_name": "Test Booker",
    "booker_notes": "Smoke test booking"
  }' | jq .
```

Expected response (HTTP 201):

```json
{
  "booking_id": "<uuid>",
  "status": "pending_push",
  "cancel_token": "<signed-token>",
  "reschedule_token": "<signed-token>"
}
```

A `409` response means the slot is already taken or conflicts with a busy block.
A `429` response means you hit the rate limit — wait 60 seconds and retry.

### 9c. Confirm the booking in the database

```bash
psql "$DATABASE_URL" \
  -c "select id, state, booker_email, start_utc from bookings order by created_at desc limit 1;"
```

The `state` column should be `pending_push` (it moves to `confirmed` once the
Google push worker processes the job in Sprint 2).

### 9d. Check Mailpit for the confirmation email

Open Mailpit at [http://localhost:8025](http://localhost:8025). You should see a
confirmation email addressed to `test@example.com`. The email contains:

- Booking date/time in the booker's timezone.
- A signed cancel link (uses `BOOKING_TOKEN_SECRET`).
- A signed reschedule link.

If the email does not appear within a few seconds, check the worker logs:

```bash
docker compose -f ops/docker-compose.yml logs worker
```

And check the `email_outbox` table for any error rows:

```bash
psql "$DATABASE_URL" \
  -c "select id, kind, sent_at, last_error, attempt_count
      from email_outbox
      order by created_at desc limit 5;"
```

### 9e. Confirm idempotency

Send the identical POST request a second time (same `slug`, `start_utc`, and
`booker_email`). The response should be HTTP 200 (not 201) with the same
`booking_id` — the idempotency key match short-circuits the insert and returns
the original booking.

---

## 10. Troubleshooting

### Postgres won't start

**Symptom:** `docker compose logs postgres` shows `FATAL: data directory …
has wrong ownership` or the healthcheck never becomes healthy.

**Cause / fix:** the `pg_data` volume may have been created by a different user.
Run `docker compose down -v` to destroy the volume (this drops all data) and
then `docker compose up -d` again. Only do this on a fresh install with no data
you care about.

**Port conflict:** if port 5432 is already in use on the host, add
`POSTGRES_PORT=5433` to `.env.local` and update `DATABASE_URL` to match:
`postgresql://postgres:<pw>@localhost:5433/postgres`.

### GoTrue auth fails / "relation auth.users does not exist"

**Symptom:** GoTrue container exits with a migration error referencing the `auth`
schema.

**Cause:** GoTrue runs its own schema migrations against `supabase_auth_admin`.
If `SUPABASE_AUTH_ADMIN_PASSWORD` in `.env.local` does not match the value used
in `ops/postgres-init/00-supabase-roles.sql`, GoTrue cannot authenticate.

**Fix:** verify that `SUPABASE_AUTH_ADMIN_PASSWORD` in `.env.local` matches
what is actually set on the role in Postgres. Connect as superuser and inspect:

```bash
psql "$DATABASE_URL" -c "\du supabase_auth_admin"
```

If the role has no password or the wrong password, set it:

```bash
psql "$DATABASE_URL" \
  -c "alter role supabase_auth_admin with encrypted password '<correct-password>';"
```

Then restart GoTrue:

```bash
docker compose -f ops/docker-compose.yml restart gotrue
```

### Magic link doesn't arrive (local dev)

**Symptom:** you click "Send magic link" on `/admin/login` and nothing appears
in Mailpit.

**Check 1:** confirm Mailpit is running and healthy:

```bash
docker compose -f ops/docker-compose.yml ps mailpit
```

**Check 2:** confirm GoTrue's SMTP config points at Mailpit. In
`ops/docker-compose.yml`, GoTrue's `GOTRUE_SMTP_HOST` should be `mailpit` and
`GOTRUE_SMTP_PORT` should be `1025`. These are the defaults.

**Check 3:** check GoTrue logs for SMTP errors:

```bash
docker compose -f ops/docker-compose.yml logs gotrue | grep -i smtp
```

**Check 4:** confirm `GOTRUE_SITE_URL` matches `NEXT_PUBLIC_URL`. A mismatch
causes GoTrue to embed a link pointing at the wrong host, which may route to a
non-running server even if the email arrives.

### OAuth redirect mismatch ("redirect_uri_mismatch")

**Symptom:** clicking "Sign in with Google" produces a Google error page reading
"redirect_uri_mismatch" or "Error 400: redirect_uri_mismatch".

**Cause:** the redirect URI registered in Google Cloud Console does not match
the one the app is sending. The app sends:
`<NEXT_PUBLIC_URL>/api/auth/callback/google`.

**Fix:** go to **Google Cloud Console → APIs & Services → Credentials**, select
your OAuth client, and add the exact URI shown in the error message to the
**Authorized redirect URIs** list. Ensure `NEXT_PUBLIC_URL` is set to the same
base URL (`https://` in production, `http://localhost:3000` in dev).

### sqlever can't connect / "could not connect to server"

**Symptom:** `sqlever deploy` exits with a connection error.

**Check 1:** confirm `DATABASE_URL` is exported in your shell:
`echo $DATABASE_URL`.

**Check 2:** confirm Postgres is running and the port is reachable:

```bash
docker compose -f ops/docker-compose.yml ps postgres
psql "$DATABASE_URL" -c "select 1;"
```

**Check 3:** if you changed `POSTGRES_PORT` in `.env.local`, make sure the port
number in `DATABASE_URL` matches.

### pgque ticker not running / jobs stuck

**Symptom:** bookings remain in `pending_push` state; `email_outbox` rows stay
unsent.

**Check 1:** confirm pg_cron is loaded by inspecting the cron job list:

```bash
psql "$DATABASE_URL" -c "select * from cron.job;"
```

If the query fails with "schema cron does not exist", pg_cron was not loaded by
the Postgres image. Confirm you are using `supabase/postgres:15.8.1.060` (which
bundles pg_cron) and not a vanilla Postgres image.

**Check 2:** confirm the `pgque` migration deployed successfully:

```bash
psql "$DATABASE_URL" -c '\dn' | grep pgque
```

**Check 3:** check worker logs for startup errors:

```bash
docker compose -f ops/docker-compose.yml logs worker
```

In Sprint 1, the worker starts and exits immediately (no queues are configured
yet — full queue consumers land in Sprint 2). This is expected behaviour; the
worker log will show "calendry worker: starting" followed by
"calendry worker: no queues configured yet, exiting". Jobs will be processed once
the full worker implementation merges.

### Slot list is empty on the availability API

**Symptom:** `GET /api/availability` returns `{"slots":[]}`.

**Check 1:** confirm a `providers` row exists with the slug you are querying:

```bash
psql "$DATABASE_URL" -c "select slug, home_tz from providers;"
```

**Check 2:** confirm at least one `availability_rules` row exists for the
provider and that its `valid_from`/`valid_to` range covers the date you queried:

```bash
psql "$DATABASE_URL" \
  -c "select weekday, start_local, end_local, valid_from, valid_to
      from availability_rules
      where provider_id = (select id from providers where slug = '<your-slug>');"
```

**Check 3:** confirm the queried date's weekday matches a rule. The weekday
encoding is `0=Sunday, 1=Monday, …, 6=Saturday`. Monday 2026-05-04 is weekday 1.

**Full troubleshooting guide:** `docs/troubleshooting.md` (Sprint 3).
