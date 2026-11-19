/** The Google calendar write scopes: small and always loaded (the actor's gate reads them). */

/** Google's event write scope (`oauth/scopes.ts` `calendarEventsWrite`; pinned by a test). */
export const GOOGLE_CALENDAR_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

/**
 * Every grant that satisfies a write: the narrow `calendar.events` scope OR the `calendar` umbrella an older
 * grant may already hold. One list for every gate (`prepare` here, the actor's `calendarWriteRefused`) so a
 * holder of the umbrella is never refused a write it can make; the gap still reports `calendar.events`,
 * the least the owner can add.
 */
export const CALENDAR_WRITE_SCOPES = [
  GOOGLE_CALENDAR_WRITE_SCOPE,
  'https://www.googleapis.com/auth/calendar',
] as const;

/** True when the grant covers calendar writes (any scope in `CALENDAR_WRITE_SCOPES`). */
export const hasCalendarWrite = (grantedScopes: readonly string[]) =>
  CALENDAR_WRITE_SCOPES.some(s => grantedScopes.includes(s));
