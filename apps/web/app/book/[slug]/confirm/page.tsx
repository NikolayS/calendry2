"use client";

/**
 * /book/[slug]/confirm?start=<utc>&zone=<iana>
 *
 * Booking form — client component so we can handle form state, inline
 * errors, and the redirect after 201.
 *
 * Anonymous (no auth). CSRF-exempt (per middleware + SPEC amendment).
 * Rate-limited server-side (handled by /api/bookings).
 */

import { DateTime } from "luxon";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useId, useRef, useState } from "react";
import { formatSlot } from "../../../../lib/booking-ui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FormState {
  submitting: boolean;
  error: string | null;
  fieldErrors: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Slot summary (shown above the form)
// ---------------------------------------------------------------------------

function SlotSummary({ startUtc, zone }: { startUtc: string; zone: string }) {
  const dt = DateTime.fromISO(startUtc, { zone });
  if (!dt.isValid) return null;

  const formatted = formatSlot({
    start_utc: startUtc,
    end_utc: dt.plus({ minutes: 60 }).toISO() ?? startUtc, // fallback; real end shown post-booking
    zone,
  });

  return (
    <div
      className="mb-6 rounded-lg border border-indigo-100 bg-indigo-50 px-4 py-3"
      aria-label="Selected slot"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-indigo-500">
        Your selected slot
      </p>
      <p className="mt-1 text-sm font-medium text-indigo-900">{formatted}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form field helpers
// ---------------------------------------------------------------------------

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1 text-xs text-red-600">
      {message}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Client validation
// ---------------------------------------------------------------------------

function validateForm(name: string, email: string): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!name.trim()) errors.name = "Your name is required.";
  if (!email.trim()) {
    errors.email = "Your email address is required.";
  } else if (!isValidEmail(email)) {
    errors.email = "Please enter a valid email address.";
  }
  return errors;
}

