/**
 * booking-state-machine.ts — Booking state transitions.
 *
 * Defines legal state transitions per SPEC §Booking state machine.
 * Illegal transitions throw — they never silently no-op.
 *
 * State machine:
 *   pending_push → confirmed → cancelled (terminal)
 *                            → rescheduled (terminal; new row)
 *                 → conflicted → cancelled
 *                              → rescheduled
 */

import type { BookingState } from "./types";

export type TransitionActor = "booker" | "provider" | "system";

export interface StateTransition {
  from: BookingState;
  to: BookingState;
  actor: TransitionActor;
  at: Date;
}

/** Legal transitions: from → set of reachable states */
const LEGAL_TRANSITIONS: Record<BookingState, ReadonlySet<BookingState>> = {
  pending_push: new Set<BookingState>(["confirmed", "conflicted"]),
  confirmed: new Set<BookingState>(["cancelled", "rescheduled", "conflicted"]),
  conflicted: new Set<BookingState>(["cancelled", "rescheduled"]),
  cancelled: new Set<BookingState>(),
  rescheduled: new Set<BookingState>(),
};

/**
 * Assert a state transition is legal and return a StateTransition record.
 * Throws if the transition is illegal.
 *
 * why: SPEC §Booking state machine — "Illegal transitions throw — they never
 * silently no-op. State transitions are logged with actor."
 */
export function transition(
  from: BookingState,
  to: BookingState,
  actor: TransitionActor,
  at: Date = new Date(),
): StateTransition {
  const reachable = LEGAL_TRANSITIONS[from];
  if (!reachable.has(to)) {
    throw new Error(`Illegal booking state transition: ${from} → ${to}`);
  }
  return { from, to, actor, at };
}

/** Returns true if the given state is terminal (no further transitions). */
export function isTerminal(state: BookingState): boolean {
  return LEGAL_TRANSITIONS[state].size === 0;
}
