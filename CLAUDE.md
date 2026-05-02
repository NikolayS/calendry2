# CLAUDE.md — Calendry

## Project

Calendry — self-hostable, open-source Calendly alternative for a single
practitioner. Two-way Google Calendar sync, timezone-correct slot generation,
durable email outbox. See `.samo/SPEC.md` for the full v0.2 spec.

## Stack (decided up-front — do not bikeshed)

**These choices OVERRIDE the SPEC where they conflict.** See
`.samo/SPEC.amendments.md` for the audit trail.

- **Runtime:** TypeScript on **Bun** — latest stable. Bun runs the test
  runner, scripts, and the worker process.
- **Web framework:** **Next.js** — latest stable (per spec — SSR public
  booking pages).
- **Database + auth:** **self-hosted Supabase** (compose-based; no Supabase
  Cloud dependency). **Postgres 18** pinned. Supabase GoTrue handles admin
  auth.
- **Admin auth:** **magic link** + **Google OAuth** (via Supabase GoTrue;
  magic-link emails sent via Resend). Bookers (public visitors) DO NOT
  log in — public booking page is anonymous; cancel/reschedule is gated
  by signed links sent in confirmation email.
- **Migrations:** **sqlever** (https://github.com/NikolayS/sqlever) — Sqitch-
  compatible with built-in static analysis. `deploy/`, `revert/`, `verify/`
  scripts plus `sqitch.plan`.
- **Time:** **Luxon** — latest stable (per spec — DST gap/fold semantics
  locked into fixtures).
- **Queues:** **pgque** (https://github.com/NikolayS/pgque) — install via
  `\i pgque.sql`; pg_cron drives the ticker.
- **Email:** **Resend** (transactional) for booking confirmations, reminders,
  conflict notifications, and magic-link auth.
- **DNS + SSL:** **Cloudflare** — DNS, TLS termination/origin certs, and
  proxying for the public booking page and admin UI. Self-host docs include
  the Cloudflare setup (DNS records, SSL mode, optional Tunnel for home
  servers).
- **External:** Google Calendar API (OAuth + watch channels + sync tokens).

**General rule:** all third-party libraries pinned to **latest stable** at
Sprint 0 lock-in. No legacy support targets unless a SPEC fixture requires it.

## Keep it simple

- No abstractions before the second use. Three similar lines beats a premature
  helper.
- No backwards-compatibility shims for code we just wrote.
- No feature flags for v0.1.
- No comments that restate the code. Only WHY-comments for non-obvious
  invariants.
- Do not add a job-runner framework on top of pgque. Use pgque directly.
- Do not add an ORM unless a sprint explicitly calls for one. Raw SQL via the
  Supabase Postgres client is fine.

## Style rules

Follow https://gitlab.com/postgres-ai/rules/-/tree/main/rules — key points:

### TypeScript

- `strict: true` in `tsconfig.json`. No `any` without a `// why` comment.
- No default exports for shared modules; named exports only.
- File names `kebab-case.ts`. Identifiers `camelCase`; types `PascalCase`.
- `bun test` for unit; Playwright for browser e2e; `k6` for load.

### SQL

- Lowercase keywords (`select`, `create function`)
- `snake_case` identifiers, plural table names, `_id` suffix for FKs
- `timestamptz` always; never `timestamp`
- Primary keys: `int8 generated always as identity` OR `uuid` where the spec
  calls for it (bookings have UUIDs per SPEC §Key abstractions)
- `comment on table` / `comment on column` for every new schema object
- Every `security definer` function pins `set search_path = …, pg_catalog`

### Shell

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
```

2-space indent; quote all expansions; long `--flags` with `\` continuation.

### Git commits

- Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`,
  `ops:`, `test:`
- Subject < 50 chars, present tense
- Never amend; never force-push without explicit confirmation
- One logical change per commit

### Units

- Binary units (KiB, MiB, GiB) in prose, reports, docs
- Exception: Postgres config values use PG format (`shared_buffers = '2GB'`)
- ISO 8601 timestamps in static content; relative + ISO-tooltip in UI

## Testing — red/green TDD is non-negotiable

Per SPEC §Tests Plan, the following modules MUST be built test-first. The PR
must show the failing test commit BEFORE the implementation commit (or both
together with the test demonstrably failing without the impl):

- Slot generation (8 property invariants + DST fixtures)
- Booking state machine (every transition + every illegal transition throws)
- Reschedule, cancellation, sync token, idempotency, conflict detection,
  webhook authenticity

Bug fixes MUST include a regression test that would have caught the bug.

## PR workflow (mandatory — no exceptions)

Every PR follows this lifecycle. The agent who opens the PR DOES NOT merge
their own PR.

1. **Branch off `main`.** Branch name: `<track>/<issue>-<slug>`,
   e.g. `sched/12-slot-gen-property-tests`.
2. **CI green.** GitHub Actions: `bun test`, `bun typecheck`, `bun lint`,
   axe a11y, sqlever migration forward+backward, k6 smoke (where wired).
3. **REV review.** Use `/review-mr <PR-URL>` (REV: https://gitlab.com/postgres-ai/rev/).
   Works on GitHub PRs. Post the report as a PR comment. **Ignore SOC2
   findings** — not applicable here. BLOCKING findings must be resolved
   before merge.
4. **Reviewer pass.** A different engineer (assigned in the issue) reviews
   the diff, runs the tests locally where it makes sense, and posts evidence
   of testing as a PR comment (commands run, results, screenshots for UI).
5. **Merge.** Squash merge once 1–4 are all green. Manager (or assigned
   approver) clicks merge.

Intermediate progress MUST be reported as comments on the issue (not just
the PR) so the manager can supervise without scrolling diffs.

## Branching

- `main` — protected; only merge via PR
- Working branches per issue (see naming above)
- Spec lives at `.samo/SPEC.md`. Spec amendments live at
  `.samo/SPEC.amendments.md` — append-only, dated, with rationale.

## Repo layout (target)

```
calendry2/
  .samo/
    SPEC.md
    SPEC.amendments.md          (created when first amendment lands)
  CLAUDE.md
  README.md
  package.json                  (Bun + Next.js)
  bunfig.toml
  tsconfig.json
  apps/
    web/                        (Next.js: public booking + admin UI)
    worker/                     (Bun process: pgque consumers, crons)
  packages/
    core/                       (slot-gen, state machine, ICS, time math)
    db/                         (Supabase client, query helpers)
    google/                     (Google Calendar client + OAuth)
    email/                      (SMTP driver + outbox helpers)
  db/
    migrations/                 (sqlever: deploy/, revert/, verify/, sqitch.plan)
    pgque.sql                   (vendored from NikolayS/pgque)
  ops/
    docker-compose.yml          (self-hosted Supabase + worker + web)
    Dockerfile
  tests/
    unit/                       (bun test — pure functions)
    integration/                (real Postgres + faked Google)
    e2e/                        (Playwright, 4 locales)
    load/                       (k6)
  docs/
    self-host.md
    oauth-setup.md
    troubleshooting.md
```

## Security rules

- NEVER put secrets, OAuth client secrets, or tokens in code, issues, or
  PR comments. Use `.env.local` (gitignored) and `.env.example` (committed,
  no secrets). Document all required env vars in `docs/self-host.md`.
- All admin routes require auth. CSRF on all mutating routes.
- Booking POST: rate-limit per IP (10/min) and per booker email (3/min) by
  default; configurable.
- HTML-escape `booker_name`, `booker_notes`, blackout `reason` everywhere
  rendered (admin UI, emails, ICS SUMMARY/DESCRIPTION).
- Verify Google webhook headers (`X-Goog-Channel-ID`, `X-Goog-Channel-Token`,
  `X-Goog-Resource-ID`) against `sync_channels` before any work.

## SLOs (from SPEC §SLO table — assert in CI where marked)

- `POST /api/bookings`: p95 < 800ms, p99 < 1.5s
- Booking → Google event visible: p95 < 10s, p99 < 60s
- External Google change → BusyBlock cache: p95 < 60s, p99 < 5min
- **Conflict notification email enqueued: p99 < 5min — HARD SLO, asserted
  in CI** (integration test injects webhook, checks `email_outbox` row)

## Copyright

Copyright 2026 Nikolay Samokhvalov. License TBD by the maintainer in Sprint 0.
