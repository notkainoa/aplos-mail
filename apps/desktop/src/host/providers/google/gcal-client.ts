import { ProviderError } from '@aplos/engine/ports';
import type { RequestKind, SyncLane } from '@aplos/engine/ports';
import { googleError } from './classify';
import { networkKind, type CallContext } from './client';
import { gcalCost, type GcalMethod } from './costs';

/**
 * The Calendar request layer (prov-cal): the `gcal` budget's side of `client.ts`. Same rules — every call goes
 * through `ctx.governor.run` with its cost, lane, kind and method, every read names a `fields` mask (D19), pacing and
 * re-sending are the governor's alone. No batch endpoint (Calendar has none we use).
 */

const API = 'https://www.googleapis.com/calendar/v3';

export interface GcalDeps {
  fetch: typeof fetch;
  userAgent: string;
  /** Aborted by `ProviderAdapter.close()` (D23). */
  closed: AbortSignal;
}

export interface GcalRequest {
  method: GcalMethod;
  /** Path below `/calendar/v3`, e.g. `/users/me/calendarList` or `/calendars/<id>/events`. */
  path: string;
  query?: Record<string, string | number | boolean | readonly string[] | undefined>;
  /** The partial-response mask. Required for reads: the client refuses a list or get without one. */
  fields?: string;
  lane: SyncLane;
  kind?: RequestKind;
  /** The remote item, so a one-item 404 is classified `permanent` with it. */
  item?: string;
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
    if (kind === 'read' && !req.fields) throw new Error(`${req.method} needs a fields mask (D19)`);
    const cost = gcalCost(req.method);
    const asked = this.ctx.clock.now();
    return this.ctx.governor.run(
      { budget: 'gcal', lane: req.lane, kind, method: req.method, cost, signal: this.signal() },
      async io => {
        const started = this.ctx.clock.now();
        const waitMs = started - asked;
        const fail = (error: ProviderError): never => {
          this.ctx.log.event('sync.gcal.request_refused', {
            error: error.error,
            units: cost,
            waitMs,
          });
          throw error;
        };
        let response: Response;
        try {
          response = await this.deps.fetch(`${API}${this.target(req)}`, {
            method: 'GET',
            headers: {
              'accept-encoding': 'gzip',
              'user-agent': this.deps.userAgent,
              ...(io.accessToken ? { authorization: `Bearer ${io.accessToken}` } : {}),
            },
            signal: io.signal,
          });
        } catch (error) {
          if (io.signal.aborted) throw io.signal.reason ?? error;
          return fail(
            googleError({
              method: req.method,
              kind,
              now: this.ctx.clock.now(),
              network: networkKind(error),
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
          data = JSON.parse(text) as T;
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
