/**
 * POST /api/bookings
 *
 * Public, anonymous, CSRF-exempt (per SPEC amendment + middleware.ts).
 * Rate-limited: 10/IP/min and 3/booker_email/min.
 *
 * Body: { slug, start_utc, booker_email, booker_name, booker_notes? }
 *
 * Flow (all inside ONE transaction):
 *   1. Resolve provider by slug.
 *   2. Compute idempotency_key = sha256(booker_email + ":" + start_utc + ":" + slug).
 *   3. Check idempotency_keys table — if hit, return 200 with original booking.
 *   4. Re-validate slot against current BusyBlock (SELECT ... FOR UPDATE on overlapping rows).
 *   5. Insert bookings row (state=pending_push).
 *   6. Insert email_outbox: confirmation (always) + reminder (only if start_utc - now > 24h).
 *   7. Enqueue google_push job via pgque.send().
 *   8. Insert idempotency_keys row.
 *   COMMIT.
 *   9. Issue signed cancel + reschedule tokens (outside tx — pure crypto).
 *  10. Return 201 { booking_id, status, cancel_token, reschedule_token }.
 *
 * On slot conflict → 409.
 * On idempotency hit → 200 with original booking.
 */

import { type NextRequest, NextResponse } from "next/server";
import { withClient } from "../../../../../packages/db/index";
import type { Booking } from "../../../../../packages/db/index";
import { deriveBookingIdempotencyKey } from "../../../lib/idempotency";
import { emailRateLimiter, ipRateLimiter } from "../../../lib/rate-limiter";
import { signToken } from "../../../lib/signed-token";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest): Promise<NextResponse> {
  // --- Rate limiting ---
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";

  const ipCheck = ipRateLimiter.check(ip);
  if (!ipCheck.allowed) {
    return NextResponse.json(
      { error: "Too many requests from this IP" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(ipCheck.retryAfterMs / 1000)) },
      },
    );
  }

  // --- Parse body ---
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validated = validateBookingBody(body);
  if ("error" in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const { slug, start_utc, booker_email, booker_name, booker_notes } = validated;

  // --- Email rate limiting (after body parse so we have the email) ---
  const emailCheck = emailRateLimiter.check(booker_email.toLowerCase());
  if (!emailCheck.allowed) {
    return NextResponse.json(
      { error: "Too many bookings for this email address" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(emailCheck.retryAfterMs / 1000)) },
      },
    );
  }

  // --- Derive idempotency key ---
  const idempotencyKey = await deriveBookingIdempotencyKey({
    bookerEmail: booker_email,
    startUtc: start_utc,
    slug,
  });

  // --- All of this runs in ONE transaction ---
  const result = await withClient(async (client) => {
    await client.query("begin");

    try {
      // 1. Resolve provider
      const providerRes = await client.query<{ id: string; home_tz: string; slot_minutes: number }>(
        `select p.id, p.home_tz,
                coalesce(
                  (select slot_minutes from availability_rules
                   where provider_id = p.id limit 1),
                  60
                ) as slot_minutes
         from providers p
         where p.slug = $1
         limit 1`,
        [slug],
      );
      if (providerRes.rows.length === 0) {
        await client.query("rollback");
        return { type: "not_found" as const };
      }
      // biome-ignore lint/style/noNonNullAssertion: rows.length === 0 checked above
      const provider = providerRes.rows[0]!;

      // 2. Check idempotency — return existing booking if already exists
      const existingRes = await client.query<Booking>(
        "select * from bookings where idempotency_key = $1 limit 1",
        [idempotencyKey],
      );
      if (existingRes.rows.length > 0) {
        // biome-ignore lint/style/noNonNullAssertion: rows.length > 0 checked above
        const existing = existingRes.rows[0]!;
        await client.query("commit");
        return { type: "idempotent" as const, booking: existing };
      }

      // 3. Compute slot end time
      // Find the matching availability rule to get slot_minutes
      const slotStart = new Date(start_utc);
      const ruleRes = await client.query<{ slot_minutes: number }>(
        `select slot_minutes from availability_rules
         where provider_id = $1
           and valid_from <= $2::date
           and valid_to   >= $2::date
         order by start_local
         limit 1`,
        [provider.id, start_utc.substring(0, 10)],
      );
      const slotMinutes = ruleRes.rows[0]?.slot_minutes ?? 60;
      const slotEnd = new Date(slotStart.getTime() + slotMinutes * 60 * 1000);

      // 4. Re-validate slot against CURRENT BusyBlock set — inside the transaction
      // Use SELECT ... FOR UPDATE on any overlapping bookings to prevent races.
      // We lock the rows that would conflict, then check the count.
      const conflictBookingsRes = await client.query<{ id: string }>(
        `select id from bookings
         where provider_id = $1
           and start_utc < $3
           and end_utc   > $2
           and state not in ('cancelled', 'rescheduled')
         for update`,
        [provider.id, slotStart.toISOString(), slotEnd.toISOString()],
      );

      const conflictBusyRes = await client.query<{ id: number }>(
        `select id from busy_blocks
         where provider_id = $1
           and start_utc < $3
           and end_utc   > $2`,
        [provider.id, slotStart.toISOString(), slotEnd.toISOString()],
      );

      const conflictBlackoutRes = await client.query<{ id: number }>(
        `select id from manual_blackouts
         where provider_id = $1
           and start_utc < $3
           and end_utc   > $2`,
        [provider.id, slotStart.toISOString(), slotEnd.toISOString()],
      );

      if (
        conflictBookingsRes.rows.length > 0 ||
        conflictBusyRes.rows.length > 0 ||
        conflictBlackoutRes.rows.length > 0
      ) {
        await client.query("rollback");
        return { type: "conflict" as const };
      }

      // 5. Insert booking row
      const bookingRes = await client.query<Booking>(
        `insert into bookings
           (provider_id, booker_email, booker_name, booker_notes,
            start_utc, end_utc, state, idempotency_key)
         values ($1, $2, $3, $4, $5, $6, 'pending_push', $7)
         returning *`,
        [
          provider.id,
          booker_email,
          booker_name,
          booker_notes ?? null,
          slotStart.toISOString(),
          slotEnd.toISOString(),
          idempotencyKey,
        ],
      );
      // biome-ignore lint/style/noNonNullAssertion: INSERT RETURNING always returns a row
      const booking = bookingRes.rows[0]!;

      // 6. Insert email_outbox rows in SAME transaction
      const now = Date.now();
      const leadTimeMs = slotStart.getTime() - now;
      const twentyFourHoursMs = 24 * 60 * 60 * 1000;

      // Confirmation: always, send_after = now()
      await client.query(
        `insert into email_outbox
           (booking_id, kind, recipient_email, send_after, idempotency_key)
         values ($1, 'confirmation', $2, now(), $3)`,
        [booking.id, booker_email, `${booking.id}:confirmation`],
      );

      // Reminder: only if start_utc - now > 24h (SPEC §Late-booking reminder)
      if (leadTimeMs > twentyFourHoursMs) {
        const reminderSendAfter = new Date(slotStart.getTime() - twentyFourHoursMs);
        await client.query(
          `insert into email_outbox
             (booking_id, kind, recipient_email, send_after, idempotency_key)
           values ($1, 'reminder', $2, $3, $4)`,
          [booking.id, booker_email, reminderSendAfter.toISOString(), `${booking.id}:reminder`],
        );
      }

      // 7. Enqueue google_push job via pgque.send()
      // why: pgque.send(queue, payload jsonb) — see db/pgque.sql §Modern API
      await client.query(`select pgque.send('google_push', $1::jsonb)`, [
        JSON.stringify({ booking_id: booking.id, provider_id: provider.id }),
      ]);

      // 8. Insert idempotency_keys row
      await client.query(
        `insert into idempotency_keys (key, kind, result_json)
         values ($1, 'booking', $2)
         on conflict do nothing`,
        [idempotencyKey, JSON.stringify({ booking_id: booking.id })],
      );

      await client.query("commit");
      return { type: "created" as const, booking };
    } catch (err) {
      await client.query("rollback");
      throw err;
    }
  });

  // --- Handle results ---
  if (result.type === "not_found") {
    return NextResponse.json({ error: "Provider not found" }, { status: 404 });
  }

  if (result.type === "conflict") {
    return NextResponse.json(
      { error: "The selected time slot is no longer available" },
      { status: 409 },
    );
  }

  if (result.type === "idempotent") {
    const booking = result.booking;
    const [cancelToken, rescheduleToken] = await Promise.all([
      signToken({ booking_id: booking.id, kind: "cancel", issued_at: Date.now() }),
      signToken({ booking_id: booking.id, kind: "reschedule", issued_at: Date.now() }),
    ]);
    return NextResponse.json({
      booking_id: booking.id,
      status: booking.state,
      cancel_token: cancelToken,
      reschedule_token: rescheduleToken,
    });
  }

  // result.type === "created"
  const booking = result.booking;
  const [cancelToken, rescheduleToken] = await Promise.all([
    signToken({ booking_id: booking.id, kind: "cancel", issued_at: Date.now() }),
    signToken({ booking_id: booking.id, kind: "reschedule", issued_at: Date.now() }),
  ]);
  return NextResponse.json(
    {
      booking_id: booking.id,
      status: booking.state,
      cancel_token: cancelToken,
      reschedule_token: rescheduleToken,
    },
    { status: 201 },
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidatedBookingBody {
  slug: string;
  start_utc: string;
  booker_email: string;
  booker_name: string;
  booker_notes?: string;
}

function validateBookingBody(body: unknown): ValidatedBookingBody | { error: string } {
  if (!body || typeof body !== "object") return { error: "Body must be an object" };
  const b = body as Record<string, unknown>;

  if (!b.slug || typeof b.slug !== "string") return { error: "slug is required" };
  if (!b.start_utc || typeof b.start_utc !== "string") return { error: "start_utc is required" };
  if (!b.booker_email || typeof b.booker_email !== "string")
    return { error: "booker_email is required" };
  if (!b.booker_name || typeof b.booker_name !== "string")
    return { error: "booker_name is required" };

  // Basic ISO 8601 check
  const d = new Date(b.start_utc);
  if (Number.isNaN(d.getTime())) return { error: "start_utc must be a valid ISO 8601 timestamp" };

  // Basic email format
  if (!b.booker_email.includes("@")) return { error: "booker_email must be a valid email address" };

  return {
    slug: b.slug,
    start_utc: b.start_utc,
    booker_email: b.booker_email,
    booker_name: b.booker_name,
    booker_notes: typeof b.booker_notes === "string" ? b.booker_notes : undefined,
  };
}
