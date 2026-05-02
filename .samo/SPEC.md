# Calendry — SPEC v0.2

## Goal & why it's needed

Calendly is the default tool for letting external clients book time on a service provider's calendar, but it's closed-source SaaS with per-seat pricing, opaque data handling, and no self-hosting story. Independent practitioners (therapists, coaches, tutors, consultants, freelance designers) increasingly want to own their booking surface — both for cost reasons and because their calendar contains sensitive client data they don't want to hand to a third party.

Calendry exists to give a single service provider a self-hostable, open-source booking page that nails the core Calendly job — "let strangers book a slot on my calendar without a phone call, without double-booking me, in their timezone, with a confirmation email and a reminder" — and stays in honest two-way sync with the provider's Google Calendar so they never have to reconcile two sources of truth.

**This is NOT**: a team scheduling tool, a CRM, a payment processor, a meeting-room booking system, a Google Calendar replacement, or a generic calendaring app. The provider keeps using Google Calendar as their primary calendar; Calendry is the public booking edge that writes to it and listens to it.

## User stories

1. **Maya — solo therapist, recurring weekly availability.** Maya is a licensed therapist who already runs her practice out of Google Calendar (client sessions, personal life, vacations all on one calendar). She installs Calendry, connects Google in OAuth, and defines her bookable hours once: "Tue/Thu 10am–4pm America/Los_Angeles, 50-min sessions, 10-min buffer after each, 24h minimum notice." She shares `book.maya-therapy.com/intake` with new clients. When a client books, the event appears on her Google Calendar within seconds, the client receives a confirmation email with an .ics attachment, both sides get a reminder 24h before, and any busy time she puts on Google (a vacation, a dentist appointment, an existing client) is excluded from offered slots — typically within ~1 minute via the watch-channel webhook, worst case within 15 minutes via the safety cron (see SLO table). **Outcome:** zero double-bookings beyond the documented sync window, zero "what time works for you?" email threads, one source of truth.

2. **Daniel — international tutor, timezone correctness across DST.** Daniel teaches Spanish from Madrid (Europe/Madrid) to students in Tokyo, São Paulo, Brooklyn, and back home in Madrid. A Brooklyn student opens his booking page on March 10, 2026 — squarely inside the 3-week window where US DST has started (Mar 8) but EU DST has not (until Mar 29). The page detects the student's browser timezone, shows slots in their local time, the booking is written to Daniel's Google Calendar in Madrid time, and the confirmation email shows the time in *both* timezones with explicit UTC offsets and zone abbreviations (e.g. "Tue Mar 10, 2:00 PM EDT / 7:00 PM CET (UTC−04:00 / UTC+01:00)"). **Outcome:** no student ever shows up an hour early or an hour late around DST transitions, ever.

3. **Priya — freelance consultant, last-minute external change.** Priya offers 30-min discovery calls. A prospect books Friday 2pm. Thursday night Priya's daughter gets sick — she blocks Friday on Google Calendar directly from her phone, never opening Calendry. Within 5 minutes (the asserted SLO) Calendry's sync loop detects the new busy block via the Google watch channel webhook, sees the now-conflicting confirmed booking, marks it `conflicted`, and emails Priya a notification with one-click "send reschedule link" and "cancel with apology" actions. The prospect is never silently stranded with a stale calendar invite. **Outcome:** Google Calendar remains the source of truth for busy time; Calendry never silently keeps a booking that no longer holds.

## Architecture

<!-- architecture:begin -->

```text
(architecture not yet specified)
```

<!-- architecture:end -->

### Components

