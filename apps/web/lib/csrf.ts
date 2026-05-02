/**
 * CSRF protection helpers.
 *
 * Strategy: double-submit cookie pattern.
 *   1. GET /api/csrf issues a cryptographically-random token, sets it in a
 *      same-site Secure cookie, and returns it in the JSON body.
 *   2. On every mutating request (POST / PATCH / DELETE) the client must echo
 *      the token back in the X-CSRF-Token header.
 *   3. Middleware reads both values; if they match and the Origin is trusted,
 *      the request is allowed. Otherwise 403.
 *
 * The public booking POST (/api/bookings) is explicitly exempt — rate-limit
 * lands in Sprint 1. CSRF exemptions are passed as an option array.
 */

export const CSRF_HEADER = "x-csrf-token";
export const CSRF_COOKIE = "csrf_token";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Returns a cryptographically-random, URL-safe token (Web Crypto API). */
export function createCsrfToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  // base64url encode (no padding, URL-safe)
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export type CsrfResult = { ok: true } | { ok: false; status: 403; message: string };

export interface ValidateCsrfOptions {
  /**
   * Paths that are exempt from CSRF checking even on mutating methods.
   * Matched by exact pathname prefix.
   */
  exempt?: string[];
}

/**
 * Validate a request for CSRF safety.
 *
 * @param request - The incoming Request (or compatible object with headers + url).
 * @param trustedOrigin - The application's own origin, e.g. "http://localhost:3000".
 * @param options - Optional exemption list.
 */
export function validateCsrfRequest(
  request: Request,
  trustedOrigin: string,
  options: ValidateCsrfOptions = {},
): CsrfResult {
  const method = request.method.toUpperCase();

  // GET, HEAD, OPTIONS are safe by definition.
  if (!MUTATING_METHODS.has(method)) {
    return { ok: true };
  }

  // Check exemption list (exact match or prefix).
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (options.exempt?.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return { ok: true };
  }

  // Origin check — must match trusted origin exactly.
  const origin = request.headers.get("origin");
  if (!origin || origin !== trustedOrigin) {
    return { ok: false, status: 403, message: "CSRF: untrusted origin" };
  }

  // Double-submit cookie check.
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookieToken = parseCookie(cookieHeader, CSRF_COOKIE);
  const headerToken = request.headers.get(CSRF_HEADER);

  if (!cookieToken || !headerToken) {
    return { ok: false, status: 403, message: "CSRF: token missing" };
  }

  // Constant-time comparison to prevent timing attacks.
  if (!timingSafeEqual(cookieToken, headerToken)) {
    return { ok: false, status: 403, message: "CSRF: token mismatch" };
  }

  return { ok: true };
}

/** Parse a single named cookie from a Cookie header string. */
function parseCookie(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k?.trim() === name) {
      return v.join("=").trim();
    }
  }
  return undefined;
}

/** Constant-time string comparison (mitigates timing oracle attacks). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: bounded loop
    diff |= a.charCodeAt(i) ^ b!.charCodeAt(i);
  }
  return diff === 0;
}
