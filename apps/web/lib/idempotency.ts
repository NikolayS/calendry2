/**
 * idempotency.ts — Deterministic idempotency key derivation.
 *
 * Per issue #19 / SPEC §Idempotency:
 *   idempotency_key = sha256(booker_email + ":" + start_utc + ":" + slug)
 *
 * Uses the Web Crypto API (available in Node, Bun, and Edge runtimes).
 */

export interface BookingIdempotencyArgs {
  bookerEmail: string;
  startUtc: string;
  slug: string;
}

/**
 * Derive the booking idempotency key.
 * Returns a lowercase hex-encoded SHA-256 digest (64 characters).
 *
 * why: deterministic + stable — the same (email, start, slug) triple always
 * produces the same key, enabling safe idempotent replays without a separate
 * lookup table on the hot path.
 */
export async function deriveBookingIdempotencyKey(args: BookingIdempotencyArgs): Promise<string> {
  const input = `${args.bookerEmail}:${args.startUtc}:${args.slug}`;
  const encoded = new TextEncoder().encode(input);
  const hashBuf = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