- **Web app** (Next.js, decided in Sprint 0 — see Implementation Plan for rationale) — public booking pages, provider admin UI, OAuth callback handlers. Server-rendered for the public pages so timezone math happens server-side and pages are crawlable.
- **API service** (same process as web app for v0.1) — REST endpoints for availability query, booking create / cancel / reschedule, manual blackout CRUD, Google webhook receiver.
- **Worker** — background job runner. Job classes: (a) outbound email driven by the `email_outbox` table (transactional outbox; see Boundaries), (b) Google push (create/update/delete events), (c) Google pull (handle watch channel notifications, walk sync tokens, renew expiring channels), (d) safety resync (15-min cron backstop), (e) channel renewal (hourly cron).
- **Postgres** — single source of truth for bookings, availability rules, manual blackouts, sync state, watch-channel registry, idempotency keys, email outbox.
- **SMTP relay (pluggable)** — Postmark, SES, or local sendmail; v0.1 ships a generic SMTP driver and documents both hosted-relay and self-relay paths. Startup-time configuration check fails loudly if the relay is unreachable.
- **Google Calendar (external)** — provider's calendar; treated as authoritative for busy time. Calendry is authoritative for booking metadata (booker name, notes, reschedule history).

### Boundaries

- The public booking page never reads Google Calendar live. It reads a *materialized availability cache* maintained by the sync worker. This decouples booking-page latency from Google API quotas and outages. **Staleness window:** typically <60s (webhook path), worst case 15min (safety cron). This is documented in user stories and the SLO table; it is a deliberate trade, not a bug.
- All writes flow Calendry → Postgres → Worker → Google. Google → Calendry flows only through the watch-channel webhook + sync-token pull loop, never via direct read on the request path.
- **Email is durable, not fire-and-forget.** The `email_outbox` table is a transactional-outbox: every email is written in the same Postgres transaction that triggers it (booking insert, conflict detection, etc.) and is later picked up by the worker. The worker is fire-and-forget *with respect to crashes* in the sense that it doesn't acknowledge the SMTP send until the row is marked `sent_at`; on restart it resumes from the outbox. Idempotency keys prevent double-sends across worker retries.
- **Tenancy model.** v0.1 is *single-organization per deploy* — there is no SaaS-style cross-org isolation, no signup flow, no per-tenant billing. The schema is keyed by `provider_id` because a single deploy may host more than one practitioner (e.g. a two-therapist practice sharing one self-hosted instance). Multi-org / public-SaaS hosting is explicitly out of scope.

### Key abstractions

- **`AvailabilityRule`** — recurring weekly pattern stored in the provider's home IANA timezone, with date-range overrides via `valid_from` / `valid_to` (precedence rules in Implementation Details).
- **`ManualBlackout`** — provider-created busy block ("out for surgery Mar 12–19"), stored alongside Google-derived busy events in the BusyBlock union.
- **`BusyBlock`** — derived; union of (Google busy events from sync, existing Calendry bookings, manual blackouts). Materialized per-provider for the next 60 days; refreshed on each webhook tick and on a 15-minute safety cron.
- **`Booking`** — owns its own UUID, a nullable `google_event_id`, a state machine (`pending_push → confirmed → cancelled | rescheduled | conflicted`), an idempotency key derived from booker email + slot start, and a nullable `rescheduled_from` self-reference for reschedule chains.
- **`SyncChannel`** — registered Google watch channel with id, resource id, expiry, and current sync token. Renewed by cron ~24h before expiry.
- **`Slot`** — pure value: (start_utc, duration, provider_zone). Never persisted; computed on demand from `AvailabilityRule` minus `BusyBlock` set.

## Implementation details

### Data flow: booking creation

1. Booker visits `/book/{provider-slug}`. Server renders the next 14 days of slots from the materialized availability cache, in the booker's detected browser timezone. No Google call on this path.
2. Booker selects a slot, fills name/email/notes, POSTs `/api/bookings` (CSRF-protected, rate-limited per IP and per booker email — see Tests Plan / security).
3. Server re-validates the slot is still free against the *current* `BusyBlock` set (closes the race window between page render and submit), inserts a `Booking` row in `pending_push` state with an idempotency key, enqueues a `google_push` job, and writes confirmation + reminder rows into `email_outbox` *in the same transaction*.
4. Worker calls `events.insert` passing the idempotency key as the Google request id. On 200, updates `Booking.state = confirmed` and stores `google_event_id`. On 409 / duplicate, fetches the existing event and reconciles. On 5xx, retries with exponential backoff up to 5 attempts. On persistent OAuth failure (401 with revoked token), marks the provider's connection `degraded` and surfaces it in the admin UI; the worker pauses google_push for that provider and emails them.
5. Email worker picks up `email_outbox` rows whose `send_after <= now()` and `sent_at IS NULL`, sends via SMTP, marks `sent_at`. Retries on transient SMTP failure with exponential backoff; hard bounces are surfaced to the provider.

