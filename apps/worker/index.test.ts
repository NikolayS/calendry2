import { describe, expect, it } from "bun:test";

// Trivial harness test — proves bun test runs in @calendry/worker.
// Real job handler tests land in Sprint 1.
describe("@calendry/worker scaffold", () => {
  it("test harness is functional", () => {
    expect(true).toBe(true);
  });
});
