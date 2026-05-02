/**
 * availability.test.ts — Integration tests for:
 *   GET /api/availability?slug=&from=&to=&zone=
 *   GET/POST/PATCH/DELETE /api/admin/availability-rules
 *
 * Requires a running Postgres + Next.js server.
 * Run: bun test tests/integration/availability.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Client } from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/postgres";
const BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3000";

let db: Client;
let providerId: string;
let providerSlug: string;

beforeAll(async () => {
  db = new Client({ connectionString: DATABASE_URL });
  await db.connect();

  providerSlug = `avail-test-${Date.now()}`;
  const res = await db.query<{ id: string }>(
    `insert into providers (slug, email, home_tz)
     values ($1, $2, 'America/New_York')
     returning id`,
    [providerSlug, `${providerSlug}@test.invalid`],
  );
  // biome-ignore lint/style/noNonNullAssertion: INSERT RETURNING always returns a row
  providerId = res.rows[0]!.id;
});

afterAll(async () => {
  await db.query("delete from availability_rules where provider_id = $1", [providerId]);
  await db.query("delete from providers where id = $1", [providerId]);
  await db.end();
});

// ---------------------------------------------------------------------------
// GET /api/availability
// ---------------------------------------------------------------------------
describe("GET /api/availability", () => {
  it("returns 400 when slug is missing", async () => {
    const res = await fetch(`${BASE_URL}/api/availability?from=2026-06-01&to=2026-06-15`);
    expect(res.status).toBe(400);
  });

  it("returns 404 when slug does not exist", async () => {
    const res = await fetch(
      `${BASE_URL}/api/availability?slug=nonexistent-slug-xyz&from=2026-06-01T00:00:00Z&to=2026-06-15T00:00:00Z`,
    );
    expect(res.status).toBe(404);
  });

  it("returns empty slots array when no rules exist for the provider", async () => {
    const from = "2026-06-01T00:00:00Z";
    const to = "2026-06-15T00:00:00Z";
    const res = await fetch(
      `${BASE_URL}/api/availability?slug=${providerSlug}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&zone=America/New_York`,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { slots: unknown[] };
    expect(Array.isArray(data.slots)).toBe(true);
    expect(data.slots.length).toBe(0);
  });

  it("returns slots when availability rules exist", async () => {
    // Insert a rule: Monday 10am-noon, 60min slots
    await db.query(
      `insert into availability_rules
         (provider_id, weekday, start_local, end_local, slot_minutes, buffer_minutes, valid_from, valid_to)
       values ($1, 1, '10:00', '12:00', 60, 0, '2026-01-01', '2030-12-31')`,
      [providerId],
    );

    // 2026-06-01 is a Monday
    const from = "2026-06-01T00:00:00Z";
    const to = "2026-06-08T00:00:00Z";
    const res = await fetch(
      `${BASE_URL}/api/availability?slug=${providerSlug}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&zone=America/New_York`,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { slots: Array<{ start_utc: string; end_utc: string }> };
    expect(Array.isArray(data.slots)).toBe(true);
    // Should have slots for Monday (June 1 2026 is a Monday)
    expect(data.slots.length).toBeGreaterThan(0);
    // Verify slot shape: start_utc, end_utc
    for (const slot of data.slots) {
      expect(slot.start_utc).toBeTruthy();
      expect(slot.end_utc).toBeTruthy();
      // No booking_id leakage
      expect((slot as Record<string, unknown>).booking_id).toBeUndefined();
    }

    // Cleanup
    await db.query("delete from availability_rules where provider_id = $1", [providerId]);
  });
});

// ---------------------------------------------------------------------------
// Admin availability-rules CRUD
// ---------------------------------------------------------------------------
describe("GET /api/admin/availability-rules", () => {
  it("returns 401 without auth", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/availability-rules?provider_id=${providerId}`);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/admin/availability-rules", () => {
  it("returns 401 without auth", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/availability-rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});
