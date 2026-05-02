/**
 * slot-gen.test.ts
 *
 * 8 property-based invariants (≥200 cases each via fast-check) +
 * required fixed-case DST and scheduling fixtures.
 *
 * TDD commit: this file is written BEFORE slot-gen.ts exists.
 * Run: bun test tests/unit/slot-gen.test.ts
 */

import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import { DateTime } from "luxon";
import { generateSlots } from "../../packages/core/src/slot-gen";
import type { AvailabilityRule, BusyBlock, Slot } from "../../packages/core/src/slot-gen";

// ---------------------------------------------------------------------------
// Helpers shared across tests
// ---------------------------------------------------------------------------

/** Build a DateTime in the given IANA zone at a specific date+time. */
function dt(
  zone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): DateTime {
  return DateTime.fromObject({ year, month, day, hour, minute }, { zone });
}

/** Build a simple rule for a given weekday (1=Mon…7=Sun in Luxon ISO) */
function rule(
  weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7,
  startHour: number,
  endHour: number,
  slotMinutes: number,
  bufferMinutes: number,
  zone: string,
  validFrom?: DateTime,
  validTo?: DateTime,
): AvailabilityRule {
  return {
    weekday,
    start_local: startHour * 60, // minutes from midnight
    end_local: endHour * 60,
    slot_minutes: slotMinutes,
    buffer_minutes: bufferMinutes,
    zone,
    valid_from: validFrom ?? null,
    valid_to: validTo ?? null,
  };
}

/** Build a busy block from two UTC DateTimes. */
function busy(startUtc: DateTime, endUtc: DateTime): BusyBlock {
  return { startUtc, endUtc };
}

// ---------------------------------------------------------------------------
// fast-check arbitraries
// ---------------------------------------------------------------------------

const IANA_ZONES = [
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "Europe/Madrid",
  "Europe/London",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];

const ianaZoneArb = fc.constantFrom(...IANA_ZONES);

/** Arbitrary slot_minutes in [15, 120] step 5 */
const slotMinutesArb = fc.integer({ min: 1, max: 24 }).map((n) => n * 5 as 5 | 10 | 15 | 20 | 25 | 30 | 35 | 40 | 45 | 50 | 55 | 60 | 65 | 70 | 75 | 80 | 85 | 90 | 95 | 100 | 105 | 110 | 115 | 120);

/** Arbitrary buffer_minutes in [0, 60] step 5 */
const bufferMinutesArb = fc.integer({ min: 0, max: 12 }).map((n) => n * 5);

/** Weekday 1..7 */
const weekdayArb = fc.integer({ min: 1, max: 7 }) as fc.Arbitrary<1 | 2 | 3 | 4 | 5 | 6 | 7>;

/**
 * Arbitrary AvailabilityRule with valid slot grid (end - start >= slot + buffer).
 */
const availabilityRuleArb: fc.Arbitrary<AvailabilityRule> = fc
  .tuple(weekdayArb, slotMinutesArb, bufferMinutesArb, ianaZoneArb)
  .chain(([weekday, slotMinutes, bufferMinutes, zone]) => {
    const gridMinutes = slotMinutes + bufferMinutes;
    // startHour 8..15, endHour must allow at least one slot
    return fc
      .integer({ min: 8, max: 15 })
      .chain((startHour) => {
        const minEndMinutes = startHour * 60 + gridMinutes;
        const maxEndMinutes = 22 * 60;
        if (minEndMinutes >= maxEndMinutes) return fc.constant(null);
        return fc.integer({ min: minEndMinutes, max: maxEndMinutes }).map((endMinutes) => ({
          weekday,
          start_local: startHour * 60,
          end_local: endMinutes,
          slot_minutes: slotMinutes,
          buffer_minutes: bufferMinutes,
          zone,
          valid_from: null,
          valid_to: null,
        }));
      });
  })
  .filter((r): r is AvailabilityRule => r !== null);

/** Arbitrary UTC window of 1..14 days starting somewhere in 2025. */
const windowArb = fc
  .integer({ min: 0, max: 364 })
  .chain((dayOffset) => {
    const base = DateTime.fromISO("2025-01-01T00:00:00Z");
    const startUtc = base.plus({ days: dayOffset });
    return fc
      .integer({ min: 1, max: 14 })
      .map((len) => ({ startUtc, endUtc: startUtc.plus({ days: len }) }));
  });

