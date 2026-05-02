/**
 * booking-ui.ts — shared helpers for the public booking UI.
 *
 * WHY a separate module: the escapeHtml() and timezone-rendering logic is
 * needed by both the server-rendered React pages and the unit tests (which
 * run in Bun without a DOM). Keeping them here avoids JSX deps in test scope.
 */

import { DateTime } from "luxon";

// ---------------------------------------------------------------------------
// Unicode bidi override characters — per SPEC §Tests Plan / Security.
// These characters can spoof displayed text direction and must be stripped.
// U+202A LRE, U+202B RLE, U+202C PDF, U+202D LRO, U+202E RLO
// U+2066 LRI, U+2067 RLI, U+2068 FSI, U+2069 PDI, U+200F RLM (RTL mark)
// ---------------------------------------------------------------------------
const BIDI_CHARS_RE = /[‏‪-‮⁦-⁩]/g;

/**
 * HTML-escape a string for safe rendering in HTML context.
 *
 * Performs two operations in order:
 *   1. Strip Unicode bidi override/embedding control characters (XSS + spoofing).
 *   2. Escape HTML special characters (&, <, >, ", ').
 *
 * Safe to call with undefined/null — returns "".
 */
export function escapeHtml(input: string | null | undefined): string {
  if (input == null) return "";
  // Strip bidi control characters first
  const stripped = String(input).replace(BIDI_CHARS_RE, "");
  // Escape HTML special characters
  return stripped
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Slot formatting
// ---------------------------------------------------------------------------

export interface SlotFormatOptions {
  start_utc: string;
  end_utc: string;
  zone: string;
}

/**
 * Format a slot as a human-readable string in the given IANA timezone.
 * Output example: "Tue, Mar 10, 2026 · 3:00 PM EDT (UTC−04:00)"
 *
 * Uses Luxon exclusively — no Date() math.
 */
export function formatSlot({ start_utc, end_utc, zone }: SlotFormatOptions): string {
  const start = DateTime.fromISO(start_utc, { zone });
  const end = DateTime.fromISO(end_utc, { zone });

  if (!start.isValid || !end.isValid) return "Invalid time";

  const abbr = start.toFormat("ZZZZ"); // e.g. "EDT", "CET"
  const offset = start.toFormat("ZZ"); // e.g. "+0100"

  // Format offset as UTC±HH:MM per SPEC §Timezone correctness
  const offsetFormatted = formatUtcOffset(start.offset);

  const date = start.toFormat("EEE, MMM d, yyyy");
  const timeStart = start.toFormat("h:mm a");
  const timeEnd = end.toFormat("h:mm a");

  return `${date} · ${timeStart}–${timeEnd} ${abbr} (UTC${offsetFormatted})`;
}

/**
 * Format a UTC offset (in minutes) as ±HH:MM.
 * e.g. -240 → "−04:00", 60 → "+01:00", 0 → "+00:00"
 */
function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "−"; // use proper minus sign U+2212
  const abs = Math.abs(offsetMinutes);
  const h = Math.floor(abs / 60)
    .toString()
    .padStart(2, "0");
  const m = (abs % 60).toString().padStart(2, "0");
  return `${sign}${h}:${m}`;
}

// ---------------------------------------------------------------------------
// Booking details formatting (used by confirmation screen)
// ---------------------------------------------------------------------------

export interface BookingDetailsInput {
  booker_name: string;
  booker_email: string;
  booker_notes: string | null | undefined;
  start_utc: string;
  end_utc: string;
  booker_zone: string;
  provider_zone: string;
}

export interface BookingDetails {
  /** HTML-escaped booker name */
  safeName: string;
  /** HTML-escaped booker notes (empty string if null/undefined) */
  safeNotes: string;
  /** Slot formatted in booker's timezone */
  bookerSlot: string;
  /** Slot formatted in provider's timezone */
  providerSlot: string;
  /** The booker's IANA zone abbreviation at the slot time */
  bookerAbbr: string;
  /** The provider's IANA zone abbreviation at the slot time */
  providerAbbr: string;
}

/**
 * Produce all formatted + escaped fields needed to render the confirmation screen.
 *
 * Always uses Luxon for timezone math — no Date() arithmetic.
 */
export function formatBookingDetails(input: BookingDetailsInput): BookingDetails {
  const safeName = escapeHtml(input.booker_name);
  const safeNotes = escapeHtml(input.booker_notes ?? "");

  const bookerSlot = formatSlot({
    start_utc: input.start_utc,
    end_utc: input.end_utc,
    zone: input.booker_zone,
  });

  const providerSlot = formatSlot({
    start_utc: input.start_utc,
    end_utc: input.end_utc,
    zone: input.provider_zone,
  });

  const bookerAbbr = DateTime.fromISO(input.start_utc, { zone: input.booker_zone }).toFormat(
    "ZZZZ",
  );
  const providerAbbr = DateTime.fromISO(input.start_utc, { zone: input.provider_zone }).toFormat(
    "ZZZZ",
  );

  return { safeName, safeNotes, bookerSlot, providerSlot, bookerAbbr, providerAbbr };
}

// ---------------------------------------------------------------------------
// Slot grouping (for the slot-list page)
// ---------------------------------------------------------------------------

export interface Slot {
  start_utc: string;
  end_utc: string;
}

export interface SlotGroup {
  /** ISO date string in the booker's zone: "2026-03-10" */
  date: string;
  /** Human-readable day label: "Tue, Mar 10" */
  label: string;
  slots: Slot[];
}

/**
 * Group a flat slot array by calendar day in the given IANA zone.
 * Slots within a group are in ascending order.
 * Empty input → empty array.
 */
export function groupSlotsByDay(slots: Slot[], zone: string): SlotGroup[] {
  const groups = new Map<string, SlotGroup>();

  for (const slot of slots) {
    const dt = DateTime.fromISO(slot.start_utc, { zone });
    if (!dt.isValid) continue;

    const date = dt.toISODate() ?? "";
    if (!groups.has(date)) {
      groups.set(date, {
        date,
        label: dt.toFormat("EEE, MMM d"),
        slots: [],
      });
    }
    // biome-ignore lint/style/noNonNullAssertion: set above
    groups.get(date)!.slots.push(slot);
  }

  // Return in ascending date order
  return Array.from(groups.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Format a single slot's start time for display in a given zone.
 * Output: "10:00 AM" — used for slot buttons in the list.
 */
export function formatSlotTime(start_utc: string, zone: string): string {
  const dt = DateTime.fromISO(start_utc, { zone });
  if (!dt.isValid) return "—";
  return dt.toFormat("h:mm a");
}

/**
 * Detect the best IANA timezone from an Accept-Language header.
 *
 * This is a best-effort heuristic: Accept-Language doesn't carry timezone.
 * We default to "UTC" and let the JS-side zone selector override.
 * The definitive zone detection happens client-side via Intl.DateTimeFormat.
 */
export function detectTimezoneFromHeaders(_acceptLanguage: string | null): string {
  // WHY: Accept-Language encodes locale, not timezone. We cannot reliably
  // map "en-US" → "America/New_York" server-side. Return UTC and let the
  // client-side <TimezoneSelector> override via a `zone` URL param.
  return "UTC";
}