### Data flow: cancellation

1. Booker (via signed link in confirmation email) or provider (via admin UI) initiates cancel. POST `/api/bookings/{id}/cancel`.
2. Booking transitions `confirmed → cancelled` (or `conflicted → cancelled`); transition is logged with actor.
3. A `google_delete` job is enqueued with idempotency key `booking_id + ":delete"`. Worker calls `events.delete`. 404 / 410 from Google is treated as success (already gone). 5xx retries with backoff.
4. A cancellation email is written to `email_outbox` (key `booking_id + ":cancellation"`) for both booker and provider.
5. Cancelling a `conflicted` booking is permitted and produces a single "cancellation" email rather than the conflict-notification action — the conflict is resolved by the cancel.

### Data flow: reschedule

Reschedule is modeled as **cancel-then-create with linkage**, not in-place mutation, so audit history and idempotency are clean.

1. Booker or provider opens reschedule link / UI, picks a new slot, POSTs `/api/bookings/{id}/reschedule` with `new_start_utc`.
2. Server re-validates the new slot against current `BusyBlock` set.
3. The original `Booking` row transitions `confirmed → rescheduled` (terminal). A new `Booking` row is inserted in `pending_push` state with `rescheduled_from = original.id` and idempotency key `original.id + ":r" + sequence` where `sequence` increments per reschedule (preventing double-reschedule from a stale form).
4. The Google event corresponding to the original is **patched** (`events.patch` with the new start/end), not deleted-then-recreated, so the booker's existing calendar invite updates in place. `google_event_id` is copied onto the new row; the original row's `google_event_id` is nulled out (so future cancel of the original does not delete the live event).
5. A reschedule-confirmation email is written to `email_outbox` (key `new_booking_id + ":reschedule"`) for both parties. Reminder for the new time is also enqueued; any pending reminder for the old time is cancelled by `UPDATE ... SET sent_at = now(), … WHERE booking_id = original AND kind = 'reminder'`.

### Two-way sync loop

- On provider OAuth connect: subscribe to a watch channel for their primary calendar (`events.watch`). Store channel id, resource id, expiry, and the initial sync token from a baseline `events.list`.
- On webhook POST from Google: **verify the `X-Goog-Channel-ID`, `X-Goog-Channel-Token`, and `X-Goog-Resource-ID` headers against `sync_channels`**; reject unknown / stale channels. Enqueue a `sync_pull` job for that provider. The job calls `events.list` with the stored sync token, walks the result page(s), applies each change to the `BusyBlock` materialization. On `410 Gone` (expired sync token), do a full resync of the next 60-day window and store a fresh sync token.
- Channel renewal: hourly cron renews any channel with <24h to expiry. New channel id replaces old; old is `channels.stop`'d.
- Conflict detection: if a pulled Google event overlaps a `confirmed` Calendry booking, mark the booking `conflicted` and write a notification row to `email_outbox`. End-to-end latency from external Google change to provider notification email enqueued is asserted ≤5min (see SLO table and Tests Plan).

### Manual blackouts

Provider admin UI exposes `manual_blackouts` CRUD (`POST/PATCH/DELETE /api/blackouts`). Each blackout has `provider_id`, `start_utc`, `end_utc`, `reason` (free text, provider-only, never shown to bookers). Inserts trigger a refresh of the affected provider's `busy_blocks` materialization. Blackouts overlapping existing confirmed bookings produce a warning in the UI and a manual `conflicted` mark on those bookings.

### Availability rule semantics

