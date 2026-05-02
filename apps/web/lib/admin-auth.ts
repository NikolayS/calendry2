/**
 * admin-auth.ts — Thin helper to verify admin session in API route handlers.
 *
 * Admin routes that need authentication call `requireAdminSession(req)`.
 * If the session token is missing or invalid the helper returns a 401 response.
 * Otherwise it returns null (caller proceeds normally).
 *
 * why: middleware.ts handles the redirect for browser navigations to /admin/*.
 * API handlers under /api/admin/* need their own 401 response (not a redirect)
 * because API clients don't follow HTML redirects.
 */

import { type NextRequest, NextResponse } from "next/server";

/**
 * Returns a 401 NextResponse if no session token is present, else null.
 *
 * In v0.1 we accept any non-empty value in sb-access-token or sb-auth-token.
 * Full JWT verification against GoTrue's public key is a Sprint 2 hardening item.
 */
export function requireAdminSession(req: NextRequest): NextResponse | null {
  const token =
    req.cookies.get("sb-access-token")?.value ?? req.cookies.get("sb-auth-token")?.value;

  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
