/**
 * GET /api/availability?slug=&from=&to=&zone=
 *
 * Public, anonymous. Returns available time slots for a provider.
 * No DB writes. No booking_id leakage.
 *
 * Query params:
 *   slug  — provider URL slug (required)
 *   from  — ISO 8601 UTC start of window (required)
 *   to    — ISO 8601 UTC end of window (required)
 *   zone  — IANA timezone for cosmetic rendering (optional, ignored in math)
 *
 * Response: { slots: [{ start_utc, end_utc }, ...] }
 *
 * BusyBlock set: existing active bookings + manual_blackouts.
 * Google-derived blocks: empty for Sprint 1 (Sprint 2 wires them in).
 */

import { DateTime } from "luxon";
import { type NextRequest, NextResponse } from "next/server";
import { generateSlots } from "../../../../../packages/core/src/slot-gen";
import type {
  BusyBlock as CoreBusyBlock,
  AvailabilityRule as CoreRule,
} from "../../../../../packages/core/src/slot-gen";
import { getPool } from "../../../../../packages/db/index";
import type { AvailabilityRule, Booking, BusyBlock } from "../../../../../packages/db/index";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl;
  const slug = searchParams.get("slug");
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  const zone = searchParams.get("zone") ?? "UTC";

  // --- Validate required params ---
  if (!slug) {
    return NextResponse.json({ error: "slug is required" }, { status: 400 });
  }
  if (!fromParam || !toParam) {
    return NextResponse.json({ error: "from and to are required" }, { status: 400 });
  }

  const fromUtc = DateTime.fromISO(fromParam, { zone: "UTC" });
  const toUtc = DateTime.fromISO(toParam, { zone: "UTC" });
  if (!fromUtc.isValid || !toUtc.isValid) {
    return NextResponse.json(
      { error: "from and to must be valid ISO 8601 timestamps" },
      { status: 400 },
    );
  }
  if (toUtc <= fromUtc) {
    return NextResponse.json({ error: "to must be after from" }, { status: 400 });
  }

  const pool = getPool();

  // --- Look up provider ---
  const providerRes = await pool.query<{ id: string; home_tz: string }>(
    "select id, home_tz from providers where slug = $1 limit 1",
    [slug],
  );
  if (providerRes.rows.length === 0) {
    return NextResponse.json({ error: "Provider not found" }, { status: 404 });
  }
  // biome-ignore lint/style/noNonNullAssertion: rows.length === 0 checked above
  const provider = providerRes.rows[0]!;

  // --- Fetch availability rules ---
  const rulesRes = await pool.query<AvailabilityRule>(
    `select * from availability_rules
     where provider_id = $1
       and valid_from <= $3::date
       and valid_to   >= $2::date
     order by weekday, start_local`,
    [provider.id, fromParam.substring(0, 10), toParam.substring(0, 10)],
  );

  // --- Fetch BusyBlock set: active bookings + manual_blackouts ---
  const bookingsRes = await pool.query<Pick<Booking, "start_utc" | "end_utc">>(
    `select start_utc, end_utc from bookings
     where provider_id = $1
       and start_utc < $3
       and end_utc   > $2
       and state not in ('cancelled', 'rescheduled')`,
    [provider.id, fromUtc.toISO(), toUtc.toISO()],
  );

  const blackoutsRes = await pool.query<{ start_utc: string; end_utc: string }>(
    `select start_utc, end_utc from manual_blackouts
     where provider_id = $1
       and start_utc < $3
       and end_utc   > $2`,
    [provider.id, fromUtc.toISO(), toUtc.toISO()],
  );

  // Also include busy_blocks (materialized cache including Google-derived blocks)
  const busyBlocksRes = await pool.query<Pick<BusyBlock, "start_utc" | "end_utc">>(
    `select start_utc, end_utc from busy_blocks
     where provider_id = $1
       and start_utc < $3
       and end_utc   > $2`,
    [provider.id, fromUtc.toISO(), toUtc.toISO()],
  );

  // --- Convert DB rows to core types ---
  const coreRules: CoreRule[] = rulesRes.rows.map((r) => {
    // DB weekday: 0=Sun..6=Sat; core weekday: 1=Mon..7=Sun (ISO)
    // DB schema says weekday 0=Sunday..6=Saturday
    const dbWeekday = r.weekday; // 0..6
    // Convert to Luxon ISO weekday: Mon=1..Sun=7
    const isoWeekday = dbWeekday === 0 ? 7 : dbWeekday;

    return {
      weekday: isoWeekday as 1 | 2 | 3 | 4 | 5 | 6 | 7,
      start_local: timeToMinutes(r.start_local),
      end_local: timeToMinutes(r.end_local),
      slot_minutes: r.slot_minutes,
      buffer_minutes: r.buffer_minutes,
      zone: provider.home_tz,
      valid_from: DateTime.fromISO(r.valid_from, { zone: provider.home_tz }),
      valid_to: DateTime.fromISO(r.valid_to, { zone: provider.home_tz }),
    };
  });

  const coreBusy: CoreBusyBlock[] = [
    ...bookingsRes.rows,
    ...blackoutsRes.rows,
    ...busyBlocksRes.rows,
  ].map((r) => ({
    startUtc: DateTime.fromISO(r.start_utc, { zone: "UTC" }),
    endUtc: DateTime.fromISO(r.end_utc, { zone: "UTC" }),
  }));

  // --- Generate slots ---
  const slots = generateSlots({
    rules: coreRules,
    busy: coreBusy,
    window: { startUtc: fromUtc, endUtc: toUtc },
    providerZone: provider.home_tz,
    renderZone: zone,
  });

  // --- Return shape: { slots: [{ start_utc, end_utc }] } ---
  // No booking_id leakage — pure availability
  return NextResponse.json({
    slots: slots.map((s) => ({
      start_utc: s.startUtc.toISO(),
      end_utc: s.startUtc.plus({ minutes: s.durationMinutes }).toISO(),
    })),
  });
}

/** Convert a time string "HH:MM:SS" or "HH:MM" to minutes from midnight. */
function timeToMinutes(t: string): number {
  const parts = t.split(":");
  const h = Number.parseInt(parts[0] ?? "0", 10);
  const m = Number.parseInt(parts[1] ?? "0", 10);
  return h * 60 + m;
}
