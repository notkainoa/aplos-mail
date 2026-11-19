import { ProviderError } from '@aplos/engine/ports';
import type { RequestKind, SyncLane } from '@aplos/engine/ports';
import { googleError } from './classify';
import { networkKind, type CallContext } from './client';
import { gcalCost, type GcalMethod } from './costs';

/**
 * The Calendar request layer (prov-cal): the `gcal` budget's side of `client.ts`. Same rules — every call goes
 * through `ctx.governor.run` with its cost, lane, kind and method, every read names a `fields` mask (D19), pacing and
 * re-sending are the governor's alone. No batch endpoint (Calendar has none we use).
 *
 * Writes (insert, patch, delete) are the same call with an HTTP verb, a JSON body and an optional `If-Match`. Their
 * `kind` decides re-sending: `idempotentWrite` may be re-sent after a transient failure, `write` never is (a lost
 * answer is reported as uncertain, not repeated).
 */

const API = 'https://www.googleapis.com/calendar/v3';

function withoutProviderText(refused: ProviderError): ProviderError {
  const { providerMessage: _text, ...rest } = refused.error;
  return new ProviderError(rest, refused.scope);
}

export interface GcalDeps {
  fetch: typeof fetch;
  userAgent: string;
  /** Aborted by `ProviderAdapter.close()` (D23). */
  closed: AbortSignal;
}

export interface GcalRequest {
  method: GcalMethod;
  /** The HTTP verb; a read when absent. */
  http?: 'POST' | 'PATCH' | 'DELETE';
  /** The JSON body of a POST or PATCH. */
  body?: unknown;
  /** `If-Match`: the etag the write is based on. A 412 answers that the event changed since. */
  ifMatch?: string;
  /** Path below `/calendar/v3`, e.g. `/users/me/calendarList` or `/calendars/<id>/events`. */
  path: string;
  query?: Record<string, string | number | boolean | readonly string[] | undefined>;
  /** The partial-response mask. Required for reads: the client refuses a list or get without one. */
  fields?: string;
  lane: SyncLane;
  kind?: RequestKind;
  /** The remote item, so a one-item 404 is classified `permanent` with it. */
  item?: string;
  /** Per-request timeout: a hung call fails instead of holding the governor slot (writes set one). */
  timeoutMs?: number;
}

export class GcalClient {
  /** Requests accepted in this client's lifetime (one step): `CalendarStepResult.costUnits`. */
  spent = 0;

  constructor(
    private readonly deps: GcalDeps,
    private readonly ctx: CallContext,
  ) {}

  private target(req: GcalRequest): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...req.query, fields: req.fields })) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const v of value) params.append(key, String(v));
      else params.append(key, String(value));
    }
    const qs = params.toString();
    return `${req.path}${qs ? `?${qs}` : ''}`;
  }

  private signal(): AbortSignal {
    return AbortSignal.any([this.ctx.signal, this.deps.closed]);
  }

  /** One governed call. Throws `ProviderError` (classified) or `PausedError`; resolves with the parsed JSON. */
  async call<T>(req: GcalRequest): Promise<T> {
    const kind = req.kind ?? 'read';
    if (req.http === undefined && kind !== 'read') throw new Error(`${req.method} is a read`);
    if (req.http !== undefined && kind === 'read') throw new Error(`${req.method} is a write`);
    if (kind === 'read' && !req.fields) throw new Error(`${req.method} needs a fields mask (D19)`);
    const cost = gcalCost(req.method);
    const asked = this.ctx.clock.now();
    return this.ctx.governor.run(
      { budget: 'gcal', lane: req.lane, kind, method: req.method, cost, signal: this.signal() },
      async io => {
        const started = this.ctx.clock.now();
        const waitMs = started - asked;
        const fail = (refused: ProviderError): never => {
          // A write's refusal can quote what was written (a title, a guest address) in Google's own text: it
          // never reaches the log or the error, only the class, status and reason do.
          const error = kind === 'read' ? refused : withoutProviderText(refused);
          this.ctx.log.event('sync.gcal.request_refused', {
            error: error.error,
            units: cost,
            waitMs,
          });
          throw error;
        };
        // The request's own deadline starts when it is sent, not while it waits in the governor.
        const deadline =
          req.timeoutMs !== undefined ? AbortSignal.timeout(req.timeoutMs) : undefined;
        let response: Response;
        try {
          response = await this.deps.fetch(`${API}${this.target(req)}`, {
            method: req.http ?? 'GET',
            headers: {
              'accept-encoding': 'gzip',
              'user-agent': this.deps.userAgent,
              ...(io.accessToken ? { authorization: `Bearer ${io.accessToken}` } : {}),
              ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
              ...(req.ifMatch !== undefined ? { 'if-match': req.ifMatch } : {}),
            },
            ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
            signal: deadline ? AbortSignal.any([io.signal, deadline]) : io.signal,
          });
        } catch (error) {
          // Our own deadline is a network timeout: for a write, the answer is lost and the outcome uncertain.
          if (io.signal.aborted) throw io.signal.reason ?? error;
          const timedOut = deadline?.aborted === true;
          return fail(
            googleError({
              method: req.method,
              kind,
              now: this.ctx.clock.now(),
              network: timedOut ? 'timeout' : networkKind(error),
              item: req.item,
            }),
          );
        }
        const text = await response.text();
        const failure = {
          method: req.method,
          kind,
          now: this.ctx.clock.now(),
          status: response.status,
          body: text,
          headers: response.headers,
          item: req.item,
        };
        if (!response.ok) return fail(googleError(failure));
        let data: T;
        try {
          // A DELETE answers 204 with no body.
          data = (text === '' && req.http === 'DELETE' ? {} : JSON.parse(text)) as T;
        } catch {
          return fail(googleError(failure));
        }
        this.spent += cost;
        this.ctx.log.event('sync.gcal.request', {
          method: req.method,
          status: response.status,
          units: cost,
          durationMs: this.ctx.clock.now() - started,
          waitMs,
        });
        return data;
      },
    );
  }
}
