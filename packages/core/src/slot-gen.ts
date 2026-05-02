/**
 * slot-gen.ts — pure slot-generation function for Calendry.
 *
 * Generates bookable time slots from availability rules, minus busy blocks,
 * within a UTC window. Uses Luxon for all timezone math.
 *
 * NO I/O. NO Date.now(). Pure function.
 *
 * @module slot-gen
 */

import { DateTime } from "luxon";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AvailabilityRule {
  /** ISO weekday 1=Monday … 7=Sunday */
  weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** Minutes from midnight (local) when availability starts, e.g. 600 = 10am */
  start_local: number;
  /** Minutes from midnight (local) when availability ends, e.g. 960 = 4pm */
  end_local: number;
  /** Session length in minutes */
  slot_minutes: number;
  /**
   * Buffer applied AFTER session only.
   * why: v0.1 decision — pre-buffer rejected for rule-model simplicity;
   * grid = slot_minutes + buffer_minutes. Revisit in v0.2 if requested.
   */
  buffer_minutes: number;
  /** IANA timezone for this rule (provider's home zone). */
  zone: string;
  /** Optional date bounds (inclusive) in the provider's zone. */
  valid_from: DateTime | null;
  valid_to: DateTime | null;
}

export interface BusyBlock {
  startUtc: DateTime;
  endUtc: DateTime;
}

export interface Slot {
  startUtc: DateTime;
  durationMinutes: number;
  /** Provider's IANA zone — stored for email rendering; never affects UTC. */
  providerZone: string;
}

// ---------------------------------------------------------------------------
// generateSlots
// ---------------------------------------------------------------------------

/**
 * Generate available time slots.
 *
 * @param args.rules     Availability rules. Two rules that overlap on the same
 *                       weekday cause a throw (no silent merge — per SPEC
 *                       §Availability rule semantics).
 * @param args.busy      Busy blocks to exclude from output.
 * @param args.window    UTC window to constrain output.
 * @param args.providerZone  IANA zone used to expand recurrence rules.
 * @param args.renderZone    Cosmetic only — ignored in UTC math.
 */
