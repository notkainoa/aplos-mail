import type { ClassifiedError, ErrorClass } from '@aplos/contract';
import { ProviderError, type RequestKind } from '@aplos/engine/ports';

/**
 * Google error -> one ClassifiedError (plan 20 section 3.3, ARCH 6.3). Reads the HTTP status, Google's reason, the
 * google.rpc status, ErrorInfo details, the response headers AND the message text, because Gmail's per-minute refusal
 * can arrive with nothing but a sentence. It never decides to retry: the governor acts on the class.
 */

export interface GoogleFailure {
  /** Catalog method id: `gmail.threads.get`, `oauth.token`, `gcal.events.list`. */
  method: string;
  kind: RequestKind;
  now: number;
  /** HTTP status; absent when no response arrived. */
  status?: number;
  /** Parsed JSON body, or the raw text when it was not JSON. */
  body?: unknown;
  headers?: Headers | Record<string, string>;
  /** The remote item the call was about, for a one-item `permanent`. */
  item?: string;
  /**
   * No response: `timeout` and `reset` may have happened after the request was written (a write is then uncertain);
   * `refused` (DNS, connection refused) proves nothing left.
   */
  network?: 'timeout' | 'reset' | 'refused';
}

export interface Classified {
  error: ClassifiedError;
  scope: 'account' | 'project';
}

const THROTTLE_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'RATE_LIMIT_EXCEEDED',
  'RESOURCE_EXHAUSTED',
  'concurrentLimitExceeded',
]);
const CONFIG_REASONS = new Set(['accessNotConfigured', 'SERVICE_DISABLED', 'API_DISABLED']);
const SCOPE_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']);

interface Parsed {
  /** `error.errors[0].reason`, or the OAuth `error` string. */
  reason?: string;
  rpcStatus?: string;
  /** ErrorInfo `reason`s from `error.details`. */
  infoReasons: string[];
  text: string;
  /** Set when the body was not Google's error JSON: its size, which is all that may be logged of it. */
  unparseableBytes?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
/** The size of a body that is not Google's error JSON; nothing when there was no body at all. */
function sizeOf(body: unknown): { unparseableBytes?: number } {
  const bytes = Buffer.byteLength(typeof body === 'string' ? body : (JSON.stringify(body) ?? ''));
  return bytes > 0 ? { unparseableBytes: bytes } : {};
}
const isSuccess = (status: number | undefined): boolean =>
  status !== undefined && status >= 200 && status < 300;

function parseBody(body: unknown): Parsed {
  let value = body;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { infoReasons: [], text: value as string, ...sizeOf(body) };
    }
  }
  if (!isRecord(value)) return { infoReasons: [], text: '', ...sizeOf(body) };
  // Token endpoint: {"error": "invalid_grant", "error_description": "..."}.
  if (typeof value.error === 'string') {
    return { reason: value.error, infoReasons: [], text: str(value.error_description) ?? '' };
  }
  const error = isRecord(value.error) ? value.error : {};
  const items = Array.isArray(error.errors) ? error.errors.filter(isRecord) : [];
  const details = Array.isArray(error.details) ? error.details.filter(isRecord) : [];
  const texts = [str(error.message), ...items.map(item => str(item.message))].filter(Boolean);
  return {
    reason: str(items[0]?.reason),
    rpcStatus: str(error.status),
    infoReasons: details.map(d => str(d.reason)).filter((r): r is string => Boolean(r)),
    text: [...new Set(texts)].join(' '),
  };
}

