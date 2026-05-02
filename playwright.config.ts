import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration.
 * Axe a11y smoke tests run against the Next.js dev server.
 * Zero serious/critical violations is the CI gate (see tests/e2e/a11y.spec.ts).
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"], ["html", { outputFolder: "tests/e2e/playwright-report", open: "never" }]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.CI
    ? {
        command: "bun --bun run dev",
        cwd: "apps/web",
        url: "http://localhost:3000",
        reuseExistingServer: false,
        timeout: 60_000,
        env: {
          NODE_ENV: "test",
          // Stub values — no real Supabase needed for a11y smoke tests
          NEXT_PUBLIC_SUPABASE_URL: "http://localhost:9999",
          NEXT_PUBLIC_SUPABASE_ANON_KEY: "stub-anon-key",
        },
      }
    : undefined,
});
