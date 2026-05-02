// @calendry/google — Google Calendar API client, OAuth, watch channels, sync tokens.
// See ERRORS.md for error taxonomy and packages/google/fixtures/README.md for fixture shapes.

export { exchangeRefreshToken } from "./oauthClient";
export type { OAuthCredentials, AccessTokenResult } from "./oauthClient";

export { CalendarClient } from "./calendarClient";
export type {
  CalendarClientOptions,
  InsertOptions,
  PatchOptions,
  DeleteOptions,
  ListOptions,
  WatchOptions,
} from "./calendarClient";

export {
  CalendryGoogleError,
  OAuthInvalidGrantError,
  OAuthScopeDowngradeError,
  OAuthTokenExpiredError,
  SyncTokenExpiredError,
  GoogleApiError,
} from "./errors";

export type {
  CalendarEvent,
  EventsListResult,
  WatchChannel,
  EventResource,
  EventDateTime,
} from "./types";
