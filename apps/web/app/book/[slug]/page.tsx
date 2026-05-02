/**
 * /book/[slug] — public booking page (server-rendered slot list).
 *
 * Anonymous — no auth check (per SPEC amendment).
 * Detects booker timezone from Accept-Language + `zone` URL param override.
 * Fetches slots from /api/availability server-side for SSR correctness.
 * Slot timezone math via Luxon — no Date() arithmetic.
 */

import { DateTime } from "luxon";
import Link from "next/link";
import { groupSlotsByDay } from "../../../lib/booking-ui";

interface BookingPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ zone?: string }>;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

interface Slot {
  start_utc: string;
  end_utc: string;
}

async function fetchSlots(slug: string, zone: string): Promise<Slot[] | null> {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  const now = DateTime.utc();
  const from = now.startOf("day").toISO();
  const to = now.plus({ days: 14 }).endOf("day").toISO();

  const url = new URL("/api/availability", base);
  url.searchParams.set("slug", slug);
  url.searchParams.set("from", from ?? "");
  url.searchParams.set("to", to ?? "");
  url.searchParams.set("zone", zone);

  try {
    const res = await fetch(url.toString(), {
      // SSR — no cache (slots change when bookings come in)
      cache: "no-store",
    });
    if (!res.ok) {
      if (res.status === 404) return null; // provider not found
      return [];
    }
    const data = (await res.json()) as { slots?: Slot[] };
    return data.slots ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Timezone detection
// ---------------------------------------------------------------------------

/**
 * Determine the display timezone.
 * Priority: `zone` query param > UTC (JS-side Intl override handles the rest).
 *
 * WHY not Accept-Language: it encodes locale, not timezone. The JS client
 * overrides via the zone selector; see TimezoneNote component.
 */
function resolveZone(zoneParam: string | undefined): string {
  if (zoneParam && DateTime.now().setZone(zoneParam).isValid) {
    return zoneParam;
  }
  return "UTC";
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function SlotButton({ slot, slug, zone }: { slot: Slot; slug: string; zone: string }) {
  const dt = DateTime.fromISO(slot.start_utc, { zone });
  const timeLabel = dt.toFormat("h:mm a");
  const abbr = dt.toFormat("ZZZZ");
  const isoStart = encodeURIComponent(slot.start_utc);
  const isoZone = encodeURIComponent(zone);

  return (
    <Link
      href={`/book/${slug}/confirm?start=${isoStart}&zone=${isoZone}`}
      className="block w-full rounded-lg border border-gray-200 bg-white px-4 py-3 text-left text-sm font-medium text-gray-900 transition-colors hover:border-indigo-500 hover:bg-indigo-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
      aria-label={`Book slot at ${timeLabel} ${abbr}`}
      data-testid="slot-button"
    >
      <span className="font-semibold">{timeLabel}</span>
      <span className="ml-2 text-xs text-gray-500">{abbr}</span>
    </Link>
  );
}

function DayGroup({
  date,
  label,
  slots,
  slug,
  zone,
}: {
  date: string;
  label: string;
  slots: Slot[];
  slug: string;
  zone: string;
}) {
  return (
    <section aria-labelledby={`day-${date}`} className="mb-6">
      <h2
        id={`day-${date}`}
        className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500"
      >
        {label}
      </h2>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {slots.map((slot) => (
          <li key={slot.start_utc}>
            <SlotButton slot={slot} slug={slug} zone={zone} />
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function BookingPage({ params, searchParams }: BookingPageProps) {
  const { slug } = await params;
  const { zone: zoneParam } = await searchParams;

  // Resolve display timezone
  const zone = resolveZone(zoneParam);

  // Fetch slots server-side (SSR — correct timezone math, crawlable)
  const slots = await fetchSlots(slug, zone);

  if (slots === null) {
    // Provider not found
    return (
      <main className="mx-auto max-w-2xl px-4 py-16">
        <h1 className="mb-4 text-3xl font-bold text-gray-900">Page not found</h1>
        <p className="text-gray-500">
          No booking page found for <strong>{slug}</strong>.
        </p>
      </main>
    );
  }

  const groups = groupSlotsByDay(slots, zone);

  return (
    <main className="mx-auto max-w-2xl px-4 py-16" id="main-content">
      {/* Page header */}
      <header className="mb-10">
        <h1 className="mb-2 text-3xl font-bold text-gray-900">Book a session</h1>
        <p className="text-gray-500">
          Select an available time slot below. All times shown in{" "}
          <span aria-label={`timezone: ${zone}`} className="font-medium text-gray-700">
            {zone}
          </span>
          .
        </p>
        {/* JS-side timezone note — tells booker they can change zone */}
        <TimezoneNote currentZone={zone} slug={slug} />
      </header>

      {/* Slot list or empty state */}
      {groups.length === 0 ? (
        <output
          aria-live="polite"
          className="block rounded-lg border border-dashed border-gray-300 px-6 py-12 text-center"
        >
          <p className="text-base text-gray-500">No availability in the next 14 days. Try later.</p>
        </output>
      ) : (
        <div aria-label="Available time slots">
          {groups.map((group) => (
            <DayGroup
              key={group.date}
              date={group.date}
              label={group.label}
              slots={group.slots}
              slug={slug}
              zone={zone}
            />
          ))}
        </div>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Client component: timezone selector
// ---------------------------------------------------------------------------

/**
 * A small note + link for timezone overriding.
 *
 * WHY server component + URL param: no state library needed. Booker changes
 * zone via the dropdown (client JS), which re-navigates to the same page
 * with ?zone=<IANA>. SSR re-renders with the correct timezone.
 */
function TimezoneNote({ currentZone, slug }: { currentZone: string; slug: string }) {
  return (
    <p className="mt-1 text-xs text-gray-400">
      Not your timezone? <ZoneSelector currentZone={currentZone} slug={slug} />
    </p>
  );
}

// The zone selector needs client JS to read Intl.DateTimeFormat and update
// the URL. We inline a small <script> to avoid a full "use client" boundary
// (which would break SSR for the rest of the page).
function ZoneSelector({ currentZone, slug }: { currentZone: string; slug: string }) {
  // The script reads the browser's IANA zone and redirects if different.
  // data-slug + data-zone are read by the script to build the correct URL.
  const script = `
(function() {
  var el = document.getElementById('tz-link');
  if (!el) return;
  try {
    var detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    var current = el.dataset.current;
    el.textContent = 'Switch to ' + detected;
    el.href = '/book/' + el.dataset.slug + '?zone=' + encodeURIComponent(detected);
    if (detected === current) { el.style.display = 'none'; }
  } catch(e) {}
})();
`.trim();

  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: controlled static script */}
      <script dangerouslySetInnerHTML={{ __html: script }} />
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a
        id="tz-link"
        href={`/book/${slug}?zone=UTC`}
        data-slug={slug}
        data-current={currentZone}
        className="text-indigo-600 underline hover:text-indigo-800"
        aria-label="Switch to your detected browser timezone"
      >
        Switch timezone
      </a>
    </>
  );
}
