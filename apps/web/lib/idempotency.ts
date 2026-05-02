/**
 * idempotency.ts — Deterministic idempotency key derivation.
 *
 * Per issue #19 / SPEC §Idempotency:
 *   idempotency_key = sha256(booker_email + ":" + start_utc + ":" + slug)
 *
 * start_utc is canonicalized via new Date(start_utc).toISOString() before
 * hashing so that "2026-05-05T17:00:00Z" and "2026-05-05T17:00:00.000Z"
 * produce the same key.  An invalid start_utc throws a typed validation error
 * (code: "INVALID_START_UTC") so the API handler can return 400 immediately.
 *
 * Uses the Web Crypto API (available in Node, Bun, and Edge runtimes).
 */

export interface BookingIdempotencyArgs {
  bookerEmail: string;
  startUtc: string;
  slug: string;
}

/** Typed validation error thrown when start_utc cannot be parsed as a valid date. */
export class InvalidStartUtcError extends Error {
  readonly code = "INVALID_START_UTC" as const;

  constructor(raw: string) {
    super(`start_utc "${raw}" is not a valid ISO-8601 date`);
    this.name = "InvalidStartUtcError";
  }
}

/**
 * Derive the booking idempotency key.
 * Returns a lowercase hex-encoded SHA-256 digest (64 characters).
 *
 * why: deterministic + stable — the same (email, start, slug) triple always
 * produces the same key, enabling safe idempotent replays without a separate
 * lookup table on the hot path.
 *
 * Canonicalization: start_utc is re-serialized via Date.toISOString() before
 * hashing so that equivalent UTC instants in different ISO formats (e.g. with
 * or without explicit ".000" milliseconds) always hash to the same key.
 */
export async function deriveBookingIdempotencyKey(args: BookingIdempotencyArgs): Promise<string> {
  // Canonicalize start_utc: reject NaN dates before producing any hash
  const parsed = new Date(args.startUtc);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidStartUtcError(args.startUtc);
  }
  const canonicalStartUtc = parsed.toISOString();

  const input = `${args.bookerEmail}:${canonicalStartUtc}:${args.slug}`;
  const encoded = new TextEncoder().encode(input);
  const hashBuf = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
