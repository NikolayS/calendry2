/**
 * CSRF middleware integration tests — test-first (TDD).
 *
 * These tests call the Next.js API routes directly via fetch against a running
 * dev server, OR by importing the middleware helpers directly for unit-style
 * speed. We use direct imports here to keep CI fast (no server required).
 *
 * Assertions:
 *   1. POST /api/* without CSRF token → 403
 *   2. POST /api/* with valid token (cookie + header match) → passes middleware
 *   3. POST /api/* with valid token but wrong Origin → 403
 *   4. GET /api/csrf → returns a token (the CSRF issue endpoint)
 *   5. Public booking POST (/api/bookings) is exempt from CSRF check
 */

import { describe, expect, it } from "bun:test";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  createCsrfToken,
  validateCsrfRequest,
} from "../../apps/web/lib/csrf";

const ORIGIN = "http://localhost:3000";

// Helper: build a minimal Request-like object for testing
function makeRequest(opts: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  cookieToken?: string;
  headerToken?: string;
  origin?: string;
}): Request {
  const headers = new Headers(opts.headers ?? {});
  if (opts.cookieToken) {
    headers.set("cookie", `${CSRF_COOKIE}=${opts.cookieToken}`);
  }
  if (opts.headerToken) {
    headers.set(CSRF_HEADER, opts.headerToken);
  }
  if (opts.origin !== undefined) {
    headers.set("origin", opts.origin);
  } else {
    headers.set("origin", ORIGIN);
  }
  return new Request(`${ORIGIN}${opts.path}`, {
    method: opts.method,
    headers,
  });
}

describe("CSRF middleware", () => {
  it("issues a cryptographically-random token", () => {
    const t1 = createCsrfToken();
    const t2 = createCsrfToken();
    expect(typeof t1).toBe("string");
    expect(t1.length).toBeGreaterThan(20);
    // Two tokens must not be equal (probabilistically certain)
    expect(t1).not.toBe(t2);
  });

  it("GET is always allowed (no CSRF token required)", () => {
    const req = makeRequest({ method: "GET", path: "/api/csrf" });
    const result = validateCsrfRequest(req, ORIGIN);
    expect(result.ok).toBe(true);
  });

  it("POST without any CSRF token → rejected (403)", () => {
    const req = makeRequest({ method: "POST", path: "/api/admin/something" });
    const result = validateCsrfRequest(req, ORIGIN);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });

  it("POST with matching cookie + header token → accepted", () => {
    const token = createCsrfToken();
    const req = makeRequest({
      method: "POST",
      path: "/api/admin/something",
      cookieToken: token,
      headerToken: token,
    });
    const result = validateCsrfRequest(req, ORIGIN);
    expect(result.ok).toBe(true);
  });

  it("POST with mismatched cookie vs header token → rejected (403)", () => {
    const req = makeRequest({
      method: "POST",
      path: "/api/admin/something",
      cookieToken: createCsrfToken(),
      headerToken: createCsrfToken(),
    });
    const result = validateCsrfRequest(req, ORIGIN);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });

  it("POST with valid token but wrong Origin → rejected (403)", () => {
    const token = createCsrfToken();
    const req = makeRequest({
      method: "POST",
      path: "/api/admin/something",
      cookieToken: token,
      headerToken: token,
      origin: "https://attacker.example.com",
    });
    const result = validateCsrfRequest(req, ORIGIN);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });

  it("PATCH without token → rejected (403)", () => {
    const req = makeRequest({ method: "PATCH", path: "/api/admin/something" });
    const result = validateCsrfRequest(req, ORIGIN);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });

  it("DELETE without token → rejected (403)", () => {
    const req = makeRequest({ method: "DELETE", path: "/api/admin/something" });
    const result = validateCsrfRequest(req, ORIGIN);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });

  it("Public booking POST (/api/bookings) is CSRF-exempt", () => {
    // The booking route is deliberately exempt — rate-limit lands in Sprint 1.
    const req = makeRequest({ method: "POST", path: "/api/bookings" });
    const result = validateCsrfRequest(req, ORIGIN, { exempt: ["/api/bookings"] });
    expect(result.ok).toBe(true);
  });
});
