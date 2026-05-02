# Calendry — Self-Host Quickstart

> **Status:** outline only — full prose and screenshots land in Sprint 3.
> Each section has a heading and bullet placeholders describing what it WILL contain.
> Sections marked _TODO_ are expanded by the Writer track in Sprint 3.

---

## 1. Prerequisites

_TODO (Sprint 3): Confirm exact minimum versions and link to official install docs for each._

- **Bun** (latest stable) — runtime for the worker and scripts; install via `curl -fsSL https://bun.sh/install | bash`.
- **Docker + Docker Compose v2** — required to run the self-hosted Supabase stack (`ops/docker-compose.yml`).
- **A domain you control** — needed for SSL termination (Cloudflare) and Google OAuth redirect URIs.
- **A Cloudflare account** — DNS, SSL termination with origin certificate, and optional Tunnel for servers without a public IP.
- **A Google Cloud project** — Calendar API enabled, OAuth 2.0 credentials created (see `docs/oauth-setup.md`).
- **A Resend account** — for production transactional email (magic-link auth, booking confirmations, reminders). Not required for local dev; Mailpit handles email capture in compose.

---

## 2. Clone + env

_TODO (Sprint 3): Walk every variable in `.env.example`, explain what generates it (e.g. `openssl rand -base64 32`), and flag which ones are required before first boot vs. after first boot._

- Clone the repo and copy the example env file: `cp .env.example .env.local`.
- Required before first boot: `POSTGRES_PASSWORD`, `SUPABASE_JWT_SECRET` / `GOTRUE_JWT_SECRET`, `CSRF_SECRET`, `BOOKING_TOKEN_SECRET`, `NEXT_PUBLIC_URL`, `GOTRUE_SITE_URL`.
- Generated on first boot (copy from compose stdout then restart): `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- Production-only additions: `RESEND_API_KEY`, `EMAIL_FROM` (must be a Resend-verified sender domain), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DASHBOARD_PASSWORD`.

---

## 3. Compose up

_TODO (Sprint 3): Add healthcheck polling snippet, explain the two-phase startup (boot → copy keys → restart web+worker), and document each service's role._

- Start all services: `docker compose -f ops/docker-compose.yml --env-file .env.local up -d`
- Services that come up:

  | Service      | Default port          | Role                                            |
  |--------------|-----------------------|-------------------------------------------------|
  | `postgres`   | 5432 (internal)       | Supabase-patched Postgres (`supabase/postgres:15.8.1.060`) |
  | `gotrue`     | 9999                  | Admin auth — magic link + Google OAuth          |
  | `postgrest`  | 3001                  | PostgREST REST gateway                          |
  | `realtime`   | 4000                  | Supabase Realtime                               |
  | `studio`     | 3002                  | Supabase Studio admin UI                        |
  | `meta`       | 8080 (internal)       | pg-meta (used by Studio)                        |
  | `mailpit`    | 8025 (UI), 1025 (SMTP) | Local email capture — dev/test only            |
  | `web`        | 3000                  | Calendry Next.js booking + admin UI             |
  | `worker`     | —                     | Bun pgque consumer (background jobs + crons)    |

- Healthchecks: `postgres` and `mailpit` have compose `healthcheck` blocks; `web` and `worker` wait on `postgres` + `mailpit` via `depends_on: condition: service_healthy`.

---

## 4. Database init

_TODO (Sprint 3): Expand with troubleshooting steps for common migration failures (e.g. extension not found, role conflict), and document the revert path in detail._

