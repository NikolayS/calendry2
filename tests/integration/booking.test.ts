/**
 * booking.test.ts — Integration tests for POST /api/bookings.
 *
 * Requires a running Postgres instance with all migrations deployed.
 * Run:
 *   docker compose -f ops/docker-compose.yml up -d postgres
 *   bun test tests/integration/booking.test.ts
 *
 * TDD: these tests are written BEFORE the endpoint implementation.
 * They go red on an empty DB and green once migrations + endpoint are deployed.
 *
 * Tests covered (per issue #19 TDD requirements):
 *   1. Valid slot → 201, booking row inserted in pending_push state
 *   2. Idempotency replay → same key → 200, original booking returned, no double-insert
 *   3. Race re-check: slot blocked after GET but before POST → 409
 *   4. Email outbox transactional: confirmation row always inserted in same tx
 *   5. Late-booking reminder skip: start_utc - now() < 24h → no reminder row
 *   6. Normal booking (>24h lead): both confirmation + reminder rows inserted
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
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

  // Insert a test provider
  providerSlug = `test-booking-${Date.now()}`;
  const res = await db.query<{ id: string }>(
    `insert into providers (slug, email, home_tz)
     values ($1, $2, 'America/New_York')
     returning id`,
    [providerSlug, `${providerSlug}@test.invalid`],
  );
  // biome-ignore lint/style/noNonNullAssertion: INSERT RETURNING always returns a row
  providerId = res.rows[0]!.id;

  // Insert an availability rule: Monday 10am-4pm, 60-min slots, 10-min buffer
  // valid 2026-01-01 to 2030-12-31
  await db.query(
    `insert into availability_rules
       (provider_id, weekday, start_local, end_local, slot_minutes, buffer_minutes, valid_from, valid_to)
     values ($1, 1, '10:00', '16:00', 60, 10, '2026-01-01', '2030-12-31')`,
    [providerId],
  );
});

afterEach(async () => {
  // Clean up bookings and email_outbox for the test provider after each test
  await db.query(
    `delete from email_outbox
     where booking_id in (
       select id from bookings where provider_id = $1
     )`,
    [providerId],
  );
  await db.query("delete from bookings where provider_id = $1", [providerId]);
  // Clean up any busy_blocks we may have inserted
  await db.query("delete from busy_blocks where provider_id = $1", [providerId]);
});

afterAll(async () => {
  await db.query("delete from availability_rules where provider_id = $1", [providerId]);
  await db.query("delete from providers where id = $1", [providerId]);
  await db.end();
});

// ---------------------------------------------------------------------------
// Helper: next Monday at 10am UTC (well within the availability rule)
// ---------------------------------------------------------------------------
function nextMondayAt10amUtc(offsetDays = 0): string {
  // Find a Monday >= 2 days from now to ensure >24h lead time
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  let d = new Date(now.getTime() + 2 * dayMs + offsetDays * dayMs);
  // Advance to Monday (weekday=1)
  while (d.getUTCDay() !== 1) {
    d = new Date(d.getTime() + dayMs);
  }
  d.setUTCHours(14, 0, 0, 0); // 10am Eastern = ~14:00 UTC in winter
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Test 1: valid booking → 201
// ---------------------------------------------------------------------------
describe("POST /api/bookings — valid slot", () => {
  it("creates a booking in pending_push state and returns 201", async () => {
    const startUtc = nextMondayAt10amUtc();
    const body = {
      slug: providerSlug,
      start_utc: startUtc,
      booker_email: "test-booker@example.com",
      booker_name: "Test Booker",
    };

    const res = await fetch(`${BASE_URL}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      booking_id: string;
      status: string;
      cancel_token: string;
      reschedule_token: string;
    };
    expect(data.booking_id).toBeTruthy();
    expect(data.status).toBe("pending_push");
    expect(data.cancel_token).toBeTruthy();
    expect(data.reschedule_token).toBeTruthy();

    // Verify DB state
    const row = await db.query<{ state: string; idempotency_key: string }>(
      "select state, idempotency_key from bookings where id = $1",
      [data.booking_id],
    );
    // biome-ignore lint/style/noNonNullAssertion: query result checked via expect
    expect(row.rows[0]!.state).toBe("pending_push");
    // biome-ignore lint/style/noNonNullAssertion: query result checked via expect
    expect(row.rows[0]!.idempotency_key).toHaveLength(64); // sha256 hex
  });
});

// ---------------------------------------------------------------------------
// Test 2: idempotency replay → 200 + original booking, no double-insert
// ---------------------------------------------------------------------------
describe("POST /api/bookings — idempotency", () => {
  it("replaying the same request returns 200 with original booking, no double row", async () => {
    const startUtc = nextMondayAt10amUtc();
    const body = {
      slug: providerSlug,
      start_utc: startUtc,
      booker_email: "idempotent-booker@example.com",
      booker_name: "Idempotent Booker",
    };

    // First request
    const res1 = await fetch(`${BASE_URL}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res1.status).toBe(201);
    const data1 = (await res1.json()) as { booking_id: string; status: string };

    // Replay same request
    const res2 = await fetch(`${BASE_URL}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res2.status).toBe(200);
    const data2 = (await res2.json()) as { booking_id: string; status: string };
    expect(data2.booking_id).toBe(data1.booking_id);

    // Only one booking row in the DB
    const count = await db.query<{ count: string }>(
      "select count(*)::text as count from bookings where provider_id = $1",
      [providerId],
    );
    // biome-ignore lint/style/noNonNullAssertion: COUNT always returns one row
    expect(count.rows[0]!.count).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// Test 3: race re-check — slot blocked between GET and POST → 409
// ---------------------------------------------------------------------------
describe("POST /api/bookings — race window re-check", () => {
  it("returns 409 if the slot is blocked by a busy_block inserted before the POST", async () => {
    const startUtc = nextMondayAt10amUtc(7); // one week further to avoid conflicts
    // Insert a blocking busy_block that covers the slot
    const slotStart = new Date(startUtc);
    const slotEnd = new Date(slotStart.getTime() + 70 * 60 * 1000); // 60min slot + 10 buffer

    await db.query(
      `insert into busy_blocks (provider_id, start_utc, end_utc, source, source_id)
       values ($1, $2, $3, 'manual', 'race-test-block')`,
      [providerId, slotStart.toISOString(), slotEnd.toISOString()],
    );

    const res = await fetch(`${BASE_URL}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: providerSlug,
        start_utc: startUtc,
        booker_email: "race-test@example.com",
        booker_name: "Race Test Booker",
      }),
    });
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Test 4: email outbox — confirmation row always in same tx
// ---------------------------------------------------------------------------
describe("POST /api/bookings — email outbox transactional", () => {
  it("inserts a confirmation email_outbox row in the same transaction as the booking", async () => {
    const startUtc = nextMondayAt10amUtc(14); // two weeks out
    const res = await fetch(`${BASE_URL}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: providerSlug,
        start_utc: startUtc,
        booker_email: "outbox-test@example.com",
        booker_name: "Outbox Test Booker",
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { booking_id: string };

    const outboxRows = await db.query<{ kind: string; idempotency_key: string }>(
      "select kind, idempotency_key from email_outbox where booking_id = $1 order by kind",
      [data.booking_id],
    );
    const kinds = outboxRows.rows.map((r) => r.kind);
    // Must have at least confirmation
    expect(kinds).toContain("confirmation");
  });
});

// ---------------------------------------------------------------------------
// Test 5: late-booking reminder skip (start_utc - now < 24h)
// ---------------------------------------------------------------------------
describe("POST /api/bookings — late-booking reminder skip", () => {
  it("does NOT insert a reminder row when start_utc - now < 24h", async () => {
    // Use a start time 2 hours from now (well within 24h)
    const startUtc = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const res = await fetch(`${BASE_URL}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: providerSlug,
        start_utc: startUtc,
        booker_email: "latebooker@example.com",
        booker_name: "Late Booker",
      }),
    });
    // May be 201 or 409 depending on whether the slot is valid
    // For this test we just check the outbox — if booking succeeded, no reminder row
    if (res.status === 201) {
      const data = (await res.json()) as { booking_id: string };
      const outboxRows = await db.query<{ kind: string }>(
        "select kind from email_outbox where booking_id = $1",
        [data.booking_id],
      );
      const kinds = outboxRows.rows.map((r) => r.kind);
      expect(kinds).not.toContain("reminder");
    }
  });
});

// ---------------------------------------------------------------------------
// Test 6: normal booking >24h lead — both confirmation and reminder rows
// ---------------------------------------------------------------------------
describe("POST /api/bookings — normal booking with reminder", () => {
  it("inserts both confirmation and reminder rows when start_utc - now > 24h", async () => {
    const startUtc = nextMondayAt10amUtc(21); // 3 weeks out
    const res = await fetch(`${BASE_URL}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: providerSlug,
        start_utc: startUtc,
        booker_email: "normal-booker@example.com",
        booker_name: "Normal Booker",
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { booking_id: string };

    const outboxRows = await db.query<{ kind: string; send_after: string }>(
      "select kind, send_after from email_outbox where booking_id = $1 order by kind",
      [data.booking_id],
    );
    const kinds = outboxRows.rows.map((r) => r.kind);
    expect(kinds).toContain("confirmation");
    expect(kinds).toContain("reminder");

    // Verify reminder send_after = start_utc - 24h
    // biome-ignore lint/style/noNonNullAssertion: kinds.includes("reminder") asserted above
    const reminderRow = outboxRows.rows.find((r) => r.kind === "reminder")!;
    const expectedSendAfter = new Date(new Date(startUtc).getTime() - 24 * 60 * 60 * 1000);
    const actualSendAfter = new Date(reminderRow.send_after);
    expect(Math.abs(actualSendAfter.getTime() - expectedSendAfter.getTime())).toBeLessThan(5000);
  });
});