function header(headers: GoogleFailure['headers'], name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find(k => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

/**
 * `Retry-After` in delta-seconds or HTTP-date (RFC 9110 10.2.3), with no cap. Garbage, negative or fractional values
 * give undefined so the governor falls back to its own ladder. Kept tiny on purpose: `prov-gov`'s shared parser lives
 * on another branch and replaces this one when it lands.
 */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, Number.MAX_SAFE_INTEGER);
  // An HTTP-date always names a year and a time; anything else (including "-5" or "1.5") is not one.
  if (!/\b\d{4}\b/.test(text) || !/\d{1,2}:\d{2}:\d{2}/.test(text)) return undefined;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

const pacific = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

/** The Pacific wall-clock reading of `ms`, written as if it were a UTC instant (so plain date arithmetic works on it). */
function pacificWall(ms: number): number {
  const p: Record<string, number> = {};
  for (const part of pacific.formatToParts(new Date(ms)))
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) + (((ms % 1000) + 1000) % 1000)
  );
}

/**
 * The next 00:00 America/Los_Angeles after `now`, when Google's daily quotas reset. Days there are 23, 24 or 25 hours,
 * so the answer is found by asking the zone, never by adding 24 h: start from today's offset and correct by the
 * difference between the wall clock we got and the one we wanted.
 */
export function nextPacificMidnight(now: number): number {
  const wall = new Date(pacificWall(now));
  const wanted = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1);
  let guess = wanted + (now - wall.getTime());
  for (let i = 0; i < 3; i++) guess += wanted - pacificWall(guess);
  return guess;
}

function budgetOf(method: string): string {
  if (method.startsWith('oauth.')) return 'oauth';
  if (method.startsWith('gcal.')) return 'gcal';
  return 'gmail';
}

/** A time named in the text is trusted up to this far ahead; a send limit really can run for most of a day. */
const MAX_TEXT_RETRY_MS = 25 * 60 * 60 * 1000;

/** "User-rate limit exceeded.  Retry after 2026-10-28T07:00:00.000Z (Mail sending)": Google names the time in the text. */
function retryAfterInText(text: string, now: number): number | undefined {
  const match = /retry after (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i.exec(text);
  const at = match ? Date.parse(match[1]) : NaN;
  return Number.isNaN(at) ? undefined : Math.min(at, now + MAX_TEXT_RETRY_MS);
}

function missingScopes(headers: GoogleFailure['headers']): string[] | undefined {
  const challenge = header(headers, 'www-authenticate');
  const scope = challenge ? /scope="([^"]+)"/.exec(challenge)?.[1] : undefined;
  return scope ? scope.split(/\s+/).filter(Boolean) : undefined;
}

type Make = (
  cls: ErrorClass,
  reason: string,
  extra?: Partial<ClassifiedError>,
  scope?: 'account' | 'project',
) => Classified;

/** What every class test reads, worked out once per failure. */
interface Reading {
  failure: GoogleFailure;
  provider: string;
  parsed: Parsed;
  text: string;
  make: Make;
  retryAfterMs?: number;
  withRetry: { retryAfterMs?: number };
}

/** A Google API (not OAuth) failure's reasons, for the classifier steps below. */
interface ApiReading extends Reading {
  /** Text alone only decides for the statuses Google refuses quota with, so a 400 that mentions "per day" stays a 400. */
  quotaStatus: boolean;
  has: (set: Set<string>) => boolean;
  reason?: string;
}

/**
 * A 2xx body is mail content (a truncated `messages.get` starts with the snippet), so it is never read for words and
 * never logged. A body that is not Google's error JSON is reduced to its size for the same reason.
 */
function readBody(failure: GoogleFailure): Parsed {
  if (!isSuccess(failure.status)) return parseBody(failure.body);
  return { infoReasons: [], text: '', ...sizeOf(failure.body) };
}

function providerMessage(parsed: Parsed): { providerMessage?: string } {
  if (parsed.unparseableBytes !== undefined)
    return { providerMessage: `unparseable response, ${parsed.unparseableBytes} bytes` };
  return parsed.text ? { providerMessage: parsed.text.slice(0, 300) } : {};
}

