/**
 * GET /api/csrf — issues a CSRF token.
 *
 * Sets a same-site Secure cookie (csrf_token) and returns the same value in
 * the JSON body so the client can attach it as X-CSRF-Token on mutating requests.
 */

import { NextResponse } from "next/server";
import { CSRF_COOKIE, createCsrfToken } from "../../../lib/csrf";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  const token = createCsrfToken();
  const isProd = process.env.NODE_ENV === "production";

  const res = NextResponse.json({ token });

  res.cookies.set({
    name: CSRF_COOKIE,
    value: token,
    httpOnly: false, // must be readable by client JS for double-submit pattern
    sameSite: "strict",
    secure: isProd,
    path: "/",
    maxAge: 3600,
  });

  return res;
}