- **Buffer.** `buffer_minutes` is applied **after** the session only (not before). Maya's "50-min sessions, 10-min buffer" yields slots starting on a 60-minute grid. This is documented in the admin UI and locked into the slot-gen test fixtures. (Pre-buffer was considered and rejected for v0.1 to keep the rule model simple; can be revisited if requested.)
- **Rule precedence.** Multiple `availability_rules` for the same provider are allowed, but **overlapping windows for the same weekday are rejected at write time** (HTTP 409) rather than resolved by precedence. This avoids silent ambiguity. To express "normal Tuesdays 10–4 except July when 12–4", the provider must end the first rule with `valid_to = Jun 30` and add a second with `valid_from = Jul 1`. The admin UI surfaces this as a single "edit window" gesture.
- **Late-booking reminder.** If a booking is created with `start_time − now < 24h`, the 24h reminder is **skipped entirely** (not sent immediately, not rescheduled to T−1h). The confirmation email itself functions as the reminder for short-notice bookings. The `email_outbox` row is simply never written for the reminder when the threshold is not met. Documented in admin UI.

### Timezone correctness (the part that silently destroys products)

- All times stored as UTC instant + IANA timezone identifier (e.g. `America/Los_Angeles`). Never store local time without a zone. Never trust a fixed UTC offset.
- Availability rules stored in the provider's home zone, so "Tuesdays 10am" stays correct across the provider's own DST transitions without provider intervention.
- **Time library: Luxon** for v0.1. Decided up-front (not deferred to Sprint 0) because the test fixtures are written against a specific library's DST gap/fold semantics and switching libraries mid-flight invalidates them. Luxon is mature, has zero polyfill cost, and its DST handling is well-documented. Migration to `Temporal` is tracked as a v0.3+ item once polyfill weight and Node-LTS support meet our bar.
- Slot generation: expand the rule into UTC instants for the requested window using the provider's zone via Luxon. Re-render to the booker's detected zone client-side as a final cosmetic step.
- Confirmation, reminder, cancel, and reschedule emails: render the slot in *both* booker zone and provider zone, with explicit zone abbreviations and UTC offsets. Never render only "PT" or only "CET".
- DST gap/fold safety: if a candidate slot starts inside a DST spring-forward gap, omit it. If it starts inside a fall-back fold, offer it exactly once and disambiguate by storing the UTC instant.
- Cross-DST window: provider in EU, booker in US, between US-DST-start and EU-DST-start — covered by explicit fixtures in both unit and Playwright e2e suites.

### Booking state machine

```
  create  ─►  pending_push
                  │  google insert ok
                  ▼
              confirmed ──cancel──►  cancelled
                  │     ──reschedule──►  rescheduled (terminal; new row created)
                  │  google event mutated externally
                  ▼
              conflicted ──cancel──►  cancelled
                          ──reschedule──►  rescheduled
```

Illegal transitions throw — they never silently no-op. State transitions are logged with actor (booker, provider, system).

### Idempotency

Every external side effect (Google write, Google delete, email send, reminder schedule) carries a deterministic idempotency key derived from the booking and the side-effect type. Workers retry up to 5× with exponential backoff. The same key is checked at the storage layer before issuing the call. Reschedule sequence numbers (see Reschedule flow) prevent double-reschedule races from stale UI.

### Service-level objectives (SLOs)

| Path | Target | Backstop |
|---|---|---|
| `POST /api/bookings` end-to-end (booker click → confirmation page) | p95 < 800ms, p99 < 1.5s | n/a |
| Booking → Google event visible | p95 < 10s, p99 < 60s | google_push retries |
| Booking → confirmation email sent | p95 < 30s, p99 < 2min | email_outbox retry loop |
| External Google change → BusyBlock cache updated | p95 < 60s, p99 < 5min | 15-min safety cron |
| External Google change → provider notification email enqueued (conflict) | **p99 < 5min (hard SLO, asserted in CI)** | 15-min safety cron |
| Watch channel renewal headroom | always >24h before expiry | hourly renewal cron |
| Public booking page render | p95 < 200ms, p99 < 500ms at 50 rps on 2-vCPU | n/a |

### Data model (Postgres, abridged)