function readFailure(failure: GoogleFailure): Reading {
  const { method, now, status } = failure;
  const provider = budgetOf(method);
  const parsed = readBody(failure);
  const text = parsed.text;
  const make: Make = (cls, reason, extra = {}, scope = 'account') => ({
    error: {
      class: cls,
      provider,
      method,
      reason,
      ...(status !== undefined ? { status } : {}),
      ...providerMessage(parsed),
      ...extra,
    },
    scope,
  });
  const retryAfterMs = parseRetryAfter(header(failure.headers, 'retry-after'), now);
  const withRetry = retryAfterMs !== undefined ? { retryAfterMs } : {};
  return { failure, provider, parsed, text, make, retryAfterMs, withRetry };
}

/** No response at all. */
function classifyNetwork(
  { failure, make }: Reading,
  network: 'timeout' | 'reset' | 'refused',
): Classified {
  const mayHaveLeft =
    network !== 'refused' && (failure.kind === 'write' || failure.kind === 'send');
  return make('transient', network, mayHaveLeft ? { uncertain: true } : {});
}

/** The token endpoint speaks OAuth, not google.rpc. */
function classifyOAuth({ failure, parsed, make, withRetry }: Reading): Classified {
  const { status } = failure;
  const reason = parsed.reason ?? `status_${status ?? 0}`;
  if (reason === 'invalid_grant' || reason === 'admin_policy_enforced') return make('auth', reason);
  if (reason === 'invalid_client' || reason === 'unauthorized_client')
    return make('config', reason, {}, 'project');
  if (status === undefined || status === 408 || status === 429 || status >= 500)
    return make('transient', reason, withRetry);
  return make('permanent', reason);
}

function readApi(reading: Reading): ApiReading {
  const { parsed, failure } = reading;
  const reasons = [parsed.reason, parsed.rpcStatus, ...parsed.infoReasons].filter(
    (r): r is string => Boolean(r),
  );
  return {
    ...reading,
    quotaStatus: failure.status === 403 || failure.status === 429,
    has: (set: Set<string>) => reasons.some(r => set.has(r)),
    reason: parsed.reason ?? parsed.infoReasons[0] ?? parsed.rpcStatus,
  };
}

const SEND_LIMIT_TEXT = /mail sending|sending quota|user sending/i;
/** Text that names a per-minute, daily or bandwidth quota: those keep their own class even on a send. */
const OTHER_QUOTA_TEXT = /per minute|per day|bandwidth|queries per|concurrent/i;

/**
 * A refused send whose reason is a quota but whose text names no other limit: Gmail words its sending limits several
 * ways ("Mail sending", "Daily user sending quota exceeded") and sometimes only says `quotaExceeded`.
 */
function isSendQuota({ failure, parsed, text, quotaStatus }: ApiReading): boolean {
  if (failure.kind !== 'send' || !quotaStatus || OTHER_QUOTA_TEXT.test(text)) return false;
  return parsed.reason === 'quotaExceeded' || /\bquota\b/i.test(text);
}

/** Sending limit first: it arrives as a 429 rateLimitExceeded that only the text tells apart (D7). */
function classifySendLimit(api: ApiReading): Classified | undefined {
  const { text, retryAfterMs, make, reason } = api;
  const { now } = api.failure;
  if (!SEND_LIMIT_TEXT.test(text) && !isSendQuota(api)) return undefined;
  const at =
    retryAfterInText(text, now) ??
    (retryAfterMs !== undefined ? now + retryAfterMs : nextPacificMidnight(now));
  return make('send_limit', reason ?? 'rateLimitExceeded', {
    resumeAt: at,
    retryAfterMs: Math.max(0, at - now),
  });
}

function classifyConcurrency({
  text,
  make,
  withRetry,
  reason,
}: ApiReading): Classified | undefined {
  if (!/too many concurrent requests/i.test(text)) return undefined;
  return make('throttle', reason ?? 'rateLimitExceeded', { concurrency: true, ...withRetry });
}

