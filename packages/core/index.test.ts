import { describe, expect, it } from "bun:test";

// Trivial harness test — proves bun test runs in @calendry/core.
// Real slot-gen tests land in #7 (see SPEC.md §Tests Plan).
describe("@calendry/core scaffold", () => {
  it("test harness is functional", () => {
    expect(true).toBe(true);
  });
});
