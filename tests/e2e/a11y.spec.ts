/**
 * Accessibility smoke tests — axe-core via @axe-core/playwright.
 *
 * Gate: zero serious or critical violations on each tested route.
 * These replace the axe-stub CI job from #5.
 *
 * Routes tested:
 *   - / (landing)
 *   - /book/test-slug (public booking page — anonymous)
 *   - /admin/login (login page — must be accessible unauthenticated)
 */

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const ROUTES = [
  { path: "/", label: "landing" },
  { path: "/book/test-slug", label: "booking page" },
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
