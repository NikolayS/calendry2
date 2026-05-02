/**
 * POST /api/auth/magic-link — proxies a magic-link request to GoTrue.
 *
 * The client POSTs { email } here. We forward to GoTrue /magiclink.
 * CSRF is validated by middleware.ts before this handler runs.
 *
 * In dev, GoTrue routes magic-link emails through Mailpit (SMTP on :1025).
 * View captured emails at http://localhost:8025.
 *
 * In production, GoTrue is configured to use Resend (or another SMTP relay).
 * No Resend keys required in dev/test.
 *
 * GoTrue URL: standalone GoTrue (compose) serves at /magiclink (not /auth/v1/magiclink).
 * GOTRUE_URL must be set to the GoTrue container's internal or external URL.
 */

import { type NextRequest, NextResponse } from "next/server";

// Standalone GoTrue (no Kong proxy) listens at the root, not /auth/v1.
const GOTRUE_URL =
  process.env.GOTRUE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://localhost:9999";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let email: string;
  try {
    const body = (await req.json()) as { email?: string };
    if (!body.email || typeof body.email !== "string") {
      return NextResponse.json({ error: "email is required" }, { status: 400 });
    }
    email = body.email.trim().toLowerCase();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const gotrueRes = await fetch(`${GOTRUE_URL}/magiclink`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });

    if (!gotrueRes.ok) {
      const err = (await gotrueRes.json()) as { msg?: string; message?: string };
      return NextResponse.json(
        { error: err.msg ?? err.message ?? "GoTrue error" },
        { status: gotrueRes.status },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
