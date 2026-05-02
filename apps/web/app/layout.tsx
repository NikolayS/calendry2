import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Calendry",
  description: "Self-hostable booking page",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
