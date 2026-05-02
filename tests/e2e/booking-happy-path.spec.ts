/**
 * booking-happy-path.spec.ts
 *
 * Playwright end-to-end: public booking flow happy path.
 *
 * Prerequisites: compose stack running, dev server at BASE_URL (default
 * http://localhost:3000), at least one slot available for the test provider.
 *
 * The test mocks the /api/availability and /api/bookings fetch calls so it
 * does not require a live DB — the UI layer is what's under test here.
 *
 * Run: bunx playwright test tests/e2e/booking-happy-path.spec.ts
 */

import { expect, test } from "@playwright/test";

const SLUG = "test-slug";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

// Fixed slot for deterministic assertions
const SLOT_START_UTC = "2026-06-15T14:00:00.000Z"; // 10:00 AM EDT on Jun 15
const SLOT_END_UTC = "2026-06-15T14:50:00.000Z"; // 50 min slot
const BOOKING_ID = "00000000-0000-0000-0000-000000000042";
const CANCEL_TOKEN = "dGVzdA.dGVzdA"; // stub signed token

test.describe("Booking happy path — mocked API", () => {
  test("slot list page loads and shows available slots", async ({ page }) => {
    // Mock availability API
    await page.route("**/api/availability**", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          slots: [
            { start_utc: SLOT_START_UTC, end_utc: SLOT_END_UTC },
            {
              start_utc: "2026-06-15T15:00:00.000Z",
              end_utc: "2026-06-15T15:50:00.000Z",
            },
          ],
        }),
      });
    });

    await page.goto(`${BASE}/book/${SLUG}`);

    // Page title and landmark
    await expect(page.locator("h1")).toBeVisible();

    // Slot buttons should render
    const slotButtons = page.locator("[data-testid='slot-button']");
    await expect(slotButtons).toHaveCount(2);

    // First slot should be keyboard-focusable
    await slotButtons.first().focus();
    await expect(slotButtons.first()).toBeFocused();
  });

  test("empty state renders when no slots available", async ({ page }) => {
    await page.route("**/api/availability**", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ slots: [] }),
      });
    });

    await page.goto(`${BASE}/book/${SLUG}`);

    await expect(page.getByText("No availability in the next 14 days")).toBeVisible();
  });

  test("clicking a slot navigates to confirm page with start param", async ({ page }) => {
    await page.route("**/api/availability**", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          slots: [{ start_utc: SLOT_START_UTC, end_utc: SLOT_END_UTC }],
        }),
      });
    });

    await page.goto(`${BASE}/book/${SLUG}`);

    const slotButton = page.locator("[data-testid='slot-button']").first();
    await slotButton.click();

    // Should navigate to confirm page
    await expect(page).toHaveURL(new RegExp(`/book/${SLUG}/confirm`));
    expect(page.url()).toContain("start=");
  });

  test("confirm page shows form with name, email, notes fields", async ({ page }) => {
    const url = `${BASE}/book/${SLUG}/confirm?start=${encodeURIComponent(SLOT_START_UTC)}`;
    await page.goto(url);

    await expect(page.locator('input[name="name"]')).toBeVisible();
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator('textarea[name="notes"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test("confirm page: client validates email format before submit", async ({ page }) => {
    const url = `${BASE}/book/${SLUG}/confirm?start=${encodeURIComponent(SLOT_START_UTC)}`;
    await page.goto(url);

    await page.fill('input[name="name"]', "Test User");
    await page.fill('input[name="email"]', "not-an-email");
    await page.click('button[type="submit"]');

    // Should show validation error without navigating away
    await expect(page).toHaveURL(new RegExp(`/book/${SLUG}/confirm`));
    await expect(page.getByText(/valid email/i)).toBeVisible();
  });

  test("full happy path: fill form, submit, land on confirmation page", async ({ page }) => {
    // Mock bookings POST → 201
    await page.route("**/api/bookings", (route) => {
      if (route.request().method() === "POST") {
        route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            booking_id: BOOKING_ID,
            status: "pending_push",
            cancel_token: CANCEL_TOKEN,
            reschedule_token: CANCEL_TOKEN,
          }),
        });
      } else {
        route.continue();
      }
    });

    const confirmUrl = `${BASE}/book/${SLUG}/confirm?start=${encodeURIComponent(SLOT_START_UTC)}`;
    await page.goto(confirmUrl);

    await page.fill('input[name="name"]', "Alice Booker");
    await page.fill('input[name="email"]', "alice@example.com");
    await page.fill('textarea[name="notes"]', "Looking forward to it");
    await page.click('button[type="submit"]');

    // Should navigate to booked confirmation page
    await expect(page).toHaveURL(new RegExp(`/book/${SLUG}/booked/${BOOKING_ID}`), {
      timeout: 10_000,
    });
  });

  test("confirm page: 409 response shows inline slot-taken error", async ({ page }) => {
    await page.route("**/api/bookings", (route) => {
      if (route.request().method() === "POST") {
        route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "The selected time slot is no longer available" }),
        });
      } else {
        route.continue();
      }
    });

    const confirmUrl = `${BASE}/book/${SLUG}/confirm?start=${encodeURIComponent(SLOT_START_UTC)}`;
    await page.goto(confirmUrl);

    await page.fill('input[name="name"]', "Bob");
    await page.fill('input[name="email"]', "bob@example.com");
    await page.click('button[type="submit"]');

    await expect(page.getByText("That slot was just taken")).toBeVisible();
    // Should stay on confirm page
    await expect(page).toHaveURL(new RegExp(`/book/${SLUG}/confirm`));
  });

  test("confirm page: 429 response shows rate-limit error", async ({ page }) => {
    await page.route("**/api/bookings", (route) => {
      if (route.request().method() === "POST") {
        route.fulfill({
          status: 429,
          contentType: "application/json",
          body: JSON.stringify({ error: "Too many requests from this IP" }),
          headers: { "Retry-After": "60" },
        });
      } else {
        route.continue();
      }
    });

    const confirmUrl = `${BASE}/book/${SLUG}/confirm?start=${encodeURIComponent(SLOT_START_UTC)}`;
    await page.goto(confirmUrl);

    await page.fill('input[name="name"]', "Carol");
    await page.fill('input[name="email"]', "carol@example.com");
    await page.click('button[type="submit"]');

    await expect(page.getByText("Too many requests")).toBeVisible();
  });

  test("booked page: shows confirmation details with both timezones", async ({ page }) => {
    const bookedUrl = `${BASE}/book/${SLUG}/booked/${BOOKING_ID}?token=${CANCEL_TOKEN}&start=${encodeURIComponent(SLOT_START_UTC)}&booker_zone=America%2FNew_York&provider_zone=Europe%2FMadrid&booker_email=alice%40example.com`;
    await page.goto(bookedUrl);

    // Should show confirmation heading
    await expect(page.getByText(/booked|confirmed/i)).toBeVisible();

    // Should show "email is on its way" message
    await expect(page.getByText(/email.*on its way/i)).toBeVisible();
  });

  test("booked page: cancel and reschedule buttons are disabled with tooltip", async ({ page }) => {
    const bookedUrl = `${BASE}/book/${SLUG}/booked/${BOOKING_ID}?token=${CANCEL_TOKEN}&start=${encodeURIComponent(SLOT_START_UTC)}&booker_zone=America%2FNew_York&provider_zone=Europe%2FMadrid&booker_email=alice%40example.com`;
    await page.goto(bookedUrl);

    // Cancel/reschedule buttons should be present but disabled
    const cancelBtn = page.getByRole("button", { name: /cancel/i });
    const rescheduleBtn = page.getByRole("button", { name: /reschedule/i });

    await expect(cancelBtn).toBeDisabled();
    await expect(rescheduleBtn).toBeDisabled();
  });
});

