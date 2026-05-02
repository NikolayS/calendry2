import { describe, expect, it } from "bun:test";

// Trivial harness test — proves bun test runs in @calendry/web.
// Real Playwright e2e tests land in #9.
describe("@calendry/web scaffold", () => {
  it("test harness is functional", () => {
    expect(true).toBe(true);
  });
});
