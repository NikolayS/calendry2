/**
 * Integration tests: schema v1 constraint verification.
 *
 * These tests require a running Postgres instance (compose stack).
 * Run: docker compose -f ops/docker-compose.yml up -d postgres && bun test tests/integration/schema.test.ts
 *
 * TDD note: these tests were written BEFORE the migrations existed.
 * They go red on an empty DB and green once all migrations are deployed.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Client } from "pg";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/postgres";

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

// ---------------------------------------------------------------------------
// Test 1: exclusion constraint on availability_rules
// Two overlapping windows for same provider+weekday must be rejected.
// ---------------------------------------------------------------------------
describe("availability_rules exclusion constraint", () => {
  it("rejects overlapping windows for same provider+weekday", async () => {
    // Insert a throwaway provider
    const providerRes = await client.query(`
      insert into providers (slug, email, home_tz)
      values ('test-overlap-provider', 'overlap@test.invalid', 'America/New_York')
      returning id
    `);
    const providerId = providerRes.rows[0].id as string;

    // First rule: valid 2026-01-01 to 2026-12-31, Monday (weekday=1)
    await client.query(`
      insert into availability_rules
        (provider_id, weekday, start_local, end_local, slot_minutes, buffer_minutes, valid_from, valid_to)
      values ($1, 1, '09:00', '17:00', 60, 10, '2026-01-01', '2026-12-31')
    `, [providerId]);

    // Second rule: overlapping window same provider+weekday — must fail
    await expect(
      client.query(`
        insert into availability_rules
          (provider_id, weekday, start_local, end_local, slot_minutes, buffer_minutes, valid_from, valid_to)
        values ($1, 1, '10:00', '18:00', 60, 10, '2026-06-01', '2026-12-31')
      `, [providerId]),
    ).rejects.toThrow();

    // Cleanup
    await client.query("delete from availability_rules where provider_id = $1", [providerId]);
    await client.query("delete from providers where id = $1", [providerId]);
  });
});

// ---------------------------------------------------------------------------
// Test 2: bookings.state CHECK constraint
// Invalid state values must be rejected.
// ---------------------------------------------------------------------------
describe("bookings state CHECK constraint", () => {
  it("rejects invalid state value", async () => {
    const providerRes = await client.query(`
      insert into providers (slug, email, home_tz)
      values ('test-state-provider', 'state@test.invalid', 'UTC')
      returning id
    `);
    const providerId = providerRes.rows[0].id as string;

    await expect(
      client.query(`
        insert into bookings
          (provider_id, booker_email, booker_name, start_utc, end_utc, state, idempotency_key)
        values ($1, 'booker@test.invalid', 'Test Booker',
                now(), now() + interval '1 hour',
                'invalid_state', 'test-idempotency-key-state')
      `, [providerId]),
    ).rejects.toThrow();

    // Cleanup
    await client.query("delete from providers where id = $1", [providerId]);
  });
});

// ---------------------------------------------------------------------------
// Test 3: idempotency_keys unique constraint on (key, kind)
// Duplicate (key, kind) pairs must be rejected.
// ---------------------------------------------------------------------------
describe("idempotency_keys uniqueness", () => {
  it("rejects duplicate (key, kind) pair", async () => {
    const key = "test-idempotency-key-" + Date.now();

    await client.query(`
      insert into idempotency_keys (key, kind, result_json)
      values ($1, 'google_push', '{"status":"ok"}')
    `, [key]);

    await expect(
      client.query(`
        insert into idempotency_keys (key, kind, result_json)
        values ($1, 'google_push', '{"status":"ok"}')
      `, [key]),
    ).rejects.toThrow();

    // Cleanup
    await client.query("delete from idempotency_keys where key = $1", [key]);
  });
});
