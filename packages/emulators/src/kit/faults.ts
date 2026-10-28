/**
 * Fault injection for emulators. An emulator calls `intercept` for every request before it answers;
 * tests add rules to make the next matching request fail the way a real provider does (a refusal,
 * a dropped connection, a garbled body), or to make a whole time range fail (a rate-limit storm).
 *
 * Rules are checked in insertion order and the first rule that fires decides the request. Time
 * comes from the `now` argument (the emulator's clock), never from the real clock.
 */
import type { EmulatedRequest, FaultDecision, FaultHook } from './types';

/** Which requests a rule applies to. Every field that is set must match. */
export interface FaultMatch {
  service?: string;
  /** Exact method id, or a RegExp tested against it. */
  apiMethod?: string | RegExp;
  httpMethod?: string;
  account?: string;
  /** Let this many matching requests through first, then fire on the next one. */
  after?: number;
}

/** Extra shape for a Google error body and headers. */
export interface GoogleErrorExtras {
  /** `error.errors[0].domain`. Defaults to 'usageLimits' for rate limits, 'global' otherwise. */
  domain?: string;
  /** `error.status`, e.g. 'RESOURCE_EXHAUSTED'. Defaults to Google's usual name for the HTTP status. */
  statusName?: string;
  /** Sends a `Retry-After` header, in seconds. */
  retryAfterSeconds?: number;
  headers?: Record<string, string>;
}

/** Shorthand for a refusal when the test doesn't need to build a Response itself. */
export interface FailSpec extends GoogleErrorExtras {
  status: number;
  reason: string;
  message?: string;
}

export interface FireOptions {
  /** How many matching requests the rule fires for before it is removed. Default 1. */
  times?: number;
}

export interface FailOptions extends FireOptions {
  /** Charge the request's units even though it was refused. Default false. */
  charge?: boolean;
}

export interface StormRule extends GoogleErrorExtras {
  /** Start of the storm, inclusive, in clock milliseconds. */
  from: number;
  /** End of the storm, exclusive. */
  to: number;
  /** HTTP status of the refusal. Default 429. */
  status?: number;
  reason: string;
  message?: string;
  match?: FaultMatch;
  charge?: boolean;
}

/** One rule firing. Holds no request content, only routing facts. */
export interface FiredFault {
  at: number;
  seq: number;
  service: string;
  apiMethod: string;
  rule: 'fail' | 'storm' | 'drop' | 'dropAfter' | 'corrupt';
  status?: number;
  reason?: string;
}

export interface FaultInjector extends FaultHook {
  /** Answer the next matching request with a prepared Response or a Google-shaped refusal. */
  failNext(match: FaultMatch, what: Response | FailSpec, options?: FailOptions): void;
  /** Refuse every matching request between `from` (inclusive) and `to` (exclusive). */
  storm(rule: StormRule): void;
  /** Reset the connection before any reply. The provider did not see the call. */
  dropNext(match: FaultMatch, options?: FireOptions): void;
  /** Let the provider apply and charge the call, then lose the reply. The write may have happened. */
  dropAfterNext(match: FaultMatch, options?: FireOptions): void;
  /** Answer 200 with truncated JSON. */
  corruptNext(match: FaultMatch, options?: FireOptions): void;
  /** Remove every rule. `fired` is kept. */
  clear(): void;
  /** Remove every rule and forget what fired. */
  reset(): void;
  /** Rules still waiting to fire (storms count until cleared). */
  readonly pending: number;
  readonly fired: FiredFault[];
}

const GOOGLE_STATUS_NAMES: Record<number, string> = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  409: 'ABORTED',
  412: 'FAILED_PRECONDITION',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  502: 'UNAVAILABLE',
  503: 'UNAVAILABLE',
  504: 'DEADLINE_EXCEEDED',
};

const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
]);

/**
 * A Google-style JSON error response: `{ error: { code, message, errors: [{ message, domain, reason }], status } }`.
 * Clients read `error.errors[0].reason` to decide between "back off", "reconnect" and "give up",
 * so tests can inject any reason with it.
 */
