/**
 * @calendry/db — Supabase Postgres client and typed query helpers.
 *
 * Exports:
 *   createSupabaseClient  — Supabase JS client (admin/service-role)
 *   createPgClient        — raw pg.Client for migrations and integration tests
 *   Types for every schema-v1 table
 *   Minimal typed query helpers for tables that sprint code writes against
 */

import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { Pool, type PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Database type definitions (hand-written; matches schema v1 migrations)
// ---------------------------------------------------------------------------

/** booking.state valid values (mirrors the CHECK constraint in deploy/bookings.sql) */
export type BookingState =
  | "pending_push"
  | "confirmed"
  | "cancelled"
  | "rescheduled"
  | "conflicted";

/** provider.oauth_status valid values */
export type OauthStatus = "connected" | "degraded" | "revoked";

/** email_outbox.kind valid values */
export type EmailKind =
  | "confirmation"
  | "reminder"
  | "cancellation"
  | "reschedule"
  | "conflict_notification";

/** busy_blocks.source valid values */
export type BusyBlockSource = "google" | "booking" | "manual";

export interface Provider {
  id: string; // uuid
  slug: string;
  email: string;
  home_tz: string;
  google_oauth_refresh_token: string | null;
  oauth_status: OauthStatus;
  created_at: string; // timestamptz (ISO-8601 string from JS client)
  updated_at: string;
}

export interface AvailabilityRule {
  id: number;
  provider_id: string;
  weekday: number; // 0 = Sunday … 6 = Saturday
  start_local: string; // time "HH:MM:SS"
  end_local: string;
  slot_minutes: number;
  buffer_minutes: number;
  valid_from: string; // date "YYYY-MM-DD"
  valid_to: string;
  created_at: string;
  updated_at: string;
}

export interface ManualBlackout {
  id: number;
  provider_id: string;
  start_utc: string;
  end_utc: string;
  reason: string | null;
  created_at: string;
}

export interface Booking {
  id: string; // uuid
  provider_id: string;
  booker_email: string;
  booker_name: string;
  booker_notes: string | null;
  start_utc: string;
  end_utc: string;
  state: BookingState;
  google_event_id: string | null;
  idempotency_key: string;
  rescheduled_from: string | null;
  reschedule_sequence: number;
  created_at: string;
  updated_at: string;
}

export interface SyncChannel {
  id: number;
  provider_id: string;
  channel_id: string;
  channel_token: string;
  resource_id: string;
  sync_token: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface BusyBlock {
  id: number;
  provider_id: string;
  start_utc: string;
  end_utc: string;
  source: BusyBlockSource;
  source_id: string;
  created_at: string;
  updated_at: string;
}

export interface IdempotencyKey {
  id: number;
  key: string;
  kind: string;
  result_json: Record<string, unknown> | null;
  created_at: string;
}

export interface EmailOutbox {
  id: number;
  booking_id: string | null;
  kind: EmailKind;
  recipient_email: string;
  send_after: string;
  sent_at: string | null;
  last_error: string | null;
  attempt_count: number;
  idempotency_key: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Database schema type map (used by createClient generic parameter)
// ---------------------------------------------------------------------------

export interface Database {
  public: {
    Tables: {
      providers: {
        Row: Provider;
        Insert: Omit<Provider, "id" | "created_at" | "updated_at">;
        Update: Partial<Provider>;
      };
      availability_rules: {
        Row: AvailabilityRule;
        Insert: Omit<AvailabilityRule, "id" | "created_at" | "updated_at">;
        Update: Partial<AvailabilityRule>;
      };
      manual_blackouts: {
        Row: ManualBlackout;
        Insert: Omit<ManualBlackout, "id" | "created_at">;
        Update: Partial<ManualBlackout>;
      };
      bookings: {
        Row: Booking;
        Insert: Omit<Booking, "created_at" | "updated_at">;
        Update: Partial<Booking>;
      };
      sync_channels: {
        Row: SyncChannel;
        Insert: Omit<SyncChannel, "id" | "created_at" | "updated_at">;
        Update: Partial<SyncChannel>;
      };
      busy_blocks: {
        Row: BusyBlock;
        Insert: Omit<BusyBlock, "id" | "created_at" | "updated_at">;
        Update: Partial<BusyBlock>;
      };
      idempotency_keys: {
        Row: IdempotencyKey;
        Insert: Omit<IdempotencyKey, "id" | "created_at">;
        Update: Partial<IdempotencyKey>;
      };
      email_outbox: {
        Row: EmailOutbox;
        Insert: Omit<EmailOutbox, "id" | "created_at">;
        Update: Partial<EmailOutbox>;
      };
    };
  };
}

// ---------------------------------------------------------------------------
// Supabase JS client (service-role — used in server-side/worker code only)
// ---------------------------------------------------------------------------

/**
 * Create a typed Supabase JS client.
 *
 * Pass NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from env.
 * Never expose the service-role key to client-side bundles.
 */
export function createSupabaseClient(
  supabaseUrl: string,
  supabaseKey: string,
): SupabaseClient<Database> {
  return createClient<Database>(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// Raw pg connection pool (used for migrations, integration tests, raw queries)
// ---------------------------------------------------------------------------

let _pool: Pool | null = null;

/**
 * Return the shared pg connection pool, creating it on first call.
 * Reads DATABASE_URL from environment if no connectionString is provided.
 */
export function getPool(connectionString?: string): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: connectionString ?? process.env.DATABASE_URL,
    });
  }
  return _pool;
}

/** Borrow a client from the shared pool for a single transaction. */
export async function withClient<T>(
  fn: (client: PoolClient) => Promise<T>,
  connectionString?: string,
): Promise<T> {
  const client = await getPool(connectionString).connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Typed query helpers
// ---------------------------------------------------------------------------

/** Fetch the active busy blocks for a provider within a UTC time window. */
export async function getBusyBlocks(
  providerId: string,
  fromUtc: Date,
  toUtc: Date,
  connectionString?: string,
): Promise<BusyBlock[]> {
  const pool = getPool(connectionString);
  const { rows } = await pool.query<BusyBlock>(
    `select * from busy_blocks
     where provider_id = $1
       and start_utc < $3
       and end_utc   > $2
     order by start_utc`,
    [providerId, fromUtc.toISOString(), toUtc.toISOString()],
  );
  return rows;
}

/** Fetch active (non-terminal) bookings for a provider in a UTC window. */
export async function getActiveBookings(
  providerId: string,
  fromUtc: Date,
  toUtc: Date,
  connectionString?: string,
): Promise<Booking[]> {
  const pool = getPool(connectionString);
  const { rows } = await pool.query<Booking>(
    `select * from bookings
     where provider_id = $1
       and start_utc < $3
       and end_utc   > $2
       and state not in ('cancelled', 'rescheduled')
     order by start_utc`,
    [providerId, fromUtc.toISOString(), toUtc.toISOString()],
  );
  return rows;
}

/** Look up a pending email outbox row by idempotency key. */
export async function getIdempotencyKey(
  key: string,
  kind: string,
  connectionString?: string,
): Promise<IdempotencyKey | null> {
  const pool = getPool(connectionString);
  const { rows } = await pool.query<IdempotencyKey>(
    "select * from idempotency_keys where key = $1 and kind = $2 limit 1",
    [key, kind],
  );
  return rows[0] ?? null;
}

/** Mark an email outbox row as sent. */
export async function markEmailSent(id: number, connectionString?: string): Promise<void> {
  const pool = getPool(connectionString);
  await pool.query("update email_outbox set sent_at = now() where id = $1", [id]);
}

/** Fetch the sync channel for a provider (null if not yet registered). */
export async function getSyncChannel(
  providerId: string,
  connectionString?: string,
): Promise<SyncChannel | null> {
  const pool = getPool(connectionString);
  const { rows } = await pool.query<SyncChannel>(
    "select * from sync_channels where provider_id = $1 order by created_at desc limit 1",
    [providerId],
  );
  return rows[0] ?? null;
}
