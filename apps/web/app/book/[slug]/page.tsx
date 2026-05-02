/**
 * Public booking page — anonymous, no auth check.
 * Content (slot list, booking form) lands in Sprint 1.
 */

interface BookingPageProps {
  params: Promise<{ slug: string }>;
}

export default async function BookingPage({ params }: BookingPageProps) {
  const { slug } = await params;

  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="mb-2 text-3xl font-bold">Book a session</h1>
      <p className="mb-8 text-gray-500">Provider: {slug}</p>
      <p className="text-gray-400">Availability slots coming in Sprint 1.</p>
    </main>
  );
}
