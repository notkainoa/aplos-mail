import { RunnerError } from '../errors';
import type { ProbeContext } from '../types';

/** A probe-side failure with a fixed class name and nothing from the response body. */
export class ProbeHttpError extends RunnerError {
  constructor(readonly errorClass: string) {
    super(`Request failed (${errorClass})`);
    this.name = 'ProbeHttpError';
  }
}

/** Maps an answer to one of the fixed class names in evidence.ts. */
export function errorClassOf(status: number, reason: string | undefined): string {
  if (status === 401) return 'auth';
  if (status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded')
    return 'rate-limit';
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') return 'quota';
  if (status === 404) return 'not-found';
  if (status >= 500) return 'server';
  return 'other';
}

export const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** The parsed answer body: the probes read it as an object whose values stay unknown. */
type JsonBody = Record<string, unknown>;

/** The one field of a Google error body the probe reads: the fixed reason a request failed. */
function errorReason(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return undefined;
  const error = (json as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const errors = (error as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return undefined;
  const first: unknown = errors[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const reason = (first as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : undefined;
}

/**
 * An answer that went through. `empty` is true when Gmail said 200 with nothing in the body (or JSON `null` or `{}`): with a
 * `fields` mask and no matching items Gmail sends that, and a spare account with no drafts or mail is a normal state.
 * `json` is then `{}`, so a caller reads "no items" without a special case.
 */
export interface JsonAnswer {
  json: JsonBody;
  ms: number;
  empty: boolean;
}

/** GET JSON through the guarded fetch. Returns the body and how long it took. */
export function getJson(
  ctx: ProbeContext,
  path: string,
  query: Record<string, string | string[]>,
): Promise<JsonAnswer> {
  return requestJson(ctx, 'GET', path, query);
}

/** POST or PUT a JSON body through the guarded fetch (tier M and S-self probes). */
export function sendJson(
  ctx: ProbeContext,
  method: 'POST' | 'PUT',
  path: string,
  query: Record<string, string | string[]>,
  body: unknown,
): Promise<JsonAnswer> {
  return requestJson(ctx, method, path, query, body);
}

async function requestJson(
  ctx: ProbeContext,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  query: Record<string, string | string[]>,
  body?: unknown,
): Promise<JsonAnswer> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  const started = ctx.now();
  let response: Response;
  try {
    response = await ctx.fetch(
      `${GMAIL_BASE}${path}?${params}`,
      method === 'GET'
        ? undefined
        : {
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
  } catch (error) {
    // A guard refusal is a bug in the probe, so it keeps its own class; anything else is the network.
    throw new ProbeHttpError(
      error instanceof Error && error.name === 'GuardRefusal' ? 'guard' : 'network',
    );
  }
  const text = await response.text();
  const ms = ctx.now() - started;
  let json: unknown;
  let parsed = true;
  try {
    json = text.trim() ? JSON.parse(text) : undefined;
  } catch {
    parsed = false;
  }
  if (!response.ok)
    throw new ProbeHttpError(errorClassOf(response.status, parsed ? errorReason(json) : undefined));
  // Only a name, never any of the text: an unreadable or non-object body is its own class, not "other".
  if (!parsed || (json !== undefined && json !== null && !isObject(json)))
    throw new ProbeHttpError('bad-body');
  if (!isObject(json)) return { json: {}, ms, empty: true };
  return { json, ms, empty: Object.keys(json).length === 0 };
}

const isObject = (value: unknown): value is JsonBody =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