- Install sqlever: `bun add -g sqlever` (or follow https://github.com/NikolayS/sqlever).
- Deploy all migrations in order: `sqlever deploy --plan db/sqitch.plan`
  - Migration order: `extensions` → `pgque` → `providers` → `availability_rules` → `manual_blackouts` → `bookings` → `sync_channels` → `busy_blocks` → `idempotency_keys` → `email_outbox`.
- Verify every change was applied cleanly: `sqlever verify --plan db/sqitch.plan`
- Revert path (roll back all): `sqlever revert --plan db/sqitch.plan` — scripts in `db/revert/` mirror each deploy script.
- pgque schema: the `pgque` migration step (`db/deploy/pgque.sql`) loads the vendored `db/pgque.sql`; confirm the `pgque` schema exists after deploy: `psql $DATABASE_URL -c '\dn'`.

---

## 5. Cloudflare setup

_TODO (Sprint 3): Add screenshots for Cloudflare DNS and SSL panels; document origin certificate download and placement; expand Tunnel option with `cloudflared` install steps._

- **DNS A record** — add an A record pointing your (sub)domain to your server's public IP; enable the Cloudflare orange-cloud proxy.
- **SSL mode** — set SSL/TLS encryption mode to **Full (strict)** in the Cloudflare dashboard to prevent redirect loops and enforce end-to-end encryption.
- **Origin certificate** — generate a Cloudflare origin certificate (valid 15 years), install it on the server (or pass it to the compose stack); update `NEXT_PUBLIC_URL` and `GOTRUE_SITE_URL` to the `https://` domain.
- **Optional: Cloudflare Tunnel** — for home servers without a public IP, use `cloudflared tunnel` to expose the `web` container (port 3000) without opening inbound firewall ports.

---

## 6. OAuth setup

_TODO (Sprint 3): Cross-link specific sections of oauth-setup.md; note which step in this quickstart must be completed before OAuth is usable._

- Full instructions are in [`docs/oauth-setup.md`](./oauth-setup.md).
- **Admin auth (GoTrue)** — covers magic link via Resend (or Mailpit in dev) and Google sign-in via Supabase GoTrue; see `## GoTrue admin OAuth (magic link + Google sign-in)` in that doc.
- **Calendar API** — covers the one-time refresh-token flow that grants Calendry write access to the provider's Google Calendar; see `## Google Calendar API — refresh token setup` in that doc.

---

## 7. Resend setup

_TODO (Sprint 3): Add screenshots for Resend domain verification panel; expand DNS record table with example values; note that magic-link emails also use Resend in production._

- **API key** — create an API key at https://resend.com/api-keys; set `RESEND_API_KEY` in `.env.local` and `EMAIL_DRIVER=resend`.
- **Sender domain** — add and verify your sender domain in Resend; set `EMAIL_FROM=noreply@<your-verified-domain>`.
- **DNS records** — add the DNS records Resend provides to your Cloudflare zone:
  - SPF (`TXT` record on the root or subdomain)
  - DKIM (`TXT` record — Resend provides the key)
  - DMARC (`TXT` record on `_dmarc.<domain>`)

---

## 8. Provider onboarding

_TODO (Sprint 3): Add UI screenshots for the first-run flow; document what happens if the provider row already exists; note that this step requires OAuth and database init to be complete._

- **First-run admin login** — navigate to `https://<your-domain>/admin/login`; use magic link (email link sent via Resend/Mailpit) or "Sign in with Google" to authenticate.
- **Create provider row** — the first-run wizard creates the first `providers` table row (slug, email, home timezone) that identifies the booking-page owner.
- **Connect Google Calendar** — the "Connect Google Calendar" button in the admin UI initiates the Google OAuth flow; on success the refresh token is stored in `providers.google_oauth_refresh_token` and the watch channel subscription is created.

---

## 9. Smoke test

_TODO (Sprint 3): Expand with exact URLs, expected email content, and how to confirm the Google Calendar event was created. Add a checklist matching the Story 1 acceptance criteria from SPEC §Tests Plan._

- **Book a slot** — open `https://<your-domain>/book/<your-slug>`, pick an available slot, fill in a test name and email address, and submit.
- **Check email** — in dev, open Mailpit at `http://localhost:8025` to confirm the confirmation email arrived; in production, check the inbox of the test email address.
- **Verify Google Calendar** — confirm the event appears on the provider's Google Calendar within ~10 seconds (p95 SLO); check the Supabase Studio `bookings` table to confirm the row is in `confirmed` state with a non-null `google_event_id`.

---

## 10. Troubleshooting

_TODO (Sprint 3): Expand each bullet into a full diagnosis + fix section with log snippets and commands._

- **Compose services not starting** — check `docker compose logs <service>`; common causes: port conflicts, missing env vars, Postgres healthcheck failing.
- **Migrations fail** — verify `DATABASE_URL` is reachable from the host; confirm `pg_cron` and `pgcrypto` extensions are available (`supabase/postgres:15.8.1.060` bundles both).
- **Magic-link emails not arriving** — in dev, check Mailpit (`http://localhost:8025`); in production, verify `RESEND_API_KEY` and `EMAIL_FROM` domain are set and verified.
- **Google OAuth errors** — see `docs/oauth-setup.md` and the error taxonomy in `packages/google/ERRORS.md`; check `providers.oauth_status` in the database.
- **Slot list is empty** — confirm an `availability_rules` row exists for the provider; confirm the worker is running and the pgque schema is loaded.
- **Full troubleshooting guide** — `docs/troubleshooting.md` (Sprint 3).
