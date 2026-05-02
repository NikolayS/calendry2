/**
 * GET  /api/admin/availability-rules?provider_id=
 * POST /api/admin/availability-rules
 *
 * Admin-protected (CSRF + auth-guard via middleware; auth re-checked here for 401 on API calls).
 *
 * POST body:
 *   {
 *     provider_id:    string (uuid)
 *     weekday:        number (0=Sun..6=Sat)
 *     start_local:    string ("HH:MM")
 *     end_local:      string ("HH:MM")
 *     slot_minutes:   number
 *     buffer_minutes: number (default 0)
 *     valid_from:     string ("YYYY-MM-DD")
 *     valid_to:       string ("YYYY-MM-DD")
 *   }
 *
 * On overlap (exclusion constraint violation) → HTTP 409.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getPool } from "../../../../../../packages/db/index";
import type { AvailabilityRule } from "../../../../../../packages/db/index";
import { requireAdminSession } from "../../../../lib/admin-auth";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// GET — list provider's rules
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest): Promise<NextResponse> {
  const authErr = requireAdminSession(req);
  if (authErr) return authErr;

  const providerId = req.nextUrl.searchParams.get("provider_id");
  if (!providerId) {
    return NextResponse.json({ error: "provider_id is required" }, { status: 400 });
  }

  const pool = getPool();
  const { rows } = await pool.query<AvailabilityRule>(
    "select * from availability_rules where provider_id = $1 order by weekday, start_local",
    [providerId],
  );
  return NextResponse.json({ rules: rows });
}

// ---------------------------------------------------------------------------
// POST — create a rule
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest): Promise<NextResponse> {
  const authErr = requireAdminSession(req);
  if (authErr) return authErr;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validated = validateRuleBody(body);
  if ("error" in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  const {
    provider_id,
    weekday,
    start_local,
    end_local,
    slot_minutes,
    buffer_minutes,
    valid_from,
    valid_to,
  } = validated;

  const pool = getPool();
  try {
    const { rows } = await pool.query<AvailabilityRule>(
      `insert into availability_rules
         (provider_id, weekday, start_local, end_local, slot_minutes, buffer_minutes, valid_from, valid_to)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning *`,
      [
        provider_id,
        weekday,
        start_local,
        end_local,
        slot_minutes,
        buffer_minutes,
        valid_from,
        valid_to,
      ],
    );
    return NextResponse.json({ rule: rows[0] }, { status: 201 });
  } catch (err: unknown) {
    // Exclusion constraint violation: PG error code 23P01
    if (isPostgresError(err) && (err.code === "23P01" || err.code === "23505")) {
      return NextResponse.json(
        { error: "Overlapping availability rule exists for this provider/weekday/date range" },
        { status: 409 },
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

interface ValidatedBody {
  provider_id: string;
  weekday: number;
  start_local: string;
  end_local: string;
  slot_minutes: number;
  buffer_minutes: number;
  valid_from: string;
  valid_to: string;
}

function validateRuleBody(body: unknown): ValidatedBody | { error: string } {
  if (!body || typeof body !== "object") return { error: "Body must be an object" };
  const b = body as Record<string, unknown>;

  if (!b.provider_id || typeof b.provider_id !== "string")
    return { error: "provider_id is required" };
  if (typeof b.weekday !== "number" || b.weekday < 0 || b.weekday > 6) {
    return { error: "weekday must be 0–6 (0=Sun..6=Sat)" };
  }
  if (!b.start_local || typeof b.start_local !== "string")
    return { error: "start_local is required (HH:MM)" };
  if (!b.end_local || typeof b.end_local !== "string")
    return { error: "end_local is required (HH:MM)" };
  if (typeof b.slot_minutes !== "number" || b.slot_minutes <= 0) {
    return { error: "slot_minutes must be a positive number" };
  }
  if (!b.valid_from || typeof b.valid_from !== "string")
    return { error: "valid_from is required (YYYY-MM-DD)" };
  if (!b.valid_to || typeof b.valid_to !== "string")
    return { error: "valid_to is required (YYYY-MM-DD)" };

  const buffer_minutes = typeof b.buffer_minutes === "number" ? b.buffer_minutes : 0;

  return {
    provider_id: b.provider_id,
    weekday: b.weekday,
    start_local: b.start_local,
    end_local: b.end_local,
    slot_minutes: b.slot_minutes,
    buffer_minutes,
    valid_from: b.valid_from,
    valid_to: b.valid_to,
  };
}

function isPostgresError(err: unknown): err is { code: string } {
  return typeof err === "object" && err !== null && "code" in err;
}
