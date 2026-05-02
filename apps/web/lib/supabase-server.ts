/**
 * Supabase server-side client (Next.js Server Components / Route Handlers).
 *
 * Uses @supabase/ssr to manage the session via cookies.
 * Environment variables must be set — see .env.example.
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
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
            // Ignore when called from read-only Server Component context.
          }
        },
      },
    },
  );
}
