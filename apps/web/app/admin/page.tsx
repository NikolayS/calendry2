/**
 * Admin dashboard — protected.
 * The middleware (middleware.ts) redirects unauthenticated requests to
 * /admin/login?next=/admin before this component ever renders.
 * Content lands in Sprint 2.
 */

export default function AdminPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-16">
      <h1 className="mb-4 text-3xl font-bold">Admin dashboard</h1>
      <p className="text-gray-500">
        Availability rules and bookings management coming in Sprint 2.
      </p>
    </main>
  );
}
