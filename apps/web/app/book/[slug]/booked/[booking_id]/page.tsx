/**
 * /book/[slug]/booked/[booking_id]?token=<cancel-token>&start=<utc>&booker_zone=<iana>&provider_zone=<iana>&booker_email=<email>
 *
 * Confirmation screen — server-rendered.
 * Anonymous — no auth. Token verified via signed-token.ts.
 *
 * Shows:
 *  - Slot in BOTH timezones (booker + provider) with UTC offsets + abbreviations.
 *  - "An email is on its way to <email>"
 *  - Cancel + reschedule buttons (disabled, "Coming soon" tooltip — Sprint 2).
 *
 * Token verification: if token is missing/invalid/expired, we still show the
 * confirmation (the booking was already created) but hide the cancel/reschedule
 * buttons with a note. WHY: the confirmation page is navigated to immediately
 * after a successful booking POST; the token is freshly signed. Token failure
 * here means either tampering or a very stale URL — we show a degraded page
 * rather than an error, because the booking itself succeeded.
 */

import { DateTime } from "luxon";
import { getPool } from "../../../../../../../packages/db/index";
import { escapeHtml, formatSlot } from "../../../../../lib/booking-ui";
import { TokenExpiredError, verifyToken } from "../../../../../lib/signed-token";

// ---------------------------------------------------------------------------
// Data fetching — look up booking from DB to get provider_zone
// ---------------------------------------------------------------------------

interface BookingRow {
  id: string;
  start_utc: string;
  end_utc: string;
  booker_email: string;
  booker_name: string;
  booker_notes: string | null;
  state: string;
  provider_home_tz: string;
}