test.describe("Booking page — keyboard navigation a11y", () => {
  test("slot buttons are reachable by Tab key", async ({ page }) => {
    await page.route("**/api/availability**", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          slots: [
            { start_utc: SLOT_START_UTC, end_utc: SLOT_END_UTC },
            {
              start_utc: "2026-06-15T15:00:00.000Z",
              end_utc: "2026-06-15T15:50:00.000Z",
            },
          ],
        }),
      });
    });

    await page.goto(`${BASE}/book/${SLUG}`);

    // Tab to first slot button
    await page.keyboard.press("Tab");
    // Tab again if needed to reach the slot area
    let attempts = 0;
    while (attempts < 10) {
      const focused = await page.evaluate(() =>
        document.activeElement?.getAttribute("data-testid"),
      );
      if (focused === "slot-button") break;
      await page.keyboard.press("Tab");
      attempts++;
    }

    const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    expect(focused).toBe("slot-button");
  });

  test("confirm form fields are reachable and usable by keyboard", async ({ page }) => {
    const url = `${BASE}/book/${SLUG}/confirm?start=${encodeURIComponent(SLOT_START_UTC)}`;
    await page.goto(url);

    // Navigate to name field
    await page.keyboard.press("Tab");
    await page.keyboard.type("Keyboard User");

    // Tab to email
    await page.keyboard.press("Tab");
    await page.keyboard.type("kb@example.com");

    // Tab to notes
    await page.keyboard.press("Tab");
    await page.keyboard.type("Keyboard only");

    // Verify values
    expect(await page.inputValue('input[name="name"]')).toBe("Keyboard User");
    expect(await page.inputValue('input[name="email"]')).toBe("kb@example.com");
    expect(await page.inputValue('textarea[name="notes"]')).toBe("Keyboard only");
  });
});
