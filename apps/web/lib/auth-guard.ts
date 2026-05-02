/**
 * Admin route guard logic.
 *
 * All /admin/* routes require a session token (Supabase GoTrue JWT stored in
 * a cookie by @supabase/ssr). The /admin/login page itself is exempt so users
 * can reach the login form.
 *
 * On redirect, the original pathname is passed as the `next` query param so
 * that post-login redirect works.
 */

export type GuardResult =
  | { type: "allow" }
  | { type: "redirect"; destination: string; status: 302 };

export interface AdminAccessOptions {
  /** Request pathname (e.g. "/admin", "/admin/settings") */
  pathname: string;
  /** Supabase session token from the auth cookie, or undefined if not present. */
  sessionToken: string | undefined;
}

const ADMIN_PREFIX = "/admin";
const LOGIN_PAGE = "/admin/login";

/**
 * Determine whether the request should be allowed or redirected.
 *
 * Rules:
 *   - Non-admin paths → always allow.
 *   - /admin/login → always allow (must be reachable unauthenticated).
 *   - /admin/* with a session token → allow.
 *   - /admin/* without a session token → redirect to /admin/login?next=<encoded-pathname>.
 */
export function checkAdminAccess(opts: AdminAccessOptions): GuardResult {
  const { pathname, sessionToken } = opts;

  // Not an admin route — no guard needed.
  if (!pathname.startsWith(ADMIN_PREFIX)) {
    return { type: "allow" };
  }

  // Login page is always reachable (otherwise the redirect creates a loop).
  if (pathname === LOGIN_PAGE || pathname.startsWith(`${LOGIN_PAGE}/`)) {
    return { type: "allow" };
  }

  // Admin route with a valid session → allow.
  if (sessionToken) {
    return { type: "allow" };
  }

  // Unauthenticated admin route → redirect.
  const next = encodeURIComponent(pathname);
  return {
    type: "redirect",
    destination: `${LOGIN_PAGE}?next=${next}`,
    status: 302,
  };
}