- `providers (id, slug, email, home_tz, google_oauth_refresh_token, oauth_status, …)`
- `availability_rules (id, provider_id, weekday, start_local, end_local, slot_minutes, buffer_minutes, valid_from, valid_to)` — overlap on `(provider_id, weekday)` within `[valid_from, valid_to]` enforced by exclusion constraint
- `manual_blackouts (id, provider_id, start_utc, end_utc, reason, created_at)`
- `bookings (id, provider_id, booker_email, booker_name, start_utc, end_utc, state, google_event_id, idempotency_key, rescheduled_from, reschedule_sequence, created_at, updated_at)`
- `sync_channels (id, provider_id, channel_id, channel_token, resource_id, sync_token, expires_at)` — `channel_token` is a per-channel random string verified on webhook receipt
- `busy_blocks (provider_id, start_utc, end_utc, source, source_id)` — materialized
- `idempotency_keys (key, kind, result_json, created_at)`
- `email_outbox (id, booking_id, kind, send_after, sent_at, last_error, attempt_count, idempotency_key)`

## Tests plan

### Built test-first (red/green TDD — non-negotiable)

These modules have correctness bugs that are silent and devastating in production. Failing test goes in first; implementation chases it.

- **Slot generation** — given an `AvailabilityRule` + a `BusyBlock` set + a target window + a target rendering zone, produce the exact slot list. Required fixtures: US DST spring-forward (gap slot omitted), US DST fall-back (fold hour offered exactly once), provider in `Europe/Madrid` with booker in `America/New_York` between Mar 8 and Mar 29, 2026, leap day Feb 29 2024, year boundary Dec 31 → Jan 1, ISO week boundary, `Pacific/Apia` skipped-day weirdness as a stretch case, buffer-applied-after grid alignment, overlapping availability rules rejected at write time.
- **Booking state machine** — every transition exhaustively, every illegal transition asserted to throw, including cancel-from-conflicted and reschedule-from-conflicted.
- **Reschedule flow** — original row transitions to `rescheduled`, new row created with correct `rescheduled_from`, `google_event_id` ownership transferred, old reminder cancelled, sequence number prevents double-reschedule from stale form.
- **Cancellation flow** — `events.delete` called once, 404/410 treated as success, cancellation email enqueued, cancelling a conflicted booking suppresses conflict-notification.
- **Sync token handling** — full resync on `410 Gone`, incremental apply on a normal page, idempotent re-application of a duplicated change set, channel renewal at the threshold.
- **Idempotency** — the same booking pushed twice must not create two Google events; the same email enqueued twice must not send two emails; the same reschedule POSTed twice with same sequence must produce one outcome.
- **Conflict detection** — every overlap shape: booking inside busy, busy inside booking, partial overlap on left, partial overlap on right, exact match, adjacent-touching (which is *not* a conflict).
- **Webhook authenticity** — webhooks with unknown channel id, wrong channel token, or stale resource id are rejected with 401/404 and never enqueue a pull job.

### Property-based invariants (Sprint 0 spike)

The "200+ property tests" target on slot generation is grounded in this written invariant set. Any one violation fails CI:

1. For any rule R, busy set B, window W, zone Z: every emitted slot is fully inside W.
2. Every emitted slot is disjoint from every block in B (no overlap, touching is allowed).
3. Slot starts align to the (slot_minutes + buffer_minutes) grid relative to rule.start_local.
4. Slot count is monotonically non-increasing in |B| (adding busy never increases offered slots).
5. Slot list is identical regardless of the booker's rendering zone Z (rendering is cosmetic).
6. No emitted slot starts inside a DST gap in the provider's zone.
7. Across a fall-back fold, exactly one slot is emitted per wall-clock instant that maps to two UTC instants.
8. For any two overlapping availability rules with the same weekday, write is rejected (no silent merge).

### CI test suite

