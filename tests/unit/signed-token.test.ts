/**
 * signed-token.test.ts
 *
 * TDD: signed token issuance and verification (B3).
 * Tests the exp claim behaviour added in fix r1:
 *   - token with exp in the past  → verifyToken rejects with TokenExpiredError
 *   - token with exp in the future → verifyToken resolves with payload
 *
 * Run: bun test tests/unit/signed-token.test.ts
 */

import { describe, expect, it } from "bun:test";
import { TokenExpiredError, signToken, verifyToken } from "../../apps/web/lib/signed-token";

describe("signToken / verifyToken — exp claim (B3)", () => {
  it("verifies a freshly issued token (exp in the future)", async () => {
    const now = Date.now();
    const token = await signToken({
      booking_id: "abc-123",
      kind: "cancel",
      issued_at: now,
      exp: now + 30 * 24 * 60 * 60 * 1000, // 30 days out
    });

    const payload = await verifyToken(token);
    expect(payload.booking_id).toBe("abc-123");
    expect(payload.kind).toBe("cancel");
  });

  it("throws TokenExpiredError for a token whose exp is in the past", async () => {
    const past = Date.now() - 1000; // 1 second ago
    const token = await signToken({
      booking_id: "abc-456",
      kind: "reschedule",
      issued_at: past - 60_000,
      exp: past, // already expired
    });

    await expect(verifyToken(token)).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it("throws for a tampered signature", async () => {
    const now = Date.now();
    const token = await signToken({
      booking_id: "abc-789",
      kind: "cancel",
      issued_at: now,
      exp: now + 86_400_000,
    });

    // Corrupt the signature portion
    const [head, sig] = token.split(".");
    const tampered = `${head}.${sig.slice(0, -4)}XXXX`;
    await expect(verifyToken(tampered)).rejects.toThrow();
  });

  it("TokenExpiredError is an instance of Error with a descriptive message", async () => {
    const past = Date.now() - 1;
    const token = await signToken({
      booking_id: "chk",
      kind: "cancel",
      issued_at: past - 1000,
      exp: past,
    });

    try {
      await verifyToken(token);
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(TokenExpiredError);
      expect((err as Error).message).toMatch(/expired/i);
    }
  });
});
