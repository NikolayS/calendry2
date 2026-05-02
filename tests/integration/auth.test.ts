/**
 * Auth / admin-route guard integration tests — test-first (TDD).
 *
 * Tests the middleware guard logic directly (no running server required).
 * The guard logic lives in apps/web/lib/auth-guard.ts.
 *
 * Assertions:
 *   1. Unauthenticated GET /admin → redirect 302 to /admin/login?next=/admin
 *   2. Unauthenticated GET /admin/anything → redirect 302 to /admin/login?next=/admin/anything
 *   3. Authenticated GET /admin → allowed (no redirect)
 *   4. Anonymous GET /book/test-slug → 200, no auth check
 *   5. next param is URL-encoded in the redirect
 */

import { describe, expect, it } from "bun:test";
import { checkAdminAccess } from "../../apps/web/lib/auth-guard";

describe("Admin route guard", () => {
  it("unauthenticated GET /admin → redirect to /admin/login?next=%2Fadmin", () => {
    const result = checkAdminAccess({
      pathname: "/admin",
      sessionToken: undefined,
    });
    expect(result.type).toBe("redirect");
    if (result.type === "redirect") {
      expect(result.destination).toBe("/admin/login?next=%2Fadmin");
      expect(result.status).toBe(302);
    }
  });

  it("unauthenticated GET /admin/settings → redirect with correct next param", () => {
    const result = checkAdminAccess({
      pathname: "/admin/settings",
      sessionToken: undefined,
    });
    expect(result.type).toBe("redirect");
    if (result.type === "redirect") {
      expect(result.destination).toBe("/admin/login?next=%2Fadmin%2Fsettings");
    }
  });

  it("authenticated GET /admin → allowed", () => {
    const result = checkAdminAccess({
      pathname: "/admin",
      sessionToken: "valid-jwt-token",
    });
    expect(result.type).toBe("allow");
  });

  it("authenticated GET /admin/settings → allowed", () => {
    const result = checkAdminAccess({
      pathname: "/admin/settings",
      sessionToken: "valid-jwt-token",
    });
    expect(result.type).toBe("allow");
  });

  it("anonymous GET /book/test-slug → always allowed (no auth check)", () => {
    const result = checkAdminAccess({
      pathname: "/book/test-slug",
      sessionToken: undefined,
    });
    // /book/* is not an admin route — guard should not apply
    expect(result.type).toBe("allow");
  });

  it("anonymous GET / → always allowed", () => {
    const result = checkAdminAccess({
      pathname: "/",
      sessionToken: undefined,
    });
    expect(result.type).toBe("allow");
  });

  it("anonymous GET /admin/login → allowed (login page itself must be accessible)", () => {
    const result = checkAdminAccess({
      pathname: "/admin/login",
      sessionToken: undefined,
    });
    expect(result.type).toBe("allow");
  });
});
