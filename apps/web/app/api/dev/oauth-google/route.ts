// why: This route is only mounted when NODE_ENV !== "production". It simulates
// a Google OAuth provider for local development and CI so that the "Sign in
// with Google" button works end-to-end without real Google client credentials.
// NEVER expose in production — the guard below returns 404 in production builds.

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";

// Hard-reject in production at the module level so tree-shaking can eliminate
// the route entirely in a production build.
if (process.env.NODE_ENV === "production") {
  throw new Error("BUG: /api/dev/oauth-google must never be mounted in production");
}

const FAKE_USER = {
  id: "dev-mock-user-00000000-0000-0000-0000-000000000001",
  email: "admin@calendry.local",
  name: "Dev Admin",
  role: "admin",
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  // why: extra runtime guard in case the module-level check is bypassed
  if (process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }

  const { origin } = new URL(req.url);
  const cookieStore = await cookies();

  // Issue a simple dev session cookie so middleware sees an authenticated user.
  // In production, @supabase/ssr sets the real session; here we use a
  // human-readable placeholder that the middleware can detect.
  cookieStore.set("sb-access-token", `dev-mock:${FAKE_USER.email}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: 3600,
  });

  // Redirect to admin dashboard — same flow as the real OAuth callback.
  const redirectTo = req.nextUrl.searchParams.get("next") ?? "/admin";
  const destination = redirectTo.startsWith("/") ? `${origin}${redirectTo}` : `${origin}/admin`;

  console.info(
    `[dev/oauth-google] Mock login as ${FAKE_USER.email} → redirecting to ${destination}`,
  );

  return NextResponse.redirect(destination);
}
