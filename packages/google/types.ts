// Typed shapes for Google Calendar API responses.
// Derived from the Google Calendar REST API v3 reference.
// Sprint 0 covers the fields used by the client; non-critical optional fields
// are typed as optional so a real capture can add them without breaking the
// build.

export interface EventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface EventPerson {
  email?: string;
  displayName?: string;
  self?: boolean;
}

/** calendar#event resource */
export interface CalendarEvent {
  kind: string;
  etag: string;
  id: string;
  status: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  summary?: string;
  description?: string;
  creator?: EventPerson;
  organizer?: EventPerson;
  start: EventDateTime;
  end: EventDateTime;
  iCalUID?: string;
  sequence?: number;
  reminders?: { useDefault: boolean };
  eventType?: string;
}

/** calendar#events collection */
export interface EventsListResult {
  kind: string;
  etag: string;
  summary?: string;
  updated?: string;
  timeZone?: string;
  accessRole?: string;
  defaultReminders?: unknown[];
  nextPageToken?: string;
  nextSyncToken?: string;
  items: CalendarEvent[];
}

/** api#channel resource (returned by events.watch) */
export interface WatchChannel {
  kind: string;
  id: string;
  resourceId: string;
  resourceUri?: string;
  token?: string;
  expiration?: string;
}

/** Input resource for events.insert / events.patch */
export interface EventResource {
  summary?: string;
  description?: string;
  start: EventDateTime;
  end: EventDateTime;
  attendees?: Array<{ email: string }>;
}
