import { describe, expect, it } from "bun:test";

// Trivial harness test — proves bun test runs in @calendry/email.
// Real email outbox tests land in Sprint 1.
describe("@calendry/email scaffold", () => {
  it("test harness is functional", () => {
    expect(true).toBe(true);
  });
});