- **Unit** — pure functions: slot math, timezone conversions, state machine, ICS generation. <5s total.
- **Integration** — real Postgres in Docker, faked Google API (record/replay against captured fixtures). Covers full booking, cancel, reschedule flows end-to-end.
- **Contract** — schema tests pinned against actual Google Calendar API JSON shapes; refreshed quarterly with a documented procedure.
- **Latency assertions** — integration test injects a Google watch-channel webhook for an externally-created event that conflicts with a confirmed booking, asserts the conflict-notification row appears in `email_outbox` within 5 minutes wall-clock (5s in CI with accelerated cron). Backs the hard SLO.
- **Security**:
  - Admin UI auth: unauthenticated access to any `/admin/*` route returns 401; CSRF token required on all mutating admin routes.
  - Booking POST: CSRF token required; rate-limited (10 / IP / minute and 3 / booker_email / minute by default, configurable).
  - XSS: `booker_name`, `booker_notes`, blackout `reason` are HTML-escaped in admin UI, in confirmation/cancellation/reschedule emails, and in ICS `SUMMARY`/`DESCRIPTION` fields. Fixtures include `<script>` and unicode bidi attacks.
  - Webhook authenticity: see TDD section.
  - Signed cancel/reschedule links: tampered token rejected; expired token rejected; replayed-after-state-change token rejected.
- **OAuth failure modes** — fixtures for: revoked refresh token (Google returns `invalid_grant`), scope downgrade, repeated 401 on `events.insert`, OAuth consent withdrawal mid-sync. Each must transition the provider's `oauth_status`, pause google_push, surface to admin UI, and email the provider — never silently strand prospects.
- **Email failure modes** — SMTP transient (5xx) failure triggers exponential backoff; hard bounce (550) marks the address and surfaces to provider; misconfigured relay detected at process startup with a loud failure (not a silent log line); `send_after` lapses on a row stuck in queue triggers an alert.
- **Browser e2e (Playwright)** — public booking page in **4 browser locales matching Daniel's story** (Tokyo / São Paulo / Brooklyn / Madrid), DST transition fixtures including the Mar 8–29 2026 Madrid↔NYC window as an explicit scenario, keyboard-only navigation, screen-reader landmark assertions.
- **Accessibility (axe-core in CI)** — every page route runs through axe; zero serious/critical violations is a CI gate. Booking form has explicit tests for label association, error announcements (aria-live), and focus management on submit/error.
- **ICS compatibility** — beyond unit tests on the generator, a fixture suite parses generated `.ics` files through:
  - Apple Calendar's open-source `ical.js` parser (stand-in for Apple Calendar strictness).
  - `icalendar` Python lib (stand-in for Outlook strictness around `METHOD:REQUEST` and TZID).
  - Round-trip: parse, mutate, serialize — must be byte-stable for unchanged fields (catches line-folding bugs).
- **Load (k6)** — booking-page render and `POST /api/bookings`; target SLOs from the SLO table.
- **Migration** — every Postgres migration runs forward + backward in CI against a snapshot DB.

### Manual acceptance — enumerated checklist

The three user stories drive a written checklist; tag-day pass requires every box ticked against a real Google account on staging.

**Story 1 (Maya):**
- [ ] OAuth connect succeeds first try following only the docs.
- [ ] Availability rule "Tue/Thu 10–4 LA, 50-min, 10-min buffer after, 24h notice" creates 6 slots/day on the public page.
- [ ] Manual block on Google appears as removed from public slot list within 60s (typical) and within 15min (worst case, with webhooks disabled to test backstop).
- [ ] Booking creates a Google event within 10s and a confirmation email within 30s.
- [ ] 24h reminder fires within 60s of `start - 24h`.
- [ ] Two near-simultaneous bookings of the same slot: exactly one succeeds, other gets a clean 409.

**Story 2 (Daniel):**
- [ ] Slot grid identical when page is rendered in `Asia/Tokyo`, `America/Sao_Paulo`, `America/New_York`, `Europe/Madrid` (only display labels change).
- [ ] Booking made on Mar 10 2026 from `America/New_York` against Madrid provider lands at the correct UTC instant, verified by inspecting the Google event.
- [ ] Confirmation email shows both timezones with explicit offsets and abbreviations.
- [ ] No slot is offered for Madrid wall-clock 2:30am on Mar 29 2026 (DST gap).

**Story 3 (Priya):**
- [ ] Provider creates external block on Google for an already-booked slot.
- [ ] Within 5 minutes (timed with stopwatch) the booking is marked `conflicted` in the admin UI.
- [ ] Within 5 minutes the provider receives a notification email with working "send reschedule link" and "cancel with apology" actions.
- [ ] Reschedule link patches the existing Google event (event id unchanged, time updated).
- [ ] Cancel-with-apology removes the Google event and emails the booker.

