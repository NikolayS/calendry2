// @calendry/core — slot generation, booking state machine, ICS generation, time math

export type { AvailabilityRule, BusyBlock, Slot } from "./src/slot-gen";
export { generateSlots } from "./src/slot-gen";

export type { BookingState } from "./src/types";
export type { StateTransition, TransitionActor } from "./src/booking-state-machine";
export { transition, isTerminal } from "./src/booking-state-machine";
