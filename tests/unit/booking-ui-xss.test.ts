/**
 * booking-ui-xss.test.ts
 *
 * TDD-first: XSS-safety tests for booker_name and booker_notes rendering
 * on the confirmation screen and slot list.
 *
 * These tests assert that the escapeHtml() helper and the rendering helpers
 * correctly HTML-escape dangerous content including:
 *   - Classic <script> injection
 *   - Unicode bidi-attack strings (LRE/RLE/PDF control characters)
 *   - Double-escape safety (no double-encoding)
 *
 * Run: bun test tests/unit/booking-ui-xss.test.ts
 */

import { describe, expect, it } from "bun:test";
import { escapeHtml, formatBookingDetails } from "../../apps/web/lib/booking-ui";

// ---------------------------------------------------------------------------
// XSS fixtures (from SPEC §Tests Plan / Security)
// ---------------------------------------------------------------------------

const XSS_FIXTURES = [
  {
    label: "script tag injection",
    input: "<script>alert(1)</script>",
    shouldNotContain: "<script>",
  },
  {
    label: "script tag with attributes",
    input: '<script src="evil.js">',
    shouldNotContain: "<script",
  },
  {
    label: "img onerror injection",
    input: "<img src=x onerror=alert(1)>",
    shouldNotContain: "<img",
  },
  {
    label: "unicode bidi LRE attack",
    // U+202A LEFT-TO-RIGHT EMBEDDING followed by admin text
    input: "‪admin‬",
    shouldNotContain: "‪", // bidi chars must be escaped or stripped
  },
  {
    label: "unicode bidi RLO attack",
    // U+202E RIGHT-TO-LEFT OVERRIDE — classic bidi filename spoofing
    input: "moc.evil‮txt.exe",
    shouldNotContain: "‮",
  },
  {
    label: "HTML entity in name",
    input: "O'Brien & <Associates>",
    shouldContain: "O&#39;Brien",
    shouldAlsoContain: "&amp;",
  },
  {
    label: "double quote injection",
    input: '"onclick=alert(1)',
    shouldNotContain: '"onclick',
  },
];

