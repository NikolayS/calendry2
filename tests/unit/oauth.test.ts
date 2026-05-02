import { describe, expect, it } from "bun:test";
import { OAuthInvalidGrantError, OAuthScopeDowngradeError } from "../../packages/google/errors";
import invalidGrantFixture from "../../packages/google/fixtures/error-invalid-grant.json";
import scopeDowngradeFixture from "../../packages/google/fixtures/error-scope-downgrade.json";
import happyTokenFixture from "../../packages/google/fixtures/happy-path-token.json";
import { exchangeRefreshToken } from "../../packages/google/oauthClient";

// ---------------------------------------------------------------------------
// Minimal hand-rolled fetch mock (no MSW, per issue spec)
// ---------------------------------------------------------------------------

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function makeFetchMock(handler: FetchHandler): typeof globalThis.fetch {
  return handler as unknown as typeof globalThis.fetch;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("exchangeRefreshToken", () => {
  it("returns an access token on success", async () => {
    const mockFetch = makeFetchMock(async () => jsonResponse(happyTokenFixture, 200));
    const result = await exchangeRefreshToken(
      { clientId: "cid", clientSecret: "csec", refreshToken: "rtoken" },
      mockFetch,
    );
    expect(result.accessToken).toBe(happyTokenFixture.access_token);
    expect(result.expiresIn).toBe(happyTokenFixture.expires_in);
    expect(result.scope).toBe(happyTokenFixture.scope);
  });

  it("throws OAuthInvalidGrantError when Google returns invalid_grant", async () => {
    const mockFetch = makeFetchMock(async () => jsonResponse(invalidGrantFixture, 400));
    await expect(
      exchangeRefreshToken(
        { clientId: "cid", clientSecret: "csec", refreshToken: "revoked" },
        mockFetch,
      ),
    ).rejects.toThrow(OAuthInvalidGrantError);
  });

  it("OAuthInvalidGrantError message includes the error description", async () => {
    const mockFetch = makeFetchMock(async () => jsonResponse(invalidGrantFixture, 400));
    try {
      await exchangeRefreshToken(
        { clientId: "cid", clientSecret: "csec", refreshToken: "revoked" },
        mockFetch,
      );
      expect(true).toBe(false); // should not reach
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthInvalidGrantError);
      expect((e as Error).message).toContain("invalid_grant");
    }
  });

  it("throws OAuthScopeDowngradeError when scope is missing calendar write access", async () => {
    const mockFetch = makeFetchMock(async () => jsonResponse(scopeDowngradeFixture, 200));
    await expect(
      exchangeRefreshToken(
        { clientId: "cid", clientSecret: "csec", refreshToken: "limited" },
        mockFetch,
      ),
    ).rejects.toThrow(OAuthScopeDowngradeError);
  });

  it("OAuthScopeDowngradeError message includes the actual scope returned", async () => {
    const mockFetch = makeFetchMock(async () => jsonResponse(scopeDowngradeFixture, 200));
    try {
      await exchangeRefreshToken(
        { clientId: "cid", clientSecret: "csec", refreshToken: "limited" },
        mockFetch,
      );
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthScopeDowngradeError);
      expect((e as Error).message).toContain("calendar.readonly");
    }
  });

  it("sends correct form-encoded body to the token endpoint", async () => {
    let capturedInit: RequestInit | undefined;
    const mockFetch = makeFetchMock(async (_url, init) => {
      capturedInit = init;
      return jsonResponse(happyTokenFixture, 200);
    });
    await exchangeRefreshToken(
      { clientId: "test-client", clientSecret: "test-secret", refreshToken: "test-rtoken" },
      mockFetch,
    );
    const body = capturedInit?.body as string;
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("client_id=test-client");
    expect(body).toContain("client_secret=test-secret");
    expect(body).toContain("refresh_token=test-rtoken");
  });
});
