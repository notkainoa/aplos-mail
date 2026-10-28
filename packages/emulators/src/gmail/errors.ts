/**
 * Google-style JSON errors: {error:{code,message,errors:[{message,domain,reason}],status}}.
 * Clients are expected to read status, reason and message text, because Google's per-minute
 * refusal can carry little more than `rateLimitExceeded`.
 */
export type ThrottleShape =
  'rateLimitExceeded403' | 'userRateLimitExceeded403' | 'resourceExhausted429' | 'messageOnly';
export type DailyLimitKind = 'dailyLimitExceeded' | 'quotaExceeded';

const STATUS_NAMES: Record<number, string> = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  409: 'ALREADY_EXISTS',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  503: 'UNAVAILABLE',
};

export interface ApiErrorExtra {
  domain?: string;
  /** Overrides the google.rpc status name; `null` leaves `status` out of the body. */
  status?: string | null;
  details?: unknown[];
  /** Text for `errors[0].message` when it differs from the top-level message. */
  shortMessage?: string;
  location?: string;
  locationType?: string;
  /** Leaves the `errors` array out, so the body carries only code and message. */
  omitErrors?: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly reason: string,
    message: string,
    readonly extra: ApiErrorExtra = {},
  ) {
    super(message);
  }

  /** The reason a client can read from the body (`errors[0].reason`), if the body has one. */
  get visibleReason(): string | undefined {
    return this.extra.omitErrors ? undefined : this.reason;
  }

  body(): unknown {
    const status =
      this.extra.status === undefined
        ? STATUS_NAMES[this.httpStatus]
        : (this.extra.status ?? undefined);
    const item: Record<string, unknown> = {
      message: this.extra.shortMessage ?? this.message,
      domain: this.extra.domain ?? 'global',
      reason: this.reason,
    };
    if (this.extra.location) item.location = this.extra.location;
    if (this.extra.locationType) item.locationType = this.extra.locationType;
    return {
      error: {
        code: this.httpStatus,
        message: this.message,
        ...(this.extra.omitErrors ? {} : { errors: [item] }),
        ...(status ? { status } : {}),
        ...(this.extra.details ? { details: this.extra.details } : {}),
      },
    };
  }
}

export const notFound = (message = 'Requested entity was not found.'): ApiError =>
  new ApiError(404, 'notFound', message);
export const badRequest = (message: string, reason = 'invalidArgument'): ApiError =>
  new ApiError(400, reason, message);

const QUOTA_MESSAGE =
  "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user' of service 'gmail.googleapis.com' for consumer 'project_number:000000000000'.";

/** The refusal for a request that would take the user above the per-minute unit budget. */
export function throttleError(shape: ThrottleShape): ApiError {
  switch (shape) {
    case 'rateLimitExceeded403':
      return new ApiError(403, 'rateLimitExceeded', QUOTA_MESSAGE, {
        domain: 'usageLimits',
        status: 'PERMISSION_DENIED',
      });
    case 'userRateLimitExceeded403':
      return new ApiError(403, 'userRateLimitExceeded', 'User-rate limit exceeded.', {
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
      // No status, no `errors` array and so no reason: only the text says this is the per-minute
      // quota. A client that classifies by `errors[0].reason` alone will misread it, which is the point.
      return new ApiError(
        403,
        'rateLimitExceeded',
        "Rate limit exceeded: the quota 'Queries per minute per user' has been used up.",
        { status: null, omitErrors: true },
      );
  }
}

export const concurrencyError = (): ApiError =>
  new ApiError(429, 'rateLimitExceeded', 'Too many concurrent requests for user.', {
    status: 'RESOURCE_EXHAUSTED',
  });

export const batchRefusalError = (): ApiError =>
  new ApiError(429, 'rateLimitExceeded', 'Resource has been exhausted (e.g. check quota).', {
    status: 'RESOURCE_EXHAUSTED',
  });

/**
 * The daily send limit. Live Gmail names the time sending works again inside the text
 * ("User-rate limit exceeded.  Retry after <RFC 3339> (Mail sending)", two spaces included);
 * proto-google.md section 3 asks clients to show that time, so the emulator always includes it.
 */
export const sendLimitError = (retryAt: number): ApiError =>
  new ApiError(
    429,
    'rateLimitExceeded',
    `User-rate limit exceeded.  Retry after ${new Date(retryAt).toISOString()} (Mail sending)`,
    { status: 'RESOURCE_EXHAUSTED' },
  );

export function dailyLimitError(kind: DailyLimitKind): ApiError {
  if (kind === 'dailyLimitExceeded') {
    return new ApiError(403, 'dailyLimitExceeded', 'Daily Limit Exceeded', {
      domain: 'usageLimits',
      status: 'PERMISSION_DENIED',
    });
  }
  return new ApiError(
    403,
    'quotaExceeded',
    "Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'gmail.googleapis.com' for consumer 'project_number:000000000000'.",
    { domain: 'usageLimits', status: 'PERMISSION_DENIED' },
  );
}

export const insufficientScopeError = (
  apiMethod: string,
  service = 'gmail.googleapis.com',
): ApiError =>
  new ApiError(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.', {
    status: 'PERMISSION_DENIED',
    shortMessage: 'Insufficient Permission',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
        domain: 'googleapis.com',
        metadata: { service, method: apiMethod },
      },
    ],
  });

const AUTH_HINT =
  'Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.';

/**
 * 401 for Gmail calls. Google tells the two cases apart: no credential at all is reason `required`
 * ("Login Required."), a bad or expired token is `authError` ("Invalid Credentials").
 */
export const authError = (missing: boolean): ApiError =>
  missing
    ? new ApiError(
        401,
        'required',
        `Request is missing required authentication credential. ${AUTH_HINT}`,
        {
          status: 'UNAUTHENTICATED',
          shortMessage: 'Login Required.',
          location: 'Authorization',
          locationType: 'header',
        },
      )
    : new ApiError(
        401,
        'authError',
        `Request had invalid authentication credentials. ${AUTH_HINT}`,
        {
          status: 'UNAUTHENTICATED',
          shortMessage: 'Invalid Credentials',
          location: 'Authorization',
          locationType: 'header',
        },
      );

/**
 * The RFC 6750 challenge that goes with `authError`. A request with no credential gets the bare
 * realm; a rejected token adds `error="invalid_token"` (RFC 6750 section 3.1).
 */
export const authChallenge = (missing: boolean): Record<string, string> => ({
  'www-authenticate': missing
    ? 'Bearer realm="https://accounts.google.com/"'
    : 'Bearer realm="https://accounts.google.com/", error="invalid_token"',
});

/** RFC 6750 section 3.1: a token without the needed scope gets `error="insufficient_scope"` and the scope it needs. */
export const scopeChallenge = (scope: string): Record<string, string> => ({
  'www-authenticate': `Bearer realm="https://accounts.google.com/", error="insufficient_scope", scope="${scope}"`,
});

/** A Gmail id (message or thread) is a 64-bit number in hex; anything else fails before lookup. */
export const invalidIdError = (): ApiError => badRequest('Invalid id value');

/** `/users/{address}` naming anyone but the token's owner. The text names the signed-in user. */
export const delegationDenied = (ownerEmail: string): ApiError =>
  new ApiError(403, 'forbidden', `Delegation denied for ${ownerEmail}`, {
    status: 'PERMISSION_DENIED',
  });

/** A `fields=` mask naming something the response type does not have. */
export const invalidFieldError = (field: string): ApiError =>
  new ApiError(400, 'invalidParameter', `Invalid field selection ${field}`, {
    location: 'fields',
    locationType: 'parameter',
  });
