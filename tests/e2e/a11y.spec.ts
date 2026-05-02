/**
 * Accessibility smoke tests — axe-core via @axe-core/playwright.
 *
 * Gate: zero serious or critical violations on each tested route.
 * These replace the axe-stub CI job from #5.
 *
 * Routes tested:
 *   - / (landing)
 *   - /book/test-slug (public booking page — anonymous)
 *   - /book/test-slug/confirm?start=… (booking form)
 *   - /book/test-slug/booked/test-id?token=… (confirmation screen)
 *   - /admin/login (login page — must be accessible unauthenticated)
 */

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const SLOT_START = encodeURIComponent("2026-06-15T14:00:00.000Z");
const STUB_TOKEN = "dGVzdA.dGVzdA";

const ROUTES = [
  { path: "/", label: "landing" },
  { path: "/book/test-slug", label: "booking page" },
  {
    path: `/book/test-slug/confirm?start=${SLOT_START}&zone=America%2FNew_York`,
    label: "booking confirm form",
  },
  {
    path: `/book/test-slug/booked/00000000-0000-0000-0000-000000000001?token=${STUB_TOKEN}&start=${SLOT_START}&booker_zone=America%2FNew_York&provider_zone=Europe%2FMadrid&booker_email=test%40example.com`,
    label: "booking confirmation screen",
  },
  { path: "/admin/login", label: "admin login" },
];

for (const { path, label } of ROUTES) {
  test(`a11y: ${label} (${path}) — zero serious/critical violations`, async ({ page }) => {
    await page.goto(path);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const serious = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );

    if (serious.length > 0) {
      // Print details to help debugging
      for (const v of serious) {
        console.error(`[axe] ${v.impact?.toUpperCase()} — ${v.id}: ${v.description}`);
        for (const node of v.nodes) {
          console.error(`  target: ${node.target.join(", ")}`);
        }
      }
    }

    expect(serious, `${serious.length} serious/critical a11y violation(s) on ${path}`).toHaveLength(
      0,
    );
  });
}
