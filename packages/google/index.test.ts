import { describe, expect, it } from "bun:test";

// Trivial harness test — proves bun test runs in @calendry/google.
// Real Google API tests land in #8.
describe("@calendry/google scaffold", () => {
  it("test harness is functional", () => {
    expect(true).toBe(true);
  });
});
