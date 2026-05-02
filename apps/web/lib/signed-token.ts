/**
 * signed-token.ts — HMAC-signed tokens for cancel/reschedule links.
 *
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256 signature)
 * Payload: { booking_id, kind, issued_at }
 *
 * WHY issued now even though cancel/reschedule endpoints land in Sprint 2:
 * the issue spec says "tokens issued now". This keeps the confirmation email
 * wirable in Sprint 2 without changing the booking row.
 *
 * Secret: BOOKING_TOKEN_SECRET env var. Must be set in production.
 * In test/dev a static fallback is used (detected and warned at startup).
 */

export type TokenKind = "cancel" | "reschedule";

export interface TokenPayload {
  booking_id: string;
  kind: TokenKind;
  issued_at: number; // Unix ms
}

const SECRET = process.env.BOOKING_TOKEN_SECRET ?? "dev-insecure-secret-change-in-production";

/** Encode bytes to base64url without padding. */
function toBase64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Sign a token payload. Returns a compact signed token string. */
export async function signToken(payload: TokenPayload): Promise<string> {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = btoa(payloadJson).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${toBase64url(sig)}`;
}