async function fetchBooking(bookingId: string): Promise<BookingRow | null> {
  try {
    // Direct DB pool access in SSR — avoids an extra HTTP hop.
    const pool = getPool();
    const res = await pool.query<BookingRow>(
      `select b.id, b.start_utc, b.end_utc, b.booker_email,
              b.booker_name, b.booker_notes, b.state,
              p.home_tz as provider_home_tz
       from bookings b
       join providers p on p.id = b.provider_id
       where b.id = $1
       limit 1`,
      [bookingId],
    );
    return res.rows[0] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

type TokenStatus = "valid" | "expired" | "invalid" | "missing";

async function checkToken(token: string | undefined): Promise<TokenStatus> {
  if (!token) return "missing";
  try {
    await verifyToken(token);
    return "valid";
  } catch (err) {
    if (err instanceof TokenExpiredError) return "expired";
    return "invalid";
  }
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function TimezoneRow({
  label,
  formatted,
}: {
  label: string;
  formatted: string;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-baseline sm:gap-3">
      <span className="w-28 shrink-0 text-xs font-semibold uppercase tracking-wide text-gray-400">
        {label}
      </span>
      <span className="font-medium text-gray-900">{formatted}</span>
    </div>
  );
}

function ComingSoonButton({ label }: { label: string }) {
  return (
    <div className="group relative inline-block">
      <button
        type="button"
        disabled
        aria-disabled="true"
        title="Coming soon"
        className="cursor-not-allowed rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-400"
      >
        {label}
      </button>
      {/* Tooltip */}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded bg-gray-800 px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        Coming soon
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface BookedPageProps {
  params: Promise<{ slug: string; booking_id: string }>;
  searchParams: Promise<{
    token?: string;
    start?: string;
    booker_zone?: string;
    provider_zone?: string;
    booker_email?: string;
  }>;
}

export default async function BookedPage({ params, searchParams }: BookedPageProps) {
  const { slug, booking_id } = await params;
  const { token, start, booker_zone, provider_zone, booker_email } = await searchParams;

  // Verify token (parallel with DB fetch — both non-blocking)
  const [tokenStatus, booking] = await Promise.all([checkToken(token), fetchBooking(booking_id)]);

  // Determine timezones: prefer DB values; fall back to URL params
  const resolvedBookerZone = booker_zone ?? "UTC";
  const resolvedProviderZone = booking?.provider_home_tz ?? provider_zone ?? "UTC";
  const startUtc = booking?.start_utc ?? start ?? "";
  const endUtc = booking?.end_utc ?? "";
  const email = booking?.booker_email ?? booker_email ?? "";

  // Format slot in both zones — all Luxon, no Date() math
  const bookerSlot =
    startUtc && endUtc
      ? formatSlot({ start_utc: startUtc, end_utc: endUtc, zone: resolvedBookerZone })
      : startUtc
        ? formatSlot({
            start_utc: startUtc,
            end_utc:
              DateTime.fromISO(startUtc, { zone: resolvedBookerZone }).plus({ hours: 1 }).toISO() ??
              startUtc,
            zone: resolvedBookerZone,
          })
        : "—";

  const providerSlot =
    startUtc && endUtc
      ? formatSlot({ start_utc: startUtc, end_utc: endUtc, zone: resolvedProviderZone })
      : "—";

  // XSS-safe display of booker name/notes from DB
  const safeName = booking ? escapeHtml(booking.booker_name) : "";
  const safeNotes = booking ? escapeHtml(booking.booker_notes ?? "") : "";

  return (
    <main className="mx-auto max-w-lg px-4 py-16" id="main-content">
      {/* Success header */}
      <div className="mb-8 text-center">
        {/* SVG checkmark */}
        <div
          aria-hidden="true"
          className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100"
        >
          <svg
            className="h-8 w-8 text-green-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-3xl font-bold text-gray-900">Booking confirmed!</h1>
        {safeName && (
          <p
            className="mt-2 text-gray-500"
            /* safeName is HTML-escaped; we use dangerouslySetInnerHTML so that
               entities like &lt; render as text glyphs, not raw &lt;. The value
               has already been sanitised by escapeHtml(). */
            // biome-ignore lint/security/noDangerouslySetInnerHtml: pre-escaped by escapeHtml()
            dangerouslySetInnerHTML={{ __html: `Thanks, ${safeName}!` }}
          />
        )}
      </div>

      {/* Email confirmation notice */}
      {email && (
        <output
          aria-live="polite"
          className="mb-6 block rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800"
        >
          An email is on its way to <strong className="font-semibold">{email}</strong>.
        </output>
      )}

      {/* Slot details — both timezones */}
      <section
        aria-labelledby="slot-details-heading"
        className="mb-8 rounded-lg border border-gray-200 bg-white px-5 py-5"
      >
        <h2
          id="slot-details-heading"
          className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500"
        >
          Your appointment
        </h2>
        <div className="space-y-3">
          <TimezoneRow label="Your time" formatted={bookerSlot} />
          <div className="border-t border-gray-100" />
          <TimezoneRow label="Provider's time" formatted={providerSlot} />
        </div>

        {/* Notes — only shown if present; XSS-safe via dangerouslySetInnerHTML after escaping */}
        {safeNotes && (
          <div className="mt-4 border-t border-gray-100 pt-4">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">
              Your notes
            </p>
            <p
              className="text-sm text-gray-700"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: pre-escaped by escapeHtml()
              dangerouslySetInnerHTML={{ __html: safeNotes }}
            />
          </div>
        )}
      </section>

      {/* Token warning (degraded mode) */}
      {tokenStatus !== "valid" && (
        <div
          role="note"
          className="mb-6 rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        >
          {tokenStatus === "expired"
            ? "Your booking link has expired. The booking is still confirmed — contact the provider to cancel or reschedule."
            : "Confirmation link issue — your booking is still confirmed."}
        </div>
      )}

      {/* Cancel / reschedule — Sprint 2 placeholders */}
      <div className="flex gap-3">
        <ComingSoonButton label="Cancel booking" />
        <ComingSoonButton label="Reschedule" />
      </div>

      {/* Back to booking page */}
      <div className="mt-8 border-t border-gray-100 pt-6 text-center">
        <a
          href={`/book/${slug}`}
          className="text-sm text-indigo-600 underline hover:text-indigo-800"
        >
          Book another time
        </a>
      </div>
    </main>
  );
}