/** Daily stops are never retried: they end at midnight Pacific. dailyLimitExceeded is the project's limit. */
function classifyDaily(api: ApiReading): Classified | undefined {
  const { parsed, provider, text, make, withRetry, quotaStatus, reason } = api;
  const { now } = api.failure;
  if (parsed.reason === 'dailyLimitExceeded') {
    return make('daily', 'dailyLimitExceeded', { resumeAt: nextPacificMidnight(now) }, 'project');
  }
  if (provider === 'gcal' && parsed.reason === 'quotaExceeded') {
    // Calendar's quotaExceeded is an anti-abuse limit measured in hours (ARCH 6.3), not a daily reset.
    return make('anti_abuse', 'quotaExceeded', withRetry);
  }
  if (parsed.reason === 'quotaExceeded' || (quotaStatus && /per day|bandwidth/i.test(text))) {
    return make('daily', reason ?? 'quotaExceeded', { resumeAt: nextPacificMidnight(now) });
  }
  return undefined;
}

/** The `Retry-After` header wins; Google's own "Retry after <ISO time>" sentence is the fallback. */
function retryHint(api: ApiReading): { retryAfterMs?: number } {
  if (api.retryAfterMs !== undefined) return api.withRetry;
  const at = retryAfterInText(api.text, api.failure.now);
  return at !== undefined ? { retryAfterMs: Math.max(0, at - api.failure.now) } : {};
}

function classifyThrottle(api: ApiReading): Classified | undefined {
  const { text, make, quotaStatus, has, reason } = api;
  if (
    has(THROTTLE_REASONS) ||
    api.failure.status === 429 ||
    (quotaStatus && /rate ?limit|per minute|too many requests/i.test(text))
  ) {
    return make('throttle', reason ?? 'rateLimitExceeded', retryHint(api));
  }
  return undefined;
}

function classifyAccess(api: ApiReading): Classified | undefined {
  const { failure, parsed, text, make, has, reason } = api;
  if (failure.status === 401) return make('auth', reason ?? 'authError');
  if (
    has(SCOPE_REASONS) ||
    /insufficient_scope/.test(header(failure.headers, 'www-authenticate') ?? '')
  ) {
    const scopes = missingScopes(failure.headers);
    return make(
      'permission',
      parsed.reason ?? 'insufficientPermissions',
      scopes ? { missingScopes: scopes } : {},
    );
  }
  if (has(CONFIG_REASONS) || /has not been used in project|is disabled/i.test(text)) {
    return make('config', reason ?? 'accessNotConfigured', {}, 'project');
  }
  if (parsed.reason === 'domainPolicy') return make('auth', 'domainPolicy');
  return undefined;
}

function classifyRest({ failure, make, reason }: ApiReading): Classified {
  const { status } = failure;
  if (status === undefined || status === 408 || status >= 500)
    return make('transient', reason ?? `status_${status ?? 0}`);
  if (status >= 200 && status < 300) return make('transient', 'invalidResponse');
  const item = failure.item !== undefined ? { item: failure.item } : {};
  if (status === 404) return make('permanent', reason ?? 'notFound', item);
  return make('permanent', reason ?? `status_${status}`, item);
}

export function classifyGoogle(failure: GoogleFailure): Classified {
  const reading = readFailure(failure);
  if (failure.network) return classifyNetwork(reading, failure.network);
  if (reading.provider === 'oauth') return classifyOAuth(reading);
  const api = readApi(reading);
  return (
    classifySendLimit(api) ??
    classifyConcurrency(api) ??
    classifyDaily(api) ??
    classifyThrottle(api) ??
    classifyAccess(api) ??
    classifyRest(api)
  );
}

/** The error to throw from inside `governor.run`, so the governor sees the class and the scope. */
export function googleError(failure: GoogleFailure): ProviderError {
  const { error, scope } = classifyGoogle(failure);
  return new ProviderError(error, scope);
}

/**
 * Classes after which a step stops and hands back what it has: the governor is now paused or blocked, so going on
 * would only collect `PausedError`s. `transient` and `permanent` are per-call and are handled where they happen.
 */
export const STOP_CLASSES: ReadonlySet<string> = new Set([
  'throttle',
  'daily',
  'send_limit',
  'anti_abuse',
  'auth',
  'permission',
  'config',
]);