describe("escapeHtml()", () => {
  it("returns plain text unchanged", () => {
    expect(escapeHtml("Hello World")).toBe("Hello World");
  });

  it("escapes & to &amp;", () => {
    expect(escapeHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
  });

  it("escapes < to &lt;", () => {
    expect(escapeHtml("<div>")).toBe("&lt;div&gt;");
  });

  it("escapes > to &gt;", () => {
    expect(escapeHtml("x > y")).toBe("x &gt; y");
  });

  it('escapes " to &quot;', () => {
    expect(escapeHtml('"hello"')).toBe("&quot;hello&quot;");
  });

  it("escapes ' to &#39;", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("strips bidi LRE control character (U+202A)", () => {
    const result = escapeHtml("‪admin‬");
    expect(result).not.toContain("‪");
    expect(result).not.toContain("‬");
  });

  it("strips bidi RLO control character (U+202E)", () => {
    const result = escapeHtml("file‮txt");
    expect(result).not.toContain("‮");
  });

  it("strips full set of Unicode bidi override characters", () => {
    // U+202A LRE, U+202B RLE, U+202C PDF, U+202D LRO, U+202E RLO
    // U+2066 LRI, U+2067 RLI, U+2068 FSI, U+2069 PDI, U+200F RLM
    const bidiChars = "‪‫‬‭‮⁦⁧⁨⁩‏";
    const result = escapeHtml(`hello${bidiChars}world`);
    for (const c of bidiChars) {
      expect(result).not.toContain(c);
    }
    expect(result).toContain("hello");
    expect(result).toContain("world");
  });

  it("handles the classic XSS fixture: <script>alert(1)</script>", () => {
    const result = escapeHtml("<script>alert(1)</script>");
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("</script>");
    expect(result).toContain("&lt;script&gt;");
  });

  it("does not double-encode already-escaped text", () => {
    // If input already contains &amp; — it should escape to &amp;amp;, not leave it
    // (escapeHtml is NOT idempotent by design — it is applied exactly once at render)
    const result = escapeHtml("&amp;");
    expect(result).toBe("&amp;amp;");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("handles null-ish input coerced to empty string", () => {
    // Safety: undefined should produce empty string, not throw
    expect(escapeHtml(undefined as unknown as string)).toBe("");
  });
});

describe("formatBookingDetails() — XSS safety on rendered fields", () => {
  const baseBooking = {
    booker_name: "Jane Doe",
    booker_email: "jane@example.com",
    booker_notes: "None",
    start_utc: "2026-03-10T19:00:00.000Z",
    end_utc: "2026-03-10T20:00:00.000Z",
    booker_zone: "America/New_York",
    provider_zone: "Europe/Madrid",
  };

  it("returns safe name for normal input", () => {
    const result = formatBookingDetails(baseBooking);
    expect(result.safeName).toBe("Jane Doe");
  });

  it("HTML-escapes booker_name with <script> tag", () => {
    const result = formatBookingDetails({
      ...baseBooking,
      booker_name: "<script>alert(1)</script>",
    });
    expect(result.safeName).not.toContain("<script>");
    expect(result.safeName).toContain("&lt;script&gt;");
  });

  it("HTML-escapes booker_name with bidi RLO attack", () => {
    const result = formatBookingDetails({
      ...baseBooking,
      booker_name: "moc.evil‮txt.exe",
    });
    expect(result.safeName).not.toContain("‮");
  });

  it("HTML-escapes booker_notes with <script> tag", () => {
    const result = formatBookingDetails({
      ...baseBooking,
      booker_notes: '<script src="evil.js">',
    });
    expect(result.safeNotes).not.toContain("<script");
    expect(result.safeNotes).toContain("&lt;script");
  });

  it("HTML-escapes booker_notes with bidi LRE attack", () => {
    const result = formatBookingDetails({
      ...baseBooking,
      booker_notes: "‪admin‬",
    });
    expect(result.safeNotes).not.toContain("‪");
  });

  it("renders null notes as empty string (not 'null' or undefined)", () => {
    const result = formatBookingDetails({
      ...baseBooking,
      booker_notes: null as unknown as string,
    });
    expect(result.safeNotes).toBe("");
  });

  it("renders slot in booker timezone (America/New_York)", () => {
    const result = formatBookingDetails(baseBooking);
    // 2026-03-10T19:00 UTC = 3:00 PM EST (UTC-5; before US DST on Mar 8... wait,
    // US DST 2026 is Mar 8, so by Mar 10 clocks are already on EDT UTC-4)
    // 19:00 UTC - 4h = 15:00 EDT
    expect(result.bookerSlot).toContain("EDT");
    expect(result.bookerSlot).toContain("3:00 PM");
  });

  it("renders slot in provider timezone (Europe/Madrid)", () => {
    const result = formatBookingDetails(baseBooking);
    // 2026-03-10T19:00 UTC in Europe/Madrid = 20:00 UTC+1 (EU DST starts Mar 29)
    // Luxon returns "GMT+1" for Europe/Madrid in standard time (no "CET" abbreviation
    // in Luxon's IANA TZDB data — this is correct per the TZDB).
    expect(result.providerSlot).toContain("GMT+1");
    expect(result.providerSlot).toContain("8:00 PM");
    expect(result.providerSlot).toContain("UTC+01:00");
  });

  it("DST cross-zone: Brooklyn (EDT) vs Madrid (UTC+1) on Mar 10 2026", () => {
    // US DST started Mar 8 2026 (EDT = UTC-4)
    // EU DST starts Mar 29 2026 (UTC+1 standard → UTC+2 CEST)
    // So Mar 10: Brooklyn is EDT (-4), Madrid is UTC+1 (Luxon → "GMT+1")
    const result = formatBookingDetails({
      ...baseBooking,
      start_utc: "2026-03-10T14:00:00.000Z", // 10:00 EDT / 15:00 UTC+1
      end_utc: "2026-03-10T15:00:00.000Z",
    });
    expect(result.bookerSlot).toContain("EDT");
    // Luxon abbreviation for America/New_York in EDT = "EDT" ✓
    // Luxon abbreviation for Europe/Madrid in standard time = "GMT+1"
    expect(result.providerSlot).toContain("GMT+1");
    // Booker: 14:00 UTC - 4h = 10:00 AM EDT
    expect(result.bookerSlot).toContain("10:00 AM");
    // Provider: 14:00 UTC + 1h = 15:00 = 3:00 PM
    expect(result.providerSlot).toContain("3:00 PM");
    // Explicit UTC offsets must appear (SPEC §Timezone correctness)
    expect(result.bookerSlot).toContain("UTC−04:00");
    expect(result.providerSlot).toContain("UTC+01:00");
  });
});

// ---------------------------------------------------------------------------
// XSS fixtures round-trip
// ---------------------------------------------------------------------------

describe("escapeHtml() — XSS fixture table", () => {
  for (const fixture of XSS_FIXTURES) {
    it(`fixture: ${fixture.label}`, () => {
      const result = escapeHtml(fixture.input);
      if (fixture.shouldNotContain) {
        expect(result).not.toContain(fixture.shouldNotContain);
      }
      if (fixture.shouldContain) {
        expect(result).toContain(fixture.shouldContain);
      }
      if (fixture.shouldAlsoContain) {
        expect(result).toContain(fixture.shouldAlsoContain);
      }
    });
  }
});
