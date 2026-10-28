import { ApiError, type ThrottleShape } from '../gmail/errors';

/** Calendar's own error texts. The envelope is the shared Google JSON from `ApiError`. */
export const calNotFound = (): ApiError => new ApiError(404, 'notFound', 'Not Found');
export const calInvalid = (message: string, reason = 'invalid'): ApiError =>
  new ApiError(400, reason, message);
export const calForbidden = (): ApiError => new ApiError(403, 'forbidden', 'Forbidden');
export const duplicateId = (): ApiError =>
  new ApiError(409, 'duplicate', 'The requested identifier already exists.');
/** A deleted resource that is still remembered (events.delete twice, or events.delete of a cancelled instance). */
export const resourceDeleted = (): ApiError =>
  new ApiError(410, 'deleted', 'Resource has been deleted');

/** Wipe the local copy and sync from scratch. Both list kinds use this exact text. */
export const fullSyncRequired = (): ApiError =>
  new ApiError(410, 'fullSyncRequired', 'Sync token is no longer valid, a full sync is required.', {
    domain: 'calendar',
  });

/** A stale `If-Match`. A client must raise an edit conflict, never retry blindly. */
export const conditionNotMet = (): ApiError =>
  new ApiError(412, 'conditionNotMet', 'Precondition Failed', {
    location: 'If-Match',
    locationType: 'header',
  });

export const forbiddenForNonOrganizer = (): ApiError =>
  new ApiError(
    403,
    'forbiddenForNonOrganizer',
    'The operation can only be performed by the organizer of the event.',
  );

/** The anti-abuse refusal for writes. It lasts hours, unlike a per-minute refusal. */
export const calendarAbuseError = (): ApiError =>
  new ApiError(403, 'quotaExceeded', 'Calendar usage limits exceeded.', { domain: 'usageLimits' });

const QUOTA_MESSAGE =
  "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user' of service 'calendar-json.googleapis.com' for consumer 'project_number:000000000000'.";

/** The refusal for a request over the per-user per-minute budget, in the shape the emulator is set to. */
export function calendarThrottleError(shape: ThrottleShape): ApiError {
  switch (shape) {
    case 'rateLimitExceeded403':
      return new ApiError(403, 'rateLimitExceeded', 'Rate Limit Exceeded', {
        domain: 'usageLimits',
      });
    case 'userRateLimitExceeded403':
      return new ApiError(403, 'userRateLimitExceeded', 'User Rate Limit Exceeded.', {
        domain: 'usageLimits',
      });
    case 'resourceExhausted429':
      return new ApiError(429, 'rateLimitExceeded', QUOTA_MESSAGE, {
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'RATE_LIMIT_EXCEEDED',
            domain: 'googleapis.com',
          },
        ],
      });
    case 'messageOnly':
      // No `errors` array and so no reason: only the text identifies the quota.
      return new ApiError(
        403,
        'rateLimitExceeded',
        "Rate limit exceeded: the quota 'Queries per minute per user' has been used up.",
        { status: null, omitErrors: true },
      );
  }
}
