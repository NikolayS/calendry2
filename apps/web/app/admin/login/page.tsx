"use client";

/**
 * Admin login page — magic link + Google OAuth (dev mock).
 * Magic link: submits email to Supabase GoTrue /auth/v1/magiclink.
 * Google OAuth: in dev/test, points at /api/dev/oauth-google (mock).
 *               In production, real Google OAuth client credentials required — see docs/oauth-setup.md.
 */

import { useState } from "react";

export default function AdminLoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setErrorMsg("");

    try {
      // Fetch a CSRF token first (required for POST)
      const csrfRes = await fetch("/api/csrf");
      const { token } = (await csrfRes.json()) as { token: string };

      const res = await fetch("/api/auth/magic-link", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": token,
        },
        body: JSON.stringify({ email }),
      });

      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "Failed to send magic link");
      }

      setStatus("sent");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Unknown error");
      setStatus("error");
    }
  }

  // Google OAuth redirect — dev mock in non-production; real provider in production.
  const googleHref =
    process.env.NODE_ENV === "production" ? "/api/auth/callback/google" : "/api/dev/oauth-google";

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-8 text-center text-2xl font-bold">Admin login</h1>

        {status === "sent" ? (
          <output aria-live="polite" className="block rounded-md bg-green-50 p-4 text-green-800">
            Magic link sent! Check your email (or Mailpit at{" "}
            <a href="http://localhost:8025" className="underline">
              localhost:8025
            </a>{" "}
            in dev).
          </output>
        ) : (
          <>
            <form onSubmit={handleMagicLink} noValidate aria-label="Magic link sign-in form">
              <div className="mb-4">
                <label htmlFor="email" className="mb-1 block text-sm font-medium text-gray-700">
                  Email address
                </label>
                <input
                  id="email"
                  type="email"
                  name="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={status === "sending"}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                  aria-describedby={status === "error" ? "magic-link-error" : undefined}
                />
              </div>

              {status === "error" && (
                <div
                  id="magic-link-error"
                  role="alert"
                  aria-live="assertive"
                  className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-800"
                >
                  {errorMsg}
                </div>
              )}

              <button
                type="submit"
                disabled={status === "sending" || !email}
                className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50"
              >
                {status === "sending" ? "Sending…" : "Send magic link"}
              </button>
            </form>

            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center" aria-hidden="true">
                <div className="w-full border-t border-gray-300" />
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="bg-white px-2 text-gray-500">or</span>
              </div>
            </div>

            <a
              href={googleHref}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
            >
              {/* Inline SVG for Google G logo — no external asset fetch */}
              <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" className="h-5 w-5">
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
              Sign in with Google
            </a>
          </>
        )}
      </div>
    </main>
  );
}
