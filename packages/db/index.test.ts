import { describe, expect, it } from "bun:test";

// Trivial harness test — proves bun test runs in @calendry/db.
// Real DB integration tests land in #6.
describe("@calendry/db scaffold", () => {
  it("test harness is functional", () => {
    expect(true).toBe(true);
  });
});
