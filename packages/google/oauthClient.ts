// Thin wrapper around Google's OAuth 2.0 token endpoint.
// Exchanges a refresh token for an access token; validates scope.

import { OAuthInvalidGrantError, OAuthScopeDowngradeError } from "./errors";

/** Required scope for all calendar read+write operations. */
const REQUIRED_SCOPE = "https://www.googleapis.com/auth/calendar";

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface AccessTokenResult {
  accessToken: string;
  expiresIn: number;
  scope: string;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * Exchange a refresh token for an access token.
 *
 * Throws `OAuthInvalidGrantError` if Google returns `invalid_grant`.
 * Throws `OAuthScopeDowngradeError` if the returned scope is missing the
 * required calendar write scope.
 *
 * @param credentials  OAuth client + refresh token.
 * @param fetchImpl    Injectable fetch (for testing). Defaults to global fetch.
 */
export async function exchangeRefreshToken(
  credentials: OAuthCredentials,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<AccessTokenResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
  });

  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const data = (await response.json()) as TokenResponse;

  if (!response.ok || data.error) {
    if (data.error === "invalid_grant") {
      throw new OAuthInvalidGrantError(
        `OAuth invalid_grant: ${data.error_description ?? "refresh token revoked or expired"}`,
      );
    }
    throw new Error(
      `OAuth token exchange failed (HTTP ${response.status}): ${data.error ?? "unknown error"}`,
    );
  }

  const scope = data.scope ?? "";
  if (!scope.split(" ").includes(REQUIRED_SCOPE)) {
    throw new OAuthScopeDowngradeError(
      `OAuth scope downgrade: required "${REQUIRED_SCOPE}" but got "${scope}"`,
    );
  }

  return {
    // access_token and expires_in are guaranteed present when response.ok and no error
    accessToken: data.access_token ?? "",
    expiresIn: data.expires_in ?? 0,
    scope,
  };
}