export function googleError(
  status: number,
  reason: string,
  message = reason,
  extras: GoogleErrorExtras = {},
): Response {
  const domain = extras.domain ?? (RATE_LIMIT_REASONS.has(reason) ? 'usageLimits' : 'global');
  const body = {
    error: {
      code: status,
      message,
      errors: [{ message, domain, reason }],
      status: extras.statusName ?? GOOGLE_STATUS_NAMES[status] ?? 'UNKNOWN',
    },
  };
  const headers = new Headers({
    'content-type': 'application/json; charset=UTF-8',
    ...extras.headers,
  });
  if (extras.retryAfterSeconds !== undefined)
    headers.set('retry-after', String(extras.retryAfterSeconds));
  return new Response(JSON.stringify(body), { status, headers });
}

/** Does the request satisfy the filters (ignoring `after`, which needs a counter)? */
export function matchesRequest(match: FaultMatch, request: EmulatedRequest): boolean {
  if (match.service !== undefined && match.service !== request.service) return false;
  if (
    match.httpMethod !== undefined &&
    match.httpMethod.toUpperCase() !== request.httpMethod.toUpperCase()
  )
    return false;
  if (match.account !== undefined && match.account !== request.account) return false;
  if (match.apiMethod !== undefined) {
    const wanted = match.apiMethod;
    const ok =
      typeof wanted === 'string' ? wanted === request.apiMethod : wanted.test(request.apiMethod);
    if (!ok) return false;
  }
  return true;
}

interface Rule {
  kind: FiredFault['rule'];
  match: FaultMatch;
  /** Matching requests seen so far, compared with `match.after`. */
  seen: number;
  /** Firings left; undefined for a storm, which only ends by time. */
  remaining?: number;
  /** Active time range for storms. */
  range?: { from: number; to: number };
  decide(request: EmulatedRequest): FaultDecision;
  describe?: { status: number; reason: string };
}

export function createFaultInjector(): FaultInjector {
  let rules: Rule[] = [];
  const fired: FiredFault[] = [];

  function add(rule: Rule): void {
    rules.push(rule);
  }

  function respondWith(
    what: Response | FailSpec,
    charge: boolean | undefined,
  ): () => FaultDecision {
    // Clone prepared Responses so a rule that fires more than once can hand out a fresh body each time.
    if (what instanceof Response)
      return () => ({ kind: 'respond', response: what.clone(), charge });
    const { status, reason, message, ...extras } = what;
    return () => ({
      kind: 'respond',
      response: googleError(status, reason, message, extras),
      charge,
    });
  }

  function simple(
    kind: 'drop' | 'dropAfter' | 'corrupt',
    match: FaultMatch,
    options: FireOptions | undefined,
  ): void {
    add({ kind, match, seen: 0, remaining: options?.times ?? 1, decide: () => ({ kind }) });
  }

  return {
    failNext(match, what, options) {
      const describe =
        what instanceof Response
          ? { status: what.status, reason: '' }
          : { status: what.status, reason: what.reason };
      add({
        kind: 'fail',
        match,
        seen: 0,
        remaining: options?.times ?? 1,
        decide: respondWith(what, options?.charge),
        describe,
      });
    },

    storm(rule) {
      const status = rule.status ?? 429;
      const { from, to, status: _status, reason, message, match, charge, ...extras } = rule;
      add({
        kind: 'storm',
        match: match ?? {},
        seen: 0,
        range: { from, to },
        decide: () => ({
          kind: 'respond',
          response: googleError(status, reason, message, extras),
          charge,
        }),
        describe: { status, reason },
      });
    },

    dropNext: (match, options) => simple('drop', match, options),
    dropAfterNext: (match, options) => simple('dropAfter', match, options),
    corruptNext: (match, options) => simple('corrupt', match, options),

    clear() {
      rules = [];
    },
    reset() {
      rules = [];
      fired.length = 0;
    },
    get pending() {
      return rules.length;
    },
    fired,

    intercept(request, now) {
      for (const rule of rules) {
        if (rule.range && (now < rule.range.from || now >= rule.range.to)) continue;
        if (!matchesRequest(rule.match, request)) continue;
        rule.seen += 1;
        if (rule.seen <= (rule.match.after ?? 0)) continue;

        const decision = rule.decide(request);
        fired.push({
          at: now,
          seq: request.seq,
          service: request.service,
          apiMethod: request.apiMethod,
          rule: rule.kind,
          status: rule.describe?.status,
          reason: rule.describe?.reason || undefined,
        });
        if (rule.remaining !== undefined) {
          rule.remaining -= 1;
          if (rule.remaining <= 0) rules = rules.filter(r => r !== rule);
        }
        return decision;
      }
      return undefined;
    },
  };
}
