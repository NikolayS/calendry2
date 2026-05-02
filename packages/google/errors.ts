// Error taxonomy for the Google Calendar + OAuth client.
// See ERRORS.md for action-per-error documentation.

export class CalendryGoogleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** Refresh token was revoked or expired; provider must re-authorize. */
export class OAuthInvalidGrantError extends CalendryGoogleError {}

/** Access token returned with insufficient scope; provider must re-consent. */
export class OAuthScopeDowngradeError extends CalendryGoogleError {}

/**
 * Two consecutive 401 responses — access token expired mid-flight and the
 * implicit re-check also failed; provider must re-authorize.
 */
export class OAuthTokenExpiredError extends CalendryGoogleError {}

/** events.list returned 410 Gone; caller must perform a full resync. */
export class SyncTokenExpiredError extends CalendryGoogleError {}

/** Transient Google API error; retryable at the worker level. */
export class GoogleApiError extends CalendryGoogleError {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
