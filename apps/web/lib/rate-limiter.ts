/**
 * rate-limiter.ts — In-process token-bucket rate limiter.
 *
 * Used for POST /api/bookings:
 *   - 10 requests / IP / minute
 *   - 3 requests / booker_email / minute
 *
 * v0.1: in-process (single Node/Bun process). Configurable via env:
 *   RATE_LIMIT_BOOKING_IP_PER_MIN    (default: 10)
 *   RATE_LIMIT_BOOKING_EMAIL_PER_MIN (default: 3)
 *
 * why: simple sliding-window counter. Good enough for v0.1 single-process
 * deploy. Postgres-backed counter deferred to v0.2 when multi-process needed.
 */

export interface RateLimiterOptions {
  maxRequests: number;
  windowMs: number;
}

export type RateCheckResult = { allowed: true } | { allowed: false; retryAfterMs: number };

interface BucketEntry {
  count: number;
  windowStart: number; // ms timestamp
}

/**
 * Simple in-process sliding-window rate limiter.
 *
 * Each key gets a fixed window. If requests exceed maxRequests within
 * windowMs, subsequent requests are denied with retryAfterMs indicating
 * how long to wait.
 */
export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly buckets = new Map<string, BucketEntry>();

  constructor(opts: RateLimiterOptions) {
    this.maxRequests = opts.maxRequests;
    this.windowMs = opts.windowMs;
  }

  /**
   * Check and consume a token for the given key.
   *
   * @param key       - Rate-limit key (e.g. IP address or email).
   * @param nowMs     - Current time in ms (defaults to Date.now(); injectable for tests).
   */
  check(key: string, nowMs: number = Date.now()): RateCheckResult {
    const entry = this.buckets.get(key);

    if (!entry || nowMs - entry.windowStart >= this.windowMs) {
      // New window — reset
      this.buckets.set(key, { count: 1, windowStart: nowMs });
      return { allowed: true };
    }

    if (entry.count < this.maxRequests) {
      entry.count += 1;
      return { allowed: true };
    }

    // Exceeded — compute retry-after
    const windowEnd = entry.windowStart + this.windowMs;
    const retryAfterMs = Math.max(0, windowEnd - nowMs);
    return { allowed: false, retryAfterMs };
  }
}

// ---------------------------------------------------------------------------
// Singleton instances for the booking endpoint
// ---------------------------------------------------------------------------

const IP_MAX = Number(process.env.RATE_LIMIT_BOOKING_IP_PER_MIN ?? "10");
const EMAIL_MAX = Number(process.env.RATE_LIMIT_BOOKING_EMAIL_PER_MIN ?? "3");
const WINDOW_MS = 60_000; // 1 minute

export const ipRateLimiter = new RateLimiter({ maxRequests: IP_MAX, windowMs: WINDOW_MS });
export const emailRateLimiter = new RateLimiter({ maxRequests: EMAIL_MAX, windowMs: WINDOW_MS });