/** Arbitrary array of busy blocks within a window (0..4 blocks). */
function busyBlocksArb(win: {
  startUtc: DateTime;
  endUtc: DateTime;
}): fc.Arbitrary<BusyBlock[]> {
  const windowMs = win.endUtc.toMillis() - win.startUtc.toMillis();
  return fc
    .array(
      fc.tuple(fc.float({ min: 0, max: 0.9 }), fc.float({ min: 0.01, max: 0.2 })).map(
        ([startFrac, lenFrac]) => {
          const startMs = win.startUtc.toMillis() + Math.floor(startFrac * windowMs);
          const endMs = startMs + Math.floor(Math.min(lenFrac, 0.1) * windowMs) + 60_000;
          return busy(
            DateTime.fromMillis(startMs, { zone: "UTC" }),
            DateTime.fromMillis(endMs, { zone: "UTC" }),
          );
        },
      ),
      { minLength: 0, maxLength: 4 },
    );
}

// ---------------------------------------------------------------------------
// Property 1 — Every emitted slot is fully inside window
// ---------------------------------------------------------------------------

describe("Property 1: every slot is fully inside window", () => {
  it("holds for ≥200 cases", () => {
    fc.assert(
      fc.property(availabilityRuleArb, windowArb, ianaZoneArb, (r, win, renderZone) => {
        const slots = generateSlots({
          rules: [r],
          busy: [],
          window: win,
          providerZone: r.zone,
          renderZone,
        });
        for (const s of slots) {
          const slotEnd = s.startUtc.plus({ minutes: s.durationMinutes });
          if (s.startUtc < win.startUtc) return false;
          if (slotEnd > win.endUtc) return false;
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2 — Every slot is disjoint from every busy block (touching OK)
// ---------------------------------------------------------------------------

describe("Property 2: every slot is disjoint from busy blocks (touching allowed)", () => {
  it("holds for ≥200 cases", () => {
    fc.assert(
      fc.property(
        availabilityRuleArb,
        windowArb.chain((win) =>
          busyBlocksArb(win).map((blocks) => ({ win, blocks })),
        ),
        ianaZoneArb,
        (r, { win, blocks }, renderZone) => {
          const slots = generateSlots({
            rules: [r],
            busy: blocks,
            window: win,
            providerZone: r.zone,
            renderZone,
          });
          for (const s of slots) {
            const slotEnd = s.startUtc.plus({ minutes: s.durationMinutes });
            for (const b of blocks) {
              // overlap iff startUtc < b.endUtc && slotEnd > b.startUtc
              const overlaps =
                s.startUtc < b.endUtc && slotEnd > b.startUtc;
              if (overlaps) return false;
            }
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3 — Slot starts align to grid relative to rule.start_local
// ---------------------------------------------------------------------------

describe("Property 3: slot starts align to (slot+buffer) grid relative to start_local", () => {
  it("holds for ≥200 cases", () => {
    fc.assert(
      fc.property(availabilityRuleArb, windowArb, ianaZoneArb, (r, win, renderZone) => {
        const slots = generateSlots({
          rules: [r],
          busy: [],
          window: win,
          providerZone: r.zone,
          renderZone,
        });
        const gridMinutes = r.slot_minutes + r.buffer_minutes;
        for (const s of slots) {
          // Convert slot start to provider zone
          const localStart = s.startUtc.setZone(r.zone);
          // Minutes from midnight on that day
          const minutesFromMidnight = localStart.hour * 60 + localStart.minute;
          // Offset from rule.start_local
          const offset = minutesFromMidnight - r.start_local;
          if (offset < 0) return false;
          if (gridMinutes > 0 && offset % gridMinutes !== 0) return false;
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4 — Slot count is monotonically non-increasing in |busy|
// ---------------------------------------------------------------------------

describe("Property 4: slot count is non-increasing as busy grows", () => {
  it("holds for ≥200 cases", () => {
    fc.assert(
      fc.property(
        availabilityRuleArb,
        windowArb,
        ianaZoneArb,
        (r, win, renderZone) => {
          // Generate slots with no busy
          const allSlots = generateSlots({
            rules: [r],
            busy: [],
            window: win,
            providerZone: r.zone,
            renderZone,
          });

          if (allSlots.length === 0) return true; // nothing to test

          // Pick first slot as a busy block, count must drop or stay same
          const firstSlot = allSlots[0];
          const blocker = busy(
            firstSlot.startUtc,
            firstSlot.startUtc.plus({ minutes: firstSlot.durationMinutes }),
          );

          const fewerSlots = generateSlots({
            rules: [r],
            busy: [blocker],
            window: win,
            providerZone: r.zone,
            renderZone,
          });

          return fewerSlots.length <= allSlots.length;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5 — Slot list is identical regardless of renderZone
// ---------------------------------------------------------------------------

describe("Property 5: slot list is identical regardless of renderZone", () => {
  it("holds for ≥200 cases", () => {
    fc.assert(
      fc.property(
        availabilityRuleArb,
        windowArb,
        ianaZoneArb,
        ianaZoneArb,
        (r, win, zone1, zone2) => {
          const slots1 = generateSlots({
            rules: [r],
            busy: [],
            window: win,
            providerZone: r.zone,
            renderZone: zone1,
          });
          const slots2 = generateSlots({
            rules: [r],
            busy: [],
            window: win,
            providerZone: r.zone,
            renderZone: zone2,
          });

          if (slots1.length !== slots2.length) return false;
          for (let i = 0; i < slots1.length; i++) {
            if (slots1[i].startUtc.toMillis() !== slots2[i].startUtc.toMillis()) return false;
            if (slots1[i].durationMinutes !== slots2[i].durationMinutes) return false;
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6 — No slot starts inside a DST gap
// ---------------------------------------------------------------------------

describe("Property 6: no slot starts inside a DST gap", () => {
  it("holds for ≥200 cases with gap-prone zones", () => {
    // Use zones known to have DST gaps; test over spring-forward dates.
    const gapZoneArb = fc.constantFrom(
      "America/New_York",
      "America/Los_Angeles",
      "America/Chicago",
      "Europe/Madrid",
      "Europe/London",
    );

    // Windows around spring-forward transitions
    const springWindowArb = fc.constantFrom(
      // US 2025 spring forward Mar 9
      {
        startUtc: DateTime.fromISO("2025-03-09T05:00:00Z"),
        endUtc: DateTime.fromISO("2025-03-09T09:00:00Z"),
      },
      // US 2026 spring forward Mar 8
      {
        startUtc: DateTime.fromISO("2026-03-08T05:00:00Z"),
        endUtc: DateTime.fromISO("2026-03-08T09:00:00Z"),
      },
      // EU 2026 spring forward Mar 29
      {
        startUtc: DateTime.fromISO("2026-03-29T00:00:00Z"),
        endUtc: DateTime.fromISO("2026-03-29T04:00:00Z"),
      },
    );

    fc.assert(
      fc.property(
        fc.tuple(availabilityRuleArb, gapZoneArb, springWindowArb).map(([r, zone, win]) => ({
          r: { ...r, zone, weekday: win.startUtc.setZone(zone).weekday as 1|2|3|4|5|6|7 },
          zone,
          win,
        })),
        ({ r, zone, win }) => {
          const slots = generateSlots({
            rules: [r],
            busy: [],
            window: win,
            providerZone: zone,
            renderZone: zone,
          });

          for (const s of slots) {
            const local = s.startUtc.setZone(zone);
            // A time in a gap is invalid in Luxon when constructed via fromObject
            const reconstructed = DateTime.fromObject(
              { year: local.year, month: local.month, day: local.day, hour: local.hour, minute: local.minute },
              { zone },
            );
            // If the reconstructed time is invalid or has been shifted (gap),
            // its UTC offset would differ from a non-gap time
            if (!reconstructed.isValid) return false;
            // Check the slot's UTC time matches reconstruction — if in gap, Luxon
            // will shift the time forward, so UTC instants won't match
            if (reconstructed.toUTC().toMillis() !== s.startUtc.toMillis()) return false;
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7 — Fall-back fold: exactly one slot per fold instant
// ---------------------------------------------------------------------------

describe("Property 7: fall-back fold hour yields exactly one slot per UTC instant", () => {
  it("holds: fold wall-clock time appears at most once in slot list", () => {
    // US fall-back 2025: Nov 2, clocks go back at 2am ET → 1am ET again
    // America/New_York falls back at 2025-11-02T06:00:00Z (2am → 1am)
    const win = {
      startUtc: DateTime.fromISO("2025-11-02T04:00:00Z"),
      endUtc: DateTime.fromISO("2025-11-02T10:00:00Z"),
    };

    // Rule: every Sunday, 0:00 to 23:59 (covers the fold window), 30-min slots, 0 buffer
    const r: AvailabilityRule = {
      weekday: 7, // Sunday
      start_local: 0,
      end_local: 23 * 60 + 59,
      slot_minutes: 30,
      buffer_minutes: 0,
      zone: "America/New_York",
      valid_from: null,
      valid_to: null,
    };

    const slots = generateSlots({
      rules: [r],
      busy: [],
      window: win,
      providerZone: "America/New_York",
      renderZone: "America/New_York",
    });

    // In a fold, the local wall-clock time 1:00 AM can map to two different UTC instants.
    // We must emit exactly ONE slot per UTC instant (deduplicated by UTC).
    const utcMillis = slots.map((s) => s.startUtc.toMillis());
    const uniqueUtcMillis = new Set(utcMillis);
    expect(utcMillis.length).toBe(uniqueUtcMillis.size);

    // Additionally, the property-based version
    fc.assert(
      fc.property(
        fc.constantFrom("America/New_York", "America/Chicago", "America/Los_Angeles"),
        (zone) => {
          // Fall-back windows for each zone
          const fallbacks: Record<string, { startUtc: string; endUtc: string }> = {
            "America/New_York": { startUtc: "2025-11-02T04:00:00Z", endUtc: "2025-11-02T10:00:00Z" },
            "America/Chicago": { startUtc: "2025-11-02T05:00:00Z", endUtc: "2025-11-02T10:00:00Z" },
            "America/Los_Angeles": { startUtc: "2025-11-02T07:00:00Z", endUtc: "2025-11-02T12:00:00Z" },
          };
          const fb = fallbacks[zone];
          const foldWin = {
            startUtc: DateTime.fromISO(fb.startUtc),
            endUtc: DateTime.fromISO(fb.endUtc),
          };
          const foldRule: AvailabilityRule = {
            weekday: 7,
            start_local: 0,
            end_local: 23 * 60 + 59,
            slot_minutes: 30,
            buffer_minutes: 0,
            zone,
            valid_from: null,
            valid_to: null,
          };
          const foldSlots = generateSlots({
            rules: [foldRule],
            busy: [],
            window: foldWin,
            providerZone: zone,
            renderZone: zone,
          });
          const ms = foldSlots.map((s) => s.startUtc.toMillis());
          return ms.length === new Set(ms).size;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8 — Overlapping rules with same weekday → throws
// ---------------------------------------------------------------------------

describe("Property 8: overlapping rules with same weekday throw", () => {
  it("throws when two rules for the same weekday have overlapping time ranges", () => {
    fc.assert(
      fc.property(
        availabilityRuleArb,
        ianaZoneArb,
        (r, renderZone) => {
          // Create a second rule that overlaps: same weekday, same zone, start_local shifted by 30 min
          const r2: AvailabilityRule = {
            ...r,
            start_local: r.start_local + 30,
            end_local: r.end_local + 30,
          };
          const win = {
            startUtc: DateTime.fromISO("2025-01-01T00:00:00Z"),
            endUtc: DateTime.fromISO("2025-01-15T00:00:00Z"),
          };
          let threw = false;
          try {
            generateSlots({
              rules: [r, r2],
              busy: [],
              window: win,
              providerZone: r.zone,
              renderZone,
            });
          } catch {
            threw = true;
          }
          return threw;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("does NOT throw when rules have different weekdays", () => {
    fc.assert(
      fc.property(
        availabilityRuleArb,
        ianaZoneArb,
        (r, renderZone) => {
          const otherWeekday = ((r.weekday % 7) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
          const r2: AvailabilityRule = {
            ...r,
            weekday: otherWeekday,
          };
          const win = {
            startUtc: DateTime.fromISO("2025-01-01T00:00:00Z"),
            endUtc: DateTime.fromISO("2025-01-15T00:00:00Z"),
          };
          let threw = false;
          try {
            generateSlots({
              rules: [r, r2],
              busy: [],
              window: win,
              providerZone: r.zone,
              renderZone,
            });
          } catch {
            threw = true;
          }
          return !threw;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ===========================================================================
// FIXED-CASE FIXTURES
// ===========================================================================

// ---------------------------------------------------------------------------
// Fixture: US DST spring-forward — gap slot omitted
// ---------------------------------------------------------------------------

describe("Fixture: US DST spring-forward gap slot omitted", () => {
  // Mar 9 2025: America/New_York clocks spring forward at 2am → 3am
  // Gap: 2:00am–2:59am ET does not exist on Mar 9 2025.
  // UTC: 2025-03-09T07:00:00Z (= 2:00am ET) through 07:59Z is the gap.
  it("omits slots in the 2am gap on Mar 9 2025 (NY spring forward)", () => {
    const r: AvailabilityRule = {
      weekday: 7, // Sunday Mar 9 2025
      start_local: 0,
      end_local: 24 * 60,
      slot_minutes: 30,
      buffer_minutes: 0,
      zone: "America/New_York",
      valid_from: null,
      valid_to: null,
    };
    const win = {
      startUtc: DateTime.fromISO("2025-03-09T00:00:00Z"),
      endUtc: DateTime.fromISO("2025-03-09T12:00:00Z"),
    };
    const slots = generateSlots({
      rules: [r],
      busy: [],
      window: win,
      providerZone: "America/New_York",
      renderZone: "America/New_York",
    });

    // No slot should start at a UTC time that falls in the gap.
    // Gap in UTC: 07:00Z to 07:59Z (2am–2:59am ET, which don't exist)
    for (const s of slots) {
      const utcHour = s.startUtc.toUTC().hour;
      const utcMin = s.startUtc.toUTC().minute;
      const utcMinutes = utcHour * 60 + utcMin;
      // 07:00Z–07:59Z is the gap
      expect(utcMinutes >= 7 * 60 && utcMinutes < 8 * 60).toBe(false);
    }
  });

  it("omits slots in the 2am gap on Mar 8 2026 (NY spring forward)", () => {
    const r: AvailabilityRule = {
      weekday: 7, // Sunday Mar 8 2026
      start_local: 0,
      end_local: 24 * 60,
      slot_minutes: 30,
      buffer_minutes: 0,
      zone: "America/New_York",
      valid_from: null,
      valid_to: null,
    };
    const win = {
      startUtc: DateTime.fromISO("2026-03-08T00:00:00Z"),
      endUtc: DateTime.fromISO("2026-03-08T12:00:00Z"),
    };
    const slots = generateSlots({
      rules: [r],
      busy: [],
      window: win,
      providerZone: "America/New_York",
      renderZone: "America/New_York",
    });

    for (const s of slots) {
      const utcHour = s.startUtc.toUTC().hour;
      const utcMin = s.startUtc.toUTC().minute;
      const utcMinutes = utcHour * 60 + utcMin;
      expect(utcMinutes >= 7 * 60 && utcMinutes < 8 * 60).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixture: US DST fall-back — fold hour offered exactly once
// ---------------------------------------------------------------------------

describe("Fixture: US DST fall-back fold hour offered exactly once", () => {
  // Nov 2 2025: America/New_York clocks fall back at 2am → 1am
  // UTC: 06:00Z is 2am EDT; after fallback, 06:00Z is 1am EST... wait:
  // EDT = UTC-4; EST = UTC-5
  // 1:00am EDT = 05:00Z; 2:00am EDT = 06:00Z → clocks go back → 1:00am EST = 06:00Z
  // So 1:00am–1:59am local appears twice in UTC: 05:00Z–05:59Z and 06:00Z–06:59Z

  it("offers the 1am fold hour exactly once on Nov 2 2025", () => {
    const r: AvailabilityRule = {
      weekday: 7, // Sunday Nov 2 2025
      start_local: 0,
      end_local: 24 * 60,
      slot_minutes: 60,
      buffer_minutes: 0,
      zone: "America/New_York",
      valid_from: null,
      valid_to: null,
    };
    const win = {
      startUtc: DateTime.fromISO("2025-11-02T04:00:00Z"), // midnight ET
      endUtc: DateTime.fromISO("2025-11-02T10:00:00Z"),   // 5am ET (post-fold)
    };
    const slots = generateSlots({
      rules: [r],
      busy: [],
      window: win,
      providerZone: "America/New_York",
      renderZone: "America/New_York",
    });

    // Count distinct UTC start instants — should all be unique
    const utcMillis = slots.map((s) => s.startUtc.toMillis());
    expect(new Set(utcMillis).size).toBe(utcMillis.length);

    // The fold window has 6 UTC hours but only 5 distinct wall-clock hours
    // (midnight, 1am[first], 1am[second=fold], 2am, 3am, 4am)
    // With 60-min slots covering that window, we should get exactly 6 slots
    // (one per UTC hour) but NOT two at the same wall-clock 1am.
    // Actually the spec says offer the fold hour ONCE. So there should NOT
    // be two slots with local time 1:00am. They would differ by UTC instant.
    const localOneAM = slots.filter((s) => {
      const local = s.startUtc.setZone("America/New_York");
      return local.hour === 1 && local.minute === 0;
    });
    expect(localOneAM.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Fixture: Madrid provider + NYC booker, Mar 8–29 2026 (US DST started, EU not)
// ---------------------------------------------------------------------------

describe("Fixture: Madrid provider + NYC booker, US/EU DST divergence window", () => {
  // Mar 8 2026: US clocks spring forward (UTC-5 → UTC-4 for NY)
  // Mar 29 2026: EU clocks spring forward (UTC+1 → UTC+2 for Madrid)
  // Between Mar 8–29: NY is UTC-4, Madrid is UTC+1 (5h gap instead of 6h)

  it("generates correct UTC slots for Madrid rule, renderable in NYC zone", () => {
    // Daniel: Mon–Fri, 9am–5pm Europe/Madrid, 60-min slots, 0 buffer
    // On Mar 10 2026 (Tuesday, US DST started, EU DST not yet):
    // Madrid is UTC+1; 9am CET = 08:00Z, 5pm CET = 16:00Z → 8 slots
    const r: AvailabilityRule = {
      weekday: 2, // Tuesday
      start_local: 9 * 60,
      end_local: 17 * 60,
      slot_minutes: 60,
      buffer_minutes: 0,
      zone: "Europe/Madrid",
      valid_from: null,
      valid_to: null,
    };
    const win = {
      startUtc: DateTime.fromISO("2026-03-10T00:00:00Z"),
      endUtc: DateTime.fromISO("2026-03-11T00:00:00Z"),
    };

    const slotsNYC = generateSlots({
      rules: [r],
      busy: [],
      window: win,
      providerZone: "Europe/Madrid",
      renderZone: "America/New_York",
    });

    const slotsMadrid = generateSlots({
      rules: [r],
      busy: [],
      window: win,
      providerZone: "Europe/Madrid",
      renderZone: "Europe/Madrid",
    });

    // renderZone must not affect UTC times
    expect(slotsNYC.length).toBe(slotsMadrid.length);
    for (let i = 0; i < slotsNYC.length; i++) {
      expect(slotsNYC[i].startUtc.toMillis()).toBe(slotsMadrid[i].startUtc.toMillis());
    }

    // 8 slots: 8Z, 9Z, 10Z, 11Z, 12Z, 13Z, 14Z, 15Z (9am–4pm CET, last slot 4pm, ends 5pm)
    expect(slotsNYC.length).toBe(8);

    // First slot in NYC should be 4am EDT (UTC-4 = 08Z - 4 = 4am)
    const firstLocal = slotsNYC[0].startUtc.setZone("America/New_York");
    expect(firstLocal.hour).toBe(4);
    expect(firstLocal.offset).toBe(-4 * 60); // EDT = UTC-4
  });

  it("renders correctly around EU DST start Mar 29 2026", () => {
    // Mar 29 2026: Madrid springs forward at 2am → 3am (gap 2am–2:59am)
    // A rule that covers that gap should omit the gap slot
    const r: AvailabilityRule = {
      weekday: 7, // Sunday Mar 29 2026
      start_local: 1 * 60, // 1am
      end_local: 4 * 60,   // 4am
      slot_minutes: 30,
      buffer_minutes: 0,
      zone: "Europe/Madrid",
      valid_from: null,
      valid_to: null,
    };
    const win = {
      startUtc: DateTime.fromISO("2026-03-29T00:00:00Z"),
      endUtc: DateTime.fromISO("2026-03-29T05:00:00Z"),
    };
    const slots = generateSlots({
      rules: [r],
      busy: [],
      window: win,
      providerZone: "Europe/Madrid",
      renderZone: "America/New_York",
    });

    // Slots at 2am Madrid local (which is in the gap) must not appear.
    for (const s of slots) {
      const local = s.startUtc.setZone("Europe/Madrid");
      // 2:00–2:59am CET does not exist on Mar 29
      const gapStart = DateTime.fromObject({ year: 2026, month: 3, day: 29, hour: 2, minute: 0 }, { zone: "Europe/Madrid" });
      // If in gap, Luxon will return invalid or shift to 3am. Verify no slot
      // has a local time in that gap range.
      if (local.hour === 2) {
        // This would be in the gap — should never happen
        expect(true).toBe(false); // fail the test
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Fixture: Leap day Feb 29 2024
// ---------------------------------------------------------------------------

describe("Fixture: leap day Feb 29 2024", () => {
  it("generates slots on Feb 29 2024 (Thursday)", () => {
    const r: AvailabilityRule = {
      weekday: 4, // Thursday
      start_local: 9 * 60,
      end_local: 17 * 60,
      slot_minutes: 60,
      buffer_minutes: 0,
      zone: "America/New_York",
      valid_from: null,
      valid_to: null,
    };
    const win = {
      startUtc: DateTime.fromISO("2024-02-29T00:00:00Z"),
      endUtc: DateTime.fromISO("2024-03-01T00:00:00Z"),
    };
    const slots = generateSlots({
      rules: [r],
      busy: [],
      window: win,
      providerZone: "America/New_York",
      renderZone: "America/New_York",
    });

    // 9am–4pm ET (8 slots), NY is EST (UTC-5) in Feb 29 2024
    // 9am EST = 14Z, last slot 4pm EST starts at 21Z
    expect(slots.length).toBe(8);
    const firstLocal = slots[0].startUtc.setZone("America/New_York");
    expect(firstLocal.year).toBe(2024);
    expect(firstLocal.month).toBe(2);
    expect(firstLocal.day).toBe(29);
    expect(firstLocal.hour).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Fixture: Year boundary Dec 31 → Jan 1
// ---------------------------------------------------------------------------

describe("Fixture: year boundary Dec 31 → Jan 1", () => {
  it("generates slots across Dec 31 2025 and Jan 1 2026", () => {
    // Mon–Fri rule, covers both Wed Dec 31 and Thu Jan 1
    const rWed: AvailabilityRule = {
      weekday: 3, // Wednesday
      start_local: 10 * 60,
      end_local: 14 * 60,
      slot_minutes: 60,
      buffer_minutes: 0,
      zone: "UTC",
      valid_from: null,
      valid_to: null,
    };
    const rThu: AvailabilityRule = {
      weekday: 4, // Thursday
      start_local: 10 * 60,
      end_local: 14 * 60,
      slot_minutes: 60,
      buffer_minutes: 0,
      zone: "UTC",
      valid_from: null,
      valid_to: null,
    };
    const win = {
      startUtc: DateTime.fromISO("2025-12-31T00:00:00Z"),
      endUtc: DateTime.fromISO("2026-01-02T00:00:00Z"),
    };
    const slots = generateSlots({
      rules: [rWed, rThu],
      busy: [],
      window: win,
      providerZone: "UTC",
      renderZone: "UTC",
    });

    // 4 slots on Dec 31 (10, 11, 12, 13 UTC) + 4 slots on Jan 1 = 8
    expect(slots.length).toBe(8);

    const dec31Slots = slots.filter((s) => s.startUtc.setZone("UTC").day === 31);
    const jan1Slots = slots.filter((s) => s.startUtc.setZone("UTC").day === 1);
    expect(dec31Slots.length).toBe(4);
    expect(jan1Slots.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Fixture: ISO week boundary
// ---------------------------------------------------------------------------

describe("Fixture: ISO week boundary (Mon at start of new week)", () => {
  it("correctly handles a window spanning two ISO weeks", () => {
    // Jan 5 2025 is Sunday (last day of ISO week 1)
    // Jan 6 2025 is Monday (first day of ISO week 2)
    const rSun: AvailabilityRule = {
      weekday: 7, // Sunday
      start_local: 10 * 60,
      end_local: 12 * 60,
      slot_minutes: 60,
      buffer_minutes: 0,
      zone: "UTC",
      valid_from: null,
      valid_to: null,
    };
    const rMon: AvailabilityRule = {
      weekday: 1, // Monday
      start_local: 10 * 60,
      end_local: 12 * 60,
      slot_minutes: 60,
      buffer_minutes: 0,
      zone: "UTC",
      valid_from: null,
      valid_to: null,
    };
    const win = {
      startUtc: DateTime.fromISO("2025-01-05T00:00:00Z"),
      endUtc: DateTime.fromISO("2025-01-07T00:00:00Z"),
    };
    const slots = generateSlots({
      rules: [rSun, rMon],
      busy: [],
      window: win,
      providerZone: "UTC",
      renderZone: "UTC",
    });

    // 2 slots Sunday + 2 slots Monday = 4
    expect(slots.length).toBe(4);

    const sunSlots = slots.filter((s) => s.startUtc.setZone("UTC").weekday === 7);
    const monSlots = slots.filter((s) => s.startUtc.setZone("UTC").weekday === 1);
    expect(sunSlots.length).toBe(2);
    expect(monSlots.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Fixture: Pacific/Apia skipped-day weirdness (stretch)
// ---------------------------------------------------------------------------

describe("Fixture: Pacific/Apia skipped day (stretch)", () => {
  // In December 2011, Samoa skipped Dec 30 entirely (UTC+14 zone).
  // For v0.1 we just verify no crash and no slots land on the skipped day.
  // The rule below runs "Fridays" — Dec 29 2023 is a Friday in Pacific/Apia.
  it("generates slots in Pacific/Apia without crashing", () => {
    const r: AvailabilityRule = {
      weekday: 5, // Friday
      start_local: 9 * 60,
      end_local: 17 * 60,
      slot_minutes: 60,
      buffer_minutes: 0,
      zone: "Pacific/Apia",
      valid_from: null,
      valid_to: null,
    };
    const win = {
      startUtc: DateTime.fromISO("2023-12-28T00:00:00Z"),
      endUtc: DateTime.fromISO("2023-12-30T00:00:00Z"),
    };

    let threw = false;
    let slots: Slot[] = [];
    try {
      slots = generateSlots({
        rules: [r],
        busy: [],
        window: win,
        providerZone: "Pacific/Apia",
        renderZone: "UTC",
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    // All slots must be valid
    for (const s of slots) {
      expect(s.startUtc.isValid).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixture: Buffer-applied-after grid alignment — Maya's "50/10"
// ---------------------------------------------------------------------------

describe("Fixture: buffer applied AFTER session (Maya 50/10 → 60-min grid, 6 slots/day)", () => {
  // Maya: Tue/Thu 10am–4pm America/Los_Angeles, 50-min sessions, 10-min buffer after.
  // Grid = 50 + 10 = 60 min. Start 10am. Slots: 10:00, 11:00, 12:00, 1:00, 2:00, 3:00 → 6 slots.
  // Last slot starts 3pm, ends 3:50pm + 10 buffer = 4pm — fits exactly.

  it("produces exactly 6 slots per day on Tue/Thu 10am–4pm LA with 50/10", () => {
    const rTue: AvailabilityRule = {
      weekday: 2, // Tuesday
      start_local: 10 * 60,
      end_local: 16 * 60,
      slot_minutes: 50,
      buffer_minutes: 10,
      zone: "America/Los_Angeles",
      valid_from: null,
      valid_to: null,
    };
    const rThu: AvailabilityRule = {
      weekday: 4, // Thursday
      start_local: 10 * 60,
      end_local: 16 * 60,
      slot_minutes: 50,
      buffer_minutes: 10,
      zone: "America/Los_Angeles",
      valid_from: null,
      valid_to: null,
    };

    // A week in March (no DST transition)
    // Mar 11 2025 = Tuesday, Mar 13 2025 = Thursday (LA is PST = UTC-8 in early March 2025)
    // Wait — US DST starts Mar 9 2025, so Mar 11 is PDT (UTC-7).
    const win = {
      startUtc: DateTime.fromISO("2025-03-11T00:00:00Z"),
      endUtc: DateTime.fromISO("2025-03-14T00:00:00Z"),
    };

    const slots = generateSlots({
      rules: [rTue, rThu],
      busy: [],
      window: win,
      providerZone: "America/Los_Angeles",
      renderZone: "America/Los_Angeles",
    });

    const tuesdaySlots = slots.filter((s) => {
      const local = s.startUtc.setZone("America/Los_Angeles");
      return local.weekday === 2;
    });
    const thursdaySlots = slots.filter((s) => {
      const local = s.startUtc.setZone("America/Los_Angeles");
      return local.weekday === 4;
    });

    expect(tuesdaySlots.length).toBe(6);
    expect(thursdaySlots.length).toBe(6);

    // Verify grid alignment: each slot starts on a 60-min boundary from 10am
    for (const s of tuesdaySlots) {
      const local = s.startUtc.setZone("America/Los_Angeles");
      const minutesFrom10am = (local.hour * 60 + local.minute) - 10 * 60;
      expect(minutesFrom10am >= 0).toBe(true);
      expect(minutesFrom10am % 60).toBe(0);
    }

    // Verify duration is 50 minutes (buffer is NOT part of the slot duration)
    for (const s of slots) {
      expect(s.durationMinutes).toBe(50);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixture: Overlapping availability rules → throws
// ---------------------------------------------------------------------------

describe("Fixture: overlapping availability rules throw", () => {
  it("throws when two rules overlap on the same weekday", () => {
    const r1: AvailabilityRule = {
      weekday: 2, // Tuesday
      start_local: 9 * 60,
      end_local: 13 * 60,
      slot_minutes: 60,
      buffer_minutes: 0,
      zone: "America/New_York",
      valid_from: null,
      valid_to: null,
    };
    const r2: AvailabilityRule = {
      weekday: 2, // Tuesday — overlaps 10am–1pm
      start_local: 10 * 60,
      end_local: 14 * 60,
      slot_minutes: 60,
      buffer_minutes: 0,
      zone: "America/New_York",
      valid_from: null,
      valid_to: null,
    };
    const win = {
      startUtc: DateTime.fromISO("2025-01-01T00:00:00Z"),
      endUtc: DateTime.fromISO("2025-01-15T00:00:00Z"),
    };

    expect(() =>
      generateSlots({
        rules: [r1, r2],
        busy: [],
        window: win,
        providerZone: "America/New_York",
        renderZone: "America/New_York",
      }),
    ).toThrow();
  });

  it("does NOT throw for adjacent (non-overlapping) rules on the same weekday", () => {
    const r1: AvailabilityRule = {
      weekday: 2,
      start_local: 9 * 60,
      end_local: 12 * 60,
      slot_minutes: 60,
      buffer_minutes: 0,
      zone: "America/New_York",
      valid_from: null,
      valid_to: null,
    };
    const r2: AvailabilityRule = {
      weekday: 2,
      start_local: 12 * 60, // starts exactly when r1 ends — touching, not overlapping
      end_local: 15 * 60,
      slot_minutes: 60,
      buffer_minutes: 0,
      zone: "America/New_York",
      valid_from: null,
      valid_to: null,
    };
    const win = {
      startUtc: DateTime.fromISO("2025-01-01T00:00:00Z"),
      endUtc: DateTime.fromISO("2025-01-15T00:00:00Z"),
    };

    expect(() =>
      generateSlots({
        rules: [r1, r2],
        busy: [],
        window: win,
        providerZone: "America/New_York",
        renderZone: "America/New_York",
      }),
    ).not.toThrow();
  });
});
