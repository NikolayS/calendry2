/**
 * rate-limiter.test.ts
 *
 * TDD: in-process token-bucket rate limiter.
 * Per issue #19 / SPEC §Tests Plan / security:
 *   10 / IP / minute and 3 / booker_email / minute
 *   11th request in a minute → 429 with Retry-After header
 *
 * Run: bun test tests/unit/rate-limiter.test.ts
 */

import { describe, expect, it } from "bun:test";
import { RateLimiter } from "../../apps/web/lib/rate-limiter";

describe("RateLimiter — basic token bucket", () => {
  it("allows requests up to the limit", () => {
    const rl = new RateLimiter({ maxRequests: 3, windowMs: 60_000 });
    expect(rl.check("key1").allowed).toBe(true);
    expect(rl.check("key1").allowed).toBe(true);
    expect(rl.check("key1").allowed).toBe(true);
  });

  it("blocks the (limit+1)th request", () => {
    const rl = new RateLimiter({ maxRequests: 3, windowMs: 60_000 });
    rl.check("key1");
    rl.check("key1");
    rl.check("key1");
    const result = rl.check("key1");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("different keys are independent", () => {
    const rl = new RateLimiter({ maxRequests: 2, windowMs: 60_000 });
    rl.check("ip1");
    rl.check("ip1");
    // ip1 is now blocked but ip2 should be fine
    expect(rl.check("ip1").allowed).toBe(false);
    expect(rl.check("ip2").allowed).toBe(true);
  });

  it("resets after the window elapses", () => {
    const windowMs = 50; // 50ms window for test speed
    const rl = new RateLimiter({ maxRequests: 1, windowMs });
    rl.check("key1");
    expect(rl.check("key1").allowed).toBe(false);
    // Advance time past the window using the internal clock override
    const future = Date.now() + windowMs + 10;
    const result = rl.check("key1", future);
    expect(result.allowed).toBe(true);
  });

  it("retryAfterMs is approximately the remaining window", () => {
    const windowMs = 60_000;
    const rl = new RateLimiter({ maxRequests: 1, windowMs });
    const now = Date.now();
    rl.check("key1", now);
    const result = rl.check("key1", now + 1000); // 1s later
    expect(result.allowed).toBe(false);
    // Remaining = windowMs - 1000 = 59000ms
    expect(result.retryAfterMs).toBeGreaterThanOrEqual(58_000);
    expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);
  });
});

describe("RateLimiter — IP limit (10/min)", () => {
  it("allows exactly 10 requests from the same IP", () => {
    const rl = new RateLimiter({ maxRequests: 10, windowMs: 60_000 });
    for (let i = 0; i < 10; i++) {
      expect(rl.check("192.0.2.1").allowed).toBe(true);
    }
  });

  it("blocks the 11th request", () => {
    const rl = new RateLimiter({ maxRequests: 10, windowMs: 60_000 });
    for (let i = 0; i < 10; i++) rl.check("192.0.2.1");
    const result = rl.check("192.0.2.1");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });
});

describe("RateLimiter — email limit (3/min)", () => {
  it("allows exactly 3 requests for the same email", () => {
    const rl = new RateLimiter({ maxRequests: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      expect(rl.check("alice@example.com").allowed).toBe(true);
    }
  });

  it("blocks the 4th request for the same email", () => {
    const rl = new RateLimiter({ maxRequests: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) rl.check("alice@example.com");
    const result = rl.check("alice@example.com");
    expect(result.allowed).toBe(false);
  });
});
