export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <div className="max-w-xl text-center">
        <h1 className="mb-4 text-4xl font-bold tracking-tight">Calendry</h1>
        <p className="text-lg text-gray-600">
          Self-hostable, open-source booking page. Availability and booking coming in Sprint 1.
        </p>
        <nav aria-label="Main navigation" className="mt-8">
          <a
            href="/admin/login"
            className="inline-block rounded-md bg-blue-600 px-6 py-2 text-white hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            Admin login
          </a>
        </nav>
      </div>
    </main>
  );
}
