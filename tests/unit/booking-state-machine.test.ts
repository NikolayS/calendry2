/**
 * booking-state-machine.test.ts
 *
 * TDD: red/green for the booking state machine.
 * Per SPEC §Tests Plan / §Booking state machine — every transition
 * exhaustively, every illegal transition asserted to throw.
 *
 * Run: bun test tests/unit/booking-state-machine.test.ts
 */

import { describe, expect, it } from "bun:test";
import { isTerminal, transition } from "../../packages/core/src/booking-state-machine";
import type { BookingState } from "../../packages/core/src/types";

// ---------------------------------------------------------------------------
// Legal transitions
// ---------------------------------------------------------------------------

describe("legal transitions", () => {
  it("pending_push → confirmed (system)", () => {
    const t = transition("pending_push", "confirmed", "system");
    expect(t.from).toBe("pending_push");
    expect(t.to).toBe("confirmed");
    expect(t.actor).toBe("system");
  });

  it("pending_push → conflicted (system)", () => {
    const t = transition("pending_push", "conflicted", "system");
    expect(t.to).toBe("conflicted");
  });

  it("confirmed → cancelled (booker)", () => {
    const t = transition("confirmed", "cancelled", "booker");
    expect(t.to).toBe("cancelled");
  });

  it("confirmed → cancelled (provider)", () => {
    const t = transition("confirmed", "cancelled", "provider");
    expect(t.to).toBe("cancelled");
  });

  it("confirmed → rescheduled (booker)", () => {
    const t = transition("confirmed", "rescheduled", "booker");
    expect(t.to).toBe("rescheduled");
  });

  it("confirmed → conflicted (system — external Google change)", () => {
    const t = transition("confirmed", "conflicted", "system");
    expect(t.to).toBe("conflicted");
  });

  it("conflicted → cancelled (booker)", () => {
    const t = transition("conflicted", "cancelled", "booker");
    expect(t.to).toBe("cancelled");
  });

  it("conflicted → cancelled (provider)", () => {
    const t = transition("conflicted", "cancelled", "provider");
    expect(t.to).toBe("cancelled");
  });

  it("conflicted → rescheduled (provider)", () => {
    const t = transition("conflicted", "rescheduled", "provider");
    expect(t.to).toBe("rescheduled");
  });

  it("records the actor and timestamp", () => {
    const before = new Date();
    const t = transition("pending_push", "confirmed", "system");
    const after = new Date();
    expect(t.at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(t.at.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("accepts an explicit timestamp", () => {
    const at = new Date("2026-01-01T00:00:00Z");
    const t = transition("confirmed", "cancelled", "provider", at);
    expect(t.at).toBe(at);
  });
});

// ---------------------------------------------------------------------------
// Illegal transitions — must throw
// ---------------------------------------------------------------------------

const ILLEGAL: Array<[BookingState, BookingState]> = [
  ["cancelled", "confirmed"],
  ["cancelled", "rescheduled"],
  ["cancelled", "pending_push"],
  ["cancelled", "conflicted"],
  ["rescheduled", "confirmed"],
  ["rescheduled", "cancelled"],
  ["rescheduled", "conflicted"],
  ["rescheduled", "pending_push"],
  ["confirmed", "pending_push"],
  ["conflicted", "pending_push"],
  ["conflicted", "confirmed"],
  ["pending_push", "cancelled"],
  ["pending_push", "rescheduled"],
];

describe("illegal transitions throw", () => {
  for (const [from, to] of ILLEGAL) {
    it(`throws on ${from} → ${to}`, () => {
      expect(() => transition(from, to, "system")).toThrow(
        `Illegal booking state transition: ${from} → ${to}`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Terminal states
// ---------------------------------------------------------------------------

describe("isTerminal", () => {
  it("cancelled is terminal", () => expect(isTerminal("cancelled")).toBe(true));
  it("rescheduled is terminal", () => expect(isTerminal("rescheduled")).toBe(true));
  it("pending_push is not terminal", () => expect(isTerminal("pending_push")).toBe(false));
  it("confirmed is not terminal", () => expect(isTerminal("confirmed")).toBe(false));
  it("conflicted is not terminal", () => expect(isTerminal("conflicted")).toBe(false));
});