## Team

Veterans only — this product's correctness bar is much higher than its surface area suggests.

- **Veteran scheduling/calendar systems engineer (1)** — owns slot math, timezone correctness, the sync loop. The single most important hire; the product fails or succeeds on this person.
- **Veteran backend engineer, Postgres + jobs (1)** — owns schema, migrations, worker reliability, idempotency primitives, transactional outbox.
- **Veteran integrations engineer, Google APIs (1)** — owns OAuth (including failure modes), watch channels, sync tokens, quota and error handling, the long tail of Google Calendar API quirks.
- **Veteran full-stack web engineer (1)** — owns Next.js app, public booking page, admin UI, accessibility, security hardening (CSRF, rate-limit, XSS).
- **Veteran SRE / packaging engineer (0.5)** — owns single-binary build, Docker image, Helm chart, the self-host story.
- **Veteran technical writer (0.5)** — owns self-host quickstart, OAuth setup guide, "migrating from Calendly" guide.

Total: ~5 FTE for v0.1.

## Implementation plan

### Sprint 0 — foundations (1 week, all hands)

**Decisions made up-front (not deferred):**
- Web framework: **Next.js** (broader hiring pool, mature SSR story, our test fixtures don't depend on it).
- Time library: **Luxon** (see Timezone Correctness section).

Parallel tracks:
- SRE: repo scaffold, CI (axe + k6 wired in from day 1), Docker image, Postgres in compose.
- Backend: schema v1 (incl. `manual_blackouts`, exclusion constraint on availability rules, `email_outbox`), migration tooling.
- Scheduling engineer: spike slot generation behind a property-based test suite using the 8 invariants above — no UI, no DB, pure functions.
- Integrations engineer: spike Google OAuth + a single `events.insert` round-trip from a CLI script + fixture capture for OAuth failure modes.
- Full-stack: scaffold Next.js app shell, baseline a11y harness, CSRF middleware.
- Writer: outline the self-host quickstart so SRE knows what artifact shape is needed.

Gate: green CI on empty repo, working OAuth round-trip in dev, slot-gen passes 200+ property tests including DST fixtures, axe runs clean on app shell.

### Sprint 1 — single-provider booking happy path (2 weeks)

- Track A (scheduling + backend): slot-gen API → availability-rule CRUD with overlap rejection → booking create endpoint with race-window re-check + rate limit.
- Track B (integrations): Google one-way push (Calendry → Google) with idempotency, retry, OAuth failure handling, and a documented error taxonomy.
- Track C (full-stack): public booking page (read-only slot list) → booking form (CSRF, rate-limit, XSS-safe rendering) → confirmation screen.
- Track D (writer): first draft of self-host quickstart against Sprint 0 artifact.

Merge order within sprint: A's slot-gen unblocks C's slot list; B and C land independently; A+B+C integrate at end of sprint.

Gate: a real human can book a slot via a public URL on staging and the event appears on Google. SLO targets for booking POST and Google visibility met in load test.

### Sprint 2 — two-way sync, cancel/reschedule, reminders (2 weeks)

Parallel:
- Integrations: watch channel subscribe + webhook receiver (with authenticity verification) + sync-token pull loop + channel renewal cron. **Strict TDD here.**
- Backend: BusyBlock materialization, conflict detection, reminder job scheduling (with <24h late-booking skip), cancel + reschedule flows including Google `events.delete` and `events.patch`.
- Full-stack: admin UI for availability rules + manual blackouts, conflict notification surface, signed cancel/reschedule links + UI for bookers.
- Scheduling engineer: full DST-correctness pass, including the 3-week US/EU misalignment window, locked into CI as both unit and Playwright fixtures.

Gate: User Story 3 (Priya's last-minute external change) passes end-to-end manually **and the conflict-notification latency assertion test passes in CI** (≤5min from webhook to outbox row). Cancel and reschedule flows pass their TDD suites.

### Sprint 3 — polish, accessibility, self-host story (1 week)

Parallel:
- Full-stack: a11y audit beyond CI axe gates (manual screen-reader pass with NVDA + VoiceOver), mobile responsive layout, browser matrix smoke (Chrome / Firefox / Safari / mobile Safari).
- SRE: single-binary release artifact, Helm chart, "deploy in 10 min" path validated by a non-author.
- Integrations: ICS compatibility suite against Apple/Outlook parsers; fix any bugs surfaced.
- Writer: complete self-host guide, OAuth setup guide (including the "bring your own Google OAuth client" path for self-hosters), troubleshooting, OAuth-revoked recovery runbook.
- All: bug-bash of the three user stories against the enumerated checklist.

Gate: a developer who has never seen the project can self-host and book a slot in <30 minutes following only the docs. Verified by an external volunteer. Every checklist item across all three stories passes.

### Sprint 4 — beta, then v0.1 tag (1 week)

- Soft launch to ~10 friendly self-hosters (r/selfhosted, Mastodon).
- Watch error rates, sync drift, OAuth-status alerts, and support questions for 5 days.
- Tag v0.1 if no P0/P1 bugs surface.

Total: ~7 weeks of calendar time with 5 FTE.

## Risks & open questions

- **Google API quotas.** Default OAuth client quota may not survive a popular self-host instance. v0.1 must support a "bring your own Google OAuth client" mode and document it clearly.
- **Webhook delivery latency.** Google watch channel webhooks are best-effort. The 15-minute safety cron is the backstop, and the SLO table + user stories are honest about both paths.
- **Rate-limit defaults vs legitimate burst.** Default 10/IP/min may bite NAT'd corporate networks. v0.1 ships defaults plus a config knob and documents the trade.
- **Reminder skip for <24h bookings** vs providers who would prefer a T−1h reminder for short notice. v0.1 picks the simpler skip; configurable per-provider behavior is v0.2+.
- **CalDAV / Apple / Outlook.** Explicitly v0.2+. Do not let scope creep here.
- **Multi-provider / team scheduling / round-robin.** Explicitly v1.0+. Stay narrow.
- **Payments, intake forms, custom branding, embeds.** All v0.2+ at the earliest.
- **Temporal migration.** Tracked for v0.3+ once polyfill weight and Node-LTS support meet our bar.

## Embedded Changelog

- v0.1 — Initial spec. Defines: single-provider booking page with Google Calendar 2-way sync, confirmations + reminders, timezone-correct slot generation including DST edge cases, conflict detection on external mutation, single-binary self-host deploy. Hires: ~5 FTE veterans. Plan: 7 weeks across 5 sprints. Explicit non-goals: team scheduling, CRM, payments, non-Google calendar backends.
- v0.2 — Filled architecture diagram. Reconciled tenancy framing (single-organization-per-deploy, multi-provider schema). Reframed email path explicitly as transactional outbox (not fire-and-forget). Specified cancellation flow (Google `events.delete` + idempotency + cancel-from-conflicted). Specified reschedule flow (cancel-then-create with `rescheduled_from`, `events.patch` keeping `google_event_id`, sequence-numbered idempotency, old-reminder cancellation). Defined buffer semantics (after-only) and availability-rule overlap policy (rejected at write time via exclusion constraint). Defined late-booking reminder behavior (skip if <24h). Added `manual_blackouts` table + admin CRUD + sprint slot. Committed up-front to Luxon and Next.js (removed Sprint 0 deferral). Added SLO table with hard 5-minute conflict-notification SLO. Added latency assertion test backing that SLO. Added security test suite (auth, CSRF, rate-limit, XSS, signed-link tampering, webhook authenticity). Added OAuth failure-mode test suite + `oauth_status` field + admin surface. Added email failure-mode tests (SMTP transient, hard bounce, startup misconfig, stuck queue). Added axe a11y CI gate + per-component tests. Added ICS compatibility suite (Apple/Outlook parsers). Expanded Playwright to 4 locales matching Daniel's story + explicit Mar 8–29 2026 Madrid↔NYC scenario. Wrote 8 property-based invariants grounding the "200+ property tests" target. Replaced "manual acceptance = the three stories" with an enumerated checklist with measurable thresholds. No scope expansion; all changes are clarification, hardening, or test-coverage gaps surfaced by review.