function isValidEmail(email: string): boolean {
  // RFC 5322 rough check — server is source of truth.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// ---------------------------------------------------------------------------
// Booking form
// ---------------------------------------------------------------------------

function BookingForm({ slug, startUtc, zone }: { slug: string; startUtc: string; zone: string }) {
  const router = useRouter();
  const nameId = useId();
  const emailId = useId();
  const notesId = useId();
  const nameErrId = `${nameId}-err`;
  const emailErrId = `${emailId}-err`;

  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  const [state, setState] = useState<FormState>({
    submitting: false,
    error: null,
    fieldErrors: {},
  });

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const name = nameRef.current?.value ?? "";
    const email = emailRef.current?.value ?? "";
    const notes = notesRef.current?.value ?? "";

    // Client-side validation
    const fieldErrors = validateForm(name, email);
    if (Object.keys(fieldErrors).length > 0) {
      setState({ submitting: false, error: null, fieldErrors });
      // Focus first error field
      if (fieldErrors.name) nameRef.current?.focus();
      else if (fieldErrors.email) emailRef.current?.focus();
      return;
    }

    setState({ submitting: true, error: null, fieldErrors: {} });

    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          start_utc: startUtc,
          booker_name: name,
          booker_email: email,
          booker_notes: notes || undefined,
        }),
      });

      if (res.status === 201 || res.status === 200) {
        const data = (await res.json()) as {
          booking_id: string;
          cancel_token: string;
          reschedule_token: string;
        };
        // Redirect to confirmation screen with cancel token
        const params = new URLSearchParams({
          token: data.cancel_token,
          start: startUtc,
          booker_zone: zone,
          booker_email: email,
        });
        router.push(`/book/${slug}/booked/${data.booking_id}?${params.toString()}`);
        return;
      }

      if (res.status === 409) {
        setState({
          submitting: false,
          error: "That slot was just taken. Please pick another time.",
          fieldErrors: {},
        });
        return;
      }

      if (res.status === 429) {
        setState({
          submitting: false,
          error: "Too many requests. Try again in a minute.",
          fieldErrors: {},
        });
        return;
      }

      // Other server errors
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setState({
        submitting: false,
        error: data.error ?? "Something went wrong. Please try again.",
        fieldErrors: {},
      });
    } catch {
      setState({
        submitting: false,
        error: "Network error. Please check your connection and try again.",
        fieldErrors: {},
      });
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate aria-label="Booking form">
      {/* Global inline error */}
      {state.error && (
        <div
          role="alert"
          aria-live="assertive"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {state.error}
          {state.error.includes("slot was just taken") && (
            <>
              {" "}
              <a href={`/book/${slug}`} className="font-semibold underline hover:text-red-900">
                Back to slot list
              </a>
            </>
          )}
        </div>
      )}

      {/* Name */}
      <div className="mb-4">
        <label htmlFor={nameId} className="mb-1 block text-sm font-medium text-gray-700">
          Your name{" "}
          <span aria-hidden="true" className="text-red-500">
            *
          </span>
        </label>
        <input
          ref={nameRef}
          id={nameId}
          name="name"
          type="text"
          autoComplete="name"
          required
          aria-required="true"
          aria-describedby={state.fieldErrors.name ? nameErrId : undefined}
          aria-invalid={!!state.fieldErrors.name}
          className={`block w-full rounded-lg border px-3 py-2 text-sm shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 ${
            state.fieldErrors.name ? "border-red-400 bg-red-50" : "border-gray-300 bg-white"
          }`}
        />
        <FieldError id={nameErrId} message={state.fieldErrors.name} />
      </div>

      {/* Email */}
      <div className="mb-4">
        <label htmlFor={emailId} className="mb-1 block text-sm font-medium text-gray-700">
          Email address{" "}
          <span aria-hidden="true" className="text-red-500">
            *
          </span>
        </label>
        <input
          ref={emailRef}
          id={emailId}
          name="email"
          type="email"
          autoComplete="email"
          required
          aria-required="true"
          aria-describedby={state.fieldErrors.email ? emailErrId : undefined}
          aria-invalid={!!state.fieldErrors.email}
          className={`block w-full rounded-lg border px-3 py-2 text-sm shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 ${
            state.fieldErrors.email ? "border-red-400 bg-red-50" : "border-gray-300 bg-white"
          }`}
        />
        <FieldError id={emailErrId} message={state.fieldErrors.email} />
      </div>

      {/* Notes (optional) */}
      <div className="mb-6">
        <label htmlFor={notesId} className="mb-1 block text-sm font-medium text-gray-700">
          Notes <span className="text-xs font-normal text-gray-400">(optional)</span>
        </label>
        <textarea
          ref={notesRef}
          id={notesId}
          name="notes"
          rows={3}
          autoComplete="off"
          className="block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1"
          placeholder="Anything you'd like the provider to know in advance…"
        />
      </div>

      {/* Submit */}
      <button
        type="submit"
        disabled={state.submitting}
        aria-disabled={state.submitting}
        className="w-full rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {state.submitting ? "Confirming…" : "Confirm booking"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Page wrapper — reads URL params and renders the form
// ---------------------------------------------------------------------------

function ConfirmContent({ slug }: { slug: string }) {
  const searchParams = useSearchParams();
  const startUtc = searchParams.get("start") ?? "";
  const zone = searchParams.get("zone") ?? "UTC";

  if (!startUtc) {
    return (
      <main className="mx-auto max-w-lg px-4 py-16">
        <h1 className="mb-4 text-3xl font-bold text-gray-900">Invalid link</h1>
        <p className="text-gray-500">
          No time slot was specified. Please{" "}
          <a href={`/book/${slug}`} className="text-indigo-600 underline">
            go back and select a slot
          </a>
          .
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-lg px-4 py-16" id="main-content">
      <header className="mb-8">
        <nav aria-label="Breadcrumb" className="mb-4">
          <a
            href={`/book/${slug}`}
            className="text-sm text-indigo-600 underline hover:text-indigo-800"
            aria-label="Back to slot list"
          >
            ← Back to available slots
          </a>
        </nav>
        <h1 className="text-3xl font-bold text-gray-900">Confirm your booking</h1>
        <p className="mt-2 text-sm text-gray-500">
          Fill in your details to complete the reservation.
        </p>
      </header>

      <SlotSummary startUtc={startUtc} zone={zone} />
      <BookingForm slug={slug} startUtc={startUtc} zone={zone} />
    </main>
  );
}

interface ConfirmPageProps {
  params: Promise<{ slug: string }>;
}

export default function ConfirmPage({ params }: ConfirmPageProps) {
  // params is a Promise in Next.js 15 — unwrap it. We use a state trick to
  // read the slug synchronously via useSearchParams' sibling pattern.
  // WHY Suspense: useSearchParams() requires a Suspense boundary in Next.js 15
  // when used in a client component at the page level.
  const [slugState] = useState(() => {
    // biome-ignore lint/suspicious/noExplicitAny: params is the Next.js prop
    return (params as any).slug ?? "unknown";
  });

  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-lg px-4 py-16">
          <p className="text-gray-400">Loading…</p>
        </main>
      }
    >
      <ConfirmContent slug={slugState} />
    </Suspense>
  );
}