export function generateSlots(args: {
  rules: AvailabilityRule[];
  busy: BusyBlock[];
  window: { startUtc: DateTime; endUtc: DateTime };
  providerZone: string;
  renderZone: string; // why: cosmetic only — caller may render in any zone
}): Slot[] {
  const { rules, busy, window: win, providerZone } = args;

  // --- 1. Reject overlapping rules on the same weekday ----------------------
  validateRules(rules);

  // --- 2. Walk each calendar day in the window (in the provider's zone) -----
  const slots: Slot[] = [];

  // Iterate day by day from the start of the window to the end.
  // We advance by calendar date in the providerZone to correctly handle DST.
  let dayStart = win.startUtc.setZone(providerZone).startOf("day");
  const windowEnd = win.endUtc;

  while (dayStart.toUTC() < windowEnd) {
    const dayWeekday = dayStart.weekday as 1 | 2 | 3 | 4 | 5 | 6 | 7;

    for (const rule of rules) {
      if (rule.weekday !== dayWeekday) continue;

      // Check valid_from / valid_to date bounds
      if (rule.valid_from !== null && dayStart < rule.valid_from.startOf("day")) continue;
      if (rule.valid_to !== null && dayStart > rule.valid_to.endOf("day")) continue;

      const gridMinutes = rule.slot_minutes + rule.buffer_minutes;
      const slotsForDay = expandRuleOnDay(rule, dayStart, gridMinutes, win, providerZone);
      slots.push(...slotsForDay);
    }

    dayStart = dayStart.plus({ days: 1 });
  }

  // --- 3. Filter out busy-colliding slots ------------------------------------
  return slots.filter((slot) => !collidesWithBusy(slot, busy));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Expand a single availability rule on a single calendar day in the provider
 * zone. Returns candidate slots that:
 *   - start within [window.startUtc, window.endUtc)
 *   - are not in a DST gap
 *   - are deduplicated across a fall-back fold (emit UTC-earliest occurrence)
 */
function expandRuleOnDay(
  rule: AvailabilityRule,
  dayInZone: DateTime, // start-of-day in providerZone
  gridMinutes: number,
  win: { startUtc: DateTime; endUtc: DateTime },
  providerZone: string,
): Slot[] {
  const slots: Slot[] = [];

  // Seen UTC millis — guards against emitting a fold instant twice.
  // why: during a fall-back fold a wall-clock time maps to two UTC instants.
  // We emit the FIRST UTC instant (pre-fold, the "earlier" one).
  // Luxon's DateTime.fromObject in an ambiguous fold zone returns the
  // pre-fold instant by default (keepLocalTime behaviour).
  const seenUtcMillis = new Set<number>();

  let offsetMinutes = rule.start_local;
  while (offsetMinutes + rule.slot_minutes <= rule.end_local) {
    const candidateLocal = buildLocalDateTime(dayInZone, offsetMinutes, providerZone);

    if (candidateLocal !== null) {
      const candidateUtc = candidateLocal.toUTC();
      const slotEndUtc = candidateUtc.plus({ minutes: rule.slot_minutes });

      // Must be fully inside the window
      if (
        candidateUtc >= win.startUtc &&
        slotEndUtc <= win.endUtc &&
        !seenUtcMillis.has(candidateUtc.toMillis())
      ) {
        seenUtcMillis.add(candidateUtc.toMillis());
        slots.push({
          startUtc: candidateUtc,
          durationMinutes: rule.slot_minutes,
          providerZone,
        });
      }
    }

    offsetMinutes += gridMinutes;
  }

  return slots;
}

/**
 * Build a DateTime in the provider zone for a given day + minutes-from-midnight.
 * Returns null if the resulting local time falls in a DST gap (invalid time).
 *
 * DST gap detection: construct via fromObject, then verify the UTC round-trip
 * matches. If Luxon shifted the time (gap), the UTC round-trip will differ.
 *
 * why: Luxon's DateTime.fromObject in a gap zone does not return isValid=false;
 * instead it advances the clock past the gap. We detect this by comparing the
 * re-converted local time to the original requested local time.
 */
function buildLocalDateTime(
  dayStart: DateTime,
  minutesFromMidnight: number,
  zone: string,
): DateTime | null {
  const hour = Math.floor(minutesFromMidnight / 60);
  const minute = minutesFromMidnight % 60;

  const candidate = DateTime.fromObject(
    {
      year: dayStart.year,
      month: dayStart.month,
      day: dayStart.day,
      hour,
      minute,
      second: 0,
      millisecond: 0,
    },
    { zone },
  );

  if (!candidate.isValid) return null;

  // DST gap check: if Luxon shifted the time forward out of the gap,
  // the local hour/minute will differ from what we requested.
  if (candidate.hour !== hour || candidate.minute !== minute) {
    // Time was in a DST gap — Luxon advanced it; we omit this slot.
    return null;
  }

  return candidate;
}

/**
 * Validate that no two rules overlap on the same weekday.
 * Two rules overlap if their time ranges intersect (touching is allowed)
 * AND their valid_from/valid_to date ranges intersect.
 *
 * why: SPEC §Availability rule semantics — overlapping windows for the same
 * weekday are rejected to avoid silent ambiguity. Adjacent rules (touching)
 * are permitted. Rules whose date ranges are disjoint can share a weekday
 * with overlapping time windows (e.g. "normal Tuesdays 10–4 except July
 * when 12–4" uses valid_to=Jun 30 + valid_from=Jul 1).
 *
 * Null/undefined valid_from is treated as -infinity; null/undefined valid_to
 * as +infinity. A rule without both bounds is effective for all dates.
 */
function validateRules(rules: AvailabilityRule[]): void {
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i];
      const b = rules[j];
      if (a.weekday !== b.weekday) continue;

      // Short-circuit: if the date ranges do not intersect, these two rules
      // can never be active on the same calendar day — no conflict possible.
      // Date range overlap: a.valid_from <= b.valid_to AND b.valid_from <= a.valid_to
      // Null valid_from = -infinity; null valid_to = +infinity.
      const aFrom = a.valid_from ?? null;
      const aTo = a.valid_to ?? null;
      const bFrom = b.valid_from ?? null;
      const bTo = b.valid_to ?? null;

      // a's range ends before b's range starts → disjoint
      if (aTo !== null && bFrom !== null && aTo < bFrom) continue;
      // b's range ends before a's range starts → disjoint
      if (bTo !== null && aFrom !== null && bTo < aFrom) continue;

      // Date ranges intersect — now check time overlap.
      // Overlap iff a.start_local < b.end_local AND b.start_local < a.end_local
      // (strict inequalities — touching endpoints are allowed)
      if (a.start_local < b.end_local && b.start_local < a.end_local) {
        throw new Error(
          `Overlapping availability rules for weekday ${a.weekday}: ` +
            `rule A [${a.start_local}–${a.end_local}] overlaps ` +
            `rule B [${b.start_local}–${b.end_local}]`,
        );
      }
    }
  }
}

/**
 * Returns true if the slot overlaps (not merely touches) any busy block.
 *
 * Overlap condition: slot.start < busy.end AND slot.end > busy.start
 * Touching (slot.end == busy.start, or slot.start == busy.end) is NOT overlap.
 */
function collidesWithBusy(slot: Slot, busy: BusyBlock[]): boolean {
  const slotEnd = slot.startUtc.plus({ minutes: slot.durationMinutes });
  for (const b of busy) {
    if (slot.startUtc < b.endUtc && slotEnd > b.startUtc) {
      return true;
    }
  }
  return false;
}
