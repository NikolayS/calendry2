/**
 * PATCH /api/admin/availability-rules/[id]
 * DELETE /api/admin/availability-rules/[id]
 *
 * Admin-protected. PATCH updates fields; DELETE hard-deletes the rule.
 *
 * Hard-delete rationale: soft-delete adds query complexity for a rule that
 * is the canonical definition of recurring availability. Deleting a rule
 * means "this time window is no longer available going forward". Historical
 * bookings already made under the rule remain untouched (they reference
 * provider_id, not availability_rule_id). A future soft-delete toggle can
 * be added in v0.2 if needed.
 *
 * On overlap from PATCH → HTTP 409.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getPool } from "../../../../../../../packages/db/index";
import type { AvailabilityRule } from "../../../../../../../packages/db/index";
import { requireAdminSession } from "../../../../../lib/admin-auth";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// PATCH — edit a rule
// ---------------------------------------------------------------------------
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authErr = requireAdminSession(req);
  if (authErr) return authErr;

  const { id } = await params;
  const ruleId = Number.parseInt(id, 10);
  if (Number.isNaN(ruleId)) {
    return NextResponse.json({ error: "Invalid rule id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }

  const b = body as Record<string, unknown>;

  // Build SET clause dynamically from provided fields
  const allowed = [
    "weekday",
    "start_local",
    "end_local",
    "slot_minutes",
    "buffer_minutes",
    "valid_from",
    "valid_to",
  ] as const;
  const setClauses: string[] = [];
  const values: unknown[] = [];

  for (const field of allowed) {
    if (field in b) {
      values.push(b[field]);
      setClauses.push(`${field} = $${values.length}`);
    }
  }

  if (setClauses.length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  // Always bump updated_at
  values.push(new Date().toISOString());
  setClauses.push(`updated_at = $${values.length}`);

  values.push(ruleId);
  const whereIdx = values.length;

  const pool = getPool();
  try {
    const { rows } = await pool.query<AvailabilityRule>(
      `update availability_rules
       set ${setClauses.join(", ")}
       where id = $${whereIdx}
       returning *`,
      values,
    );

    if (rows.length === 0) {
      return NextResponse.json({ error: "Rule not found" }, { status: 404 });
    }
    return NextResponse.json({ rule: rows[0] });
  } catch (err: unknown) {
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
// DELETE — hard-delete a rule
// ---------------------------------------------------------------------------
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authErr = requireAdminSession(req);
  if (authErr) return authErr;

  const { id } = await params;
  const ruleId = Number.parseInt(id, 10);
  if (Number.isNaN(ruleId)) {
    return NextResponse.json({ error: "Invalid rule id" }, { status: 400 });
  }

  const pool = getPool();
  const { rowCount } = await pool.query("delete from availability_rules where id = $1", [ruleId]);

  if (!rowCount || rowCount === 0) {
    return NextResponse.json({ error: "Rule not found" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}

function isPostgresError(err: unknown): err is { code: string } {
  return typeof err === "object" && err !== null && "code" in err;
}
