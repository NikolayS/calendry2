/**
 * GET /api/auth/callback — Supabase GoTrue auth callback handler.
 *
 * GoTrue redirects here after magic-link confirmation or OAuth code exchange.
 * The `code` query parameter is exchanged for a session via @supabase/ssr,
 * which sets the session cookies.
 *
 * On success: redirect to `next` param (default: /admin).
 * On error: redirect to /admin/login with error info.
 *
 * Note: standalone GoTrue (without Kong proxy) issues a redirect to
 * SITE_URL#access_token=... after /verify. For full PKCE code-flow support
 * (used with real @supabase/ssr), configure GOTRUE_MAILER_URLPATHS_RECOVERY
 * to point here and ensure GoTrue is behind the Kong proxy or Supabase REST
 * gateway. The current dev setup uses fragment-based token delivery which is
 * handled client-side by @supabase/ssr's createBrowserClient.
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(req.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/admin";

  if (!code) {
    return NextResponse.redirect(`${origin}/admin/login?error=missing_code`);
  }

  const cookieStore = await cookies();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Can be called from Server Component — ignore if response already sent.
          }
        },
      },
    },
  );

  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(
      `${origin}/admin/login?error=${encodeURIComponent(error.message)}`,
    );
  }

  return NextResponse.redirect(`${origin}${next}`);
}
