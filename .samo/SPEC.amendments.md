# Calendry — SPEC Amendments

Append-only log of deviations from `.samo/SPEC.md` (v0.2). Each entry: date,
amendment, rationale, who decided. Stack/tooling choices listed here OVERRIDE
the corresponding SPEC text; the SPEC itself is left intact for historical
reference.

---

## 2026-05-02 — Stack: Bun + self-hosted Supabase + sqlever + pgque + Resend

**Spec section affected:** §Architecture / Components, §Implementation
Plan / Sprint 0 decisions, §Data flow (email).

**Amendment:**

- Runtime is **Bun** (TypeScript). The spec was silent on runtime; we pick
  Bun for `bun test`, scripts, and the worker process. Next.js still runs
  the web app (per spec).
- The Postgres referenced in the spec is provided by **self-hosted
  Supabase** (Postgres + GoTrue for admin auth + PostgREST + Studio). No
  Supabase Cloud dependency.
- Migrations run via **sqlever** (NikolayS/sqlever, Sqitch-compatible with
  static analysis). Replaces the unspecified "migration tooling" line in
  Sprint 0.
- Background jobs run on **pgque** (NikolayS/pgque) instead of a bespoke
  worker queue. The spec's "Worker — background job runner" remains the
  conceptual model; pgque is the implementation. Job classes from the spec
  (`google_push`, `sync_pull`, `email_send`, etc.) become pgque queues.
- **Email** ships on **Resend** as the default transactional provider.
  Generic SMTP fallback is documented for self-hosters. The spec called
  for "generic SMTP driver" as primary; we flip the default while keeping
  SMTP as a documented option.

**Rationale:** Hosting decisions made by the maintainer. Bun + Supabase +
pgque + sqlever + Resend is a coherent self-host story (one compose file,
one migration tool, one queue, one provider). Keeps things simple per the
"Keep it simple" rule in CLAUDE.md.

**Decided by:** maintainer (NikolayS) on 2026-05-02.

---

## 2026-05-02 — Postgres 18 pin + Cloudflare for DNS/SSL

**Spec section affected:** §Architecture, §Implementation Plan / Sprint 3
self-host story.

**Amendment:**

- **Postgres 18** pinned for v0.1. (Spec was silent on PG version.) sqlever
  static-analysis rules and any PG-version-sensitive SQL must target 18.
  pgque already supports PG 14+; pg_ash compatibility is not required for
  v0.1.
- **Cloudflare** is the documented DNS + SSL termination layer for the
  self-host story. Self-host docs cover: DNS A/AAAA records, "Full (strict)"
  SSL with origin certs, and optional Cloudflare Tunnel for home servers
  that don't have a public IP. Caddy/nginx is no longer required as a
  default reverse proxy in the self-host quickstart (Cloudflare proxy +
  Bun's built-in HTTP server is enough); Caddy remains an option for users
  not using Cloudflare.
- **Latest-stable rule:** all third-party deps (Bun, Next.js, Luxon, etc.)
  pinned to latest stable at Sprint 0 lock-in. The spec's deferred
  Temporal-migration item still holds.

**Rationale:** Maintainer's hosting setup. Cloudflare is "free SSL +
free DNS + DDoS-shielded" which fits the self-host story; PG 18 is the
current stable line at project start.

**Decided by:** maintainer (NikolayS) on 2026-05-02.

---

## 2026-05-02 — Auth model: admin-only login, anonymous booking

**Spec section affected:** §Tests Plan / Security (Admin UI auth), §Tenancy.

**Amendment:**

- **Admin area** (`/admin/*`): login required. Two methods: magic link
  (via Resend) and Google OAuth. Either is sufficient.
- **Public booking** (`/book/*`, `/api/bookings*`): **anonymous, no login**.
  The booker provides name + email at submit time; cancel/reschedule is
  authenticated via signed token in the email link (already required by
  the spec — see §Security / "Signed cancel/reschedule links").
- The spec's `providers.email` field becomes the admin login identity for
  magic link; `providers.google_oauth_refresh_token` is reused for
  admin Google login when the same Google account is used.

**Rationale:** Calendly-style bookers don't sign up. Spec already implied
this (signed-link auth for cancel/reschedule) but didn't pin the admin
auth method. We pin it now to unblock the full-stack track.

**Decided by:** maintainer (NikolayS) on 2026-05-02.

---

## 2026-05-02 — Postgres 18 in CI/production, supabase/postgres:15.x in dev compose

**Spec section affected:** earlier amendment "Postgres 18 pin".

**Amendment:** the previous amendment said Postgres 18 is pinned for v0.1. In practice, upstream `supabase/postgres` (the Supabase-patched image required for `auth`, `storage`, `realtime` extensions and roles) has not yet shipped a Postgres 18 tag at the time of Sprint 0. Resolution:

- Self-host **production** compose pins `supabase/postgres:15.8.1.060` (current upstream stable).
- **CI migration job** runs against `postgres:18` (the unbundled stable Postgres) so that all SQL we write is PG 18-clean. When `supabase/postgres:18.x` ships, the production compose flips to it with no SQL changes expected.
- Sprint 0 SRE has wired both images. Tracking issue to flip when upstream ships: open follow-up issue after Sprint 0 closes.

**Decided by:** maintainer (NikolayS) on 2026-05-02.

---

## 2026-05-02 — CI postgres image: supabase/postgres:15.x

**Spec section affected:** previous PG 18 amendment.

**Amendment:** Vanilla `postgres:18` does not bundle pg_cron (it requires `shared_preload_libraries` at server start). pgque uses pg_cron for its ticker, so the migration cannot deploy on vanilla PG 18. CI flips to `supabase/postgres:15.8.1.060` — same image as dev compose. The PG 18 forward-compat goal is deferred to whenever an upstream Postgres 18 image with pg_cron exists.

**Decided by:** maintainer-via-manager on 2026-05-02.
