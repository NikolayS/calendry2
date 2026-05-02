/**
 * Next.js Edge Middleware — CSRF check + admin route guard.
 *
 * Runs before every request matched by the `config.matcher` below.
 *
 * Responsibilities:
 *   1. CSRF: reject POST/PATCH/DELETE to /api/* (except exempt paths) if the
 *      double-submit cookie + header don't match or the Origin is wrong.
 *   2. Auth guard: redirect unauthenticated requests to /admin/* (except
 *      /admin/login) to /admin/login?next=<encoded-pathname>.
 */

import { type NextRequest, NextResponse } from "next/server";
import { checkAdminAccess } from "./lib/auth-guard";
import { validateCsrfRequest } from "./lib/csrf";

// Paths exempt from CSRF checking (public booking POST lands Sprint 1 — CSRF is still off for it).
const CSRF_EXEMPT_PATHS = ["/api/bookings", "/api/auth/callback", "/api/dev"];

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const origin = req.headers.get("origin") ?? req.nextUrl.origin;

  // ── CSRF check ───────────────────────────────────────────────────────────────
  if (pathname.startsWith("/api/")) {
    const csrfResult = validateCsrfRequest(req, req.nextUrl.origin, {
      exempt: CSRF_EXEMPT_PATHS,
    });
    if (!csrfResult.ok) {
      return NextResponse.json({ error: csrfResult.message }, { status: csrfResult.status });
    }
  }

  // ── Admin route guard ─────────────────────────────────────────────────────────
  if (pathname.startsWith("/admin")) {
    // Read session token from Supabase SSR cookie (sb-access-token).
    // In dev the mock OAuth sets "sb-access-token" directly; in production
    // @supabase/ssr manages the session cookies transparently.
    const sessionToken =
      req.cookies.get("sb-access-token")?.value ?? req.cookies.get("sb-auth-token")?.value;

    const guardResult = checkAdminAccess({ pathname, sessionToken });

    if (guardResult.type === "redirect") {
      const url = req.nextUrl.clone();
      const [path, qs] = guardResult.destination.split("?");
      url.pathname = path ?? guardResult.destination;
      if (qs) {
        for (const [k, v] of new URLSearchParams(qs)) {
          url.searchParams.set(k, v);
        }
      }
      return NextResponse.redirect(url, { status: guardResult.status });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Match all /api/* routes and all /admin/* routes.
    // Exclude Next.js internals and static files.
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
