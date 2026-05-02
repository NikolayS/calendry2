/**
 * signed-token.ts — HMAC-signed tokens for cancel/reschedule links.
 *
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256 signature)
 * Payload: { booking_id, kind, issued_at, exp }
 *
 * WHY issued now even though cancel/reschedule endpoints land in Sprint 2:
 * the issue spec says "tokens issued now". This keeps the confirmation email
 * wirable in Sprint 2 without changing the booking row.
 *
 * Secret: BOOKING_TOKEN_SECRET env var. Must be set in production.
 * In test/dev a static fallback is used (warned at startup below).
 *
 * Token TTL: defaults to 30 days; override via BOOKING_TOKEN_TTL_DAYS env.
 */

export type TokenKind = "cancel" | "reschedule";

export interface TokenPayload {
  booking_id: string;
  kind: TokenKind;
  issued_at: number; // Unix ms
  exp: number; // Unix ms — token must be verified before this time
}

/** Thrown by verifyToken when the token's exp timestamp is in the past. */
export class TokenExpiredError extends Error {
  constructor() {
    super("Token has expired");
    this.name = "TokenExpiredError";
  }
}

const SECRET = process.env.BOOKING_TOKEN_SECRET ?? "dev-insecure-secret-change-in-production";

// Warn at startup when the dev fallback is active — matches the comment claim.
if (!process.env.BOOKING_TOKEN_SECRET) {
  console.warn(
    "[signed-token] WARNING: BOOKING_TOKEN_SECRET is not set. " +
      "Using the insecure dev fallback. Set a strong secret in production.",
  );
}

/** Default token lifetime in milliseconds (30 days, configurable via BOOKING_TOKEN_TTL_DAYS). */
export const TOKEN_TTL_MS =
  Number(process.env.BOOKING_TOKEN_TTL_DAYS ?? "30") * 24 * 60 * 60 * 1000;

/** Encode bytes to base64url without padding. */
function toBase64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Import the HMAC key from the secret string. */
async function importKey(usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/**
 * Sign a token payload. Returns a compact signed token string.
 *
 * The payload must include an `exp` (Unix ms) claim. Use TOKEN_TTL_MS to
 * compute the default expiry: exp = issued_at + TOKEN_TTL_MS.
 */
export async function signToken(payload: TokenPayload): Promise<string> {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = btoa(payloadJson).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const key = await importKey("sign");
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${toBase64url(sig)}`;
}

/**
 * Verify a signed token. Returns the decoded payload on success.
 *
 * Throws:
 *   - TokenExpiredError   if now > payload.exp
 *   - Error("invalid token") if the signature does not match or the format is wrong
 */
export async function verifyToken(token: string): Promise<TokenPayload> {
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx === -1) throw new Error("invalid token: missing signature separator");

  const payloadB64 = token.slice(0, dotIdx);
  const sigB64 = token.slice(dotIdx + 1);

  // Verify HMAC signature
  const key = await importKey("verify");
  const sigBytes = Uint8Array.from(atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    new TextEncoder().encode(payloadB64),
  );
  if (!valid) throw new Error("invalid token: signature mismatch");

  // Decode payload
  const payloadJson = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
  const payload = JSON.parse(payloadJson) as TokenPayload;

  // Enforce expiry
  if (Date.now() > payload.exp) {
    throw new TokenExpiredError();
  }

  return payload;
}
