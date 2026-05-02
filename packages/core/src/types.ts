/**
 * types.ts — Shared domain types for @calendry/core.
 *
 * These mirror the DB types in @calendry/db but are kept separate so that
 * core logic (pure functions, state machine) has no dependency on the DB package.
 */

export type BookingState =
  | "pending_push"
  | "confirmed"
  | "cancelled"
  | "rescheduled"
  | "conflicted";
