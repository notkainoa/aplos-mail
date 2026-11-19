import {
  PausedError,
  ProviderError,
  type AdapterContext,
  type BoundGovernor,
  type BudgetId,
  type Clock,
  type GovernedRequest,
  type RequestIo,
  type RequestKind,
  type SyncLane,
} from '@aplos/engine/ports';
import type { ClassifiedError } from '@aplos/contract';
import { googleError, STOP_CLASSES } from './classify';
import { gmailCost, type GmailCostTable, type GmailFormat, type GmailMethod } from './costs';
import { buildBatch, parseBatch } from './mime';

/**
 * The Gmail request layer. Every call goes through `ctx.governor.run` with its price, lane, kind and method: this file
 * has no loop, no retry and no sleep, because pacing and re-sending are the governor's alone (plan 20 PV0, ARCH 6).
 * Every list and get names a `fields` mask (D19), and every request asks for gzip with a User-Agent that says so.
 */

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BATCH_URL = 'https://gmail.googleapis.com/batch/gmail/v1';
const BATCH_PATH = '/gmail/v1/users/me';
/** Gmail's batch guide: 50 or fewer per batch; the governor's AIMD size is clamped to this range. */
const MAX_BATCH = 25;

export interface GmailDeps {
  fetch: typeof fetch;
  costs: GmailCostTable;
  userAgent: string;
  /** Aborted by `ProviderAdapter.close()` (D23). */
  closed: AbortSignal;
}

export type CallContext = Pick<AdapterContext, 'governor' | 'clock' | 'log' | 'signal'>;

export interface GmailRequest {
  method: GmailMethod;
  /** Path below `/users/me`, e.g. `/messages/abc`. */
  path: string;
  query?: Record<string, string | number | readonly string[] | undefined>;
  format?: GmailFormat;
  /** The partial-response mask. Required for reads: the client refuses a list or get without one. */
  fields?: string;
  lane: SyncLane;
  kind?: RequestKind;
  /** The remote item, so a one-item 404 is classified `permanent` with it. */
  item?: string;
  /** Default GET. Writes (`modify`, `trash`) are POSTs; `drafts.delete` is a DELETE. */
  httpMethod?: 'GET' | 'POST' | 'DELETE';
  /** JSON request body of a POST. */
  body?: unknown;
  /** Called with this device's clock as each try goes out, after any wait for the governor (the clock gate's bracket). */
  onSend?: (at: number) => void;
}

export type PartOutcome<T> = { ok: true; data: T } | { ok: false; error: ProviderError };

/** A refusal or pause after which the step should hand back what it has. */
export function isStop(error: unknown): error is PausedError | ProviderError {
  return (
    error instanceof PausedError ||
    (error instanceof ProviderError && STOP_CLASSES.has(error.error.class))
  );
}

export function networkKind(error: unknown): 'timeout' | 'reset' | 'refused' {
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? '';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(code)) return 'refused';
  if (/TIMEOUT/i.test(code) || (error as Error)?.name === 'TimeoutError') return 'timeout';
  return 'reset';
}

export class GmailClient {
  /** Units of the calls Gmail accepted in this client's lifetime (one step): `StepResult.costUnits`. */
  spent = 0;
  private boundaries = 0;

  constructor(
    private readonly deps: GmailDeps,
    private readonly ctx: CallContext,
  ) {}

  cost(req: Pick<GmailRequest, 'method' | 'format'>): number {
    return gmailCost(req.method, req.format, this.deps.costs);
  }

  /** The governor's batch size, clamped to what Gmail handles well. */
  batchSize(): number {
    return Math.max(1, Math.min(MAX_BATCH, Math.floor(this.ctx.governor.batchSize('gmail')) || 1));
  }

  private target(req: GmailRequest): string {
    const params = new URLSearchParams();
    const query = {
      ...req.query,
      ...(req.format ? { format: req.format } : {}),
      ...(req.fields ? { fields: req.fields } : {}),
    };
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const v of value) params.append(key, String(v));
      else params.append(key, String(value));
    }
    const qs = params.toString();
    return `${req.path}${qs ? `?${qs}` : ''}`;
  }

  private headers(
    token: string | undefined,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    return {
      'accept-encoding': 'gzip',
      'user-agent': this.deps.userAgent,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    };
  }

  private signal(): AbortSignal {
    return AbortSignal.any([this.ctx.signal, this.deps.closed]);
  }

  private check(req: GmailRequest): void {
    const read = (req.kind ?? 'read') === 'read';
    if (read && !req.fields) throw new Error(`${req.method} needs a fields mask (D19)`);
  }

  /** One governed call. Throws `ProviderError` (classified) or `PausedError`; resolves with the parsed JSON. */
  async call<T>(req: GmailRequest): Promise<T> {
    this.check(req);
    const kind = req.kind ?? 'read';
    const cost = this.cost(req);
    const asked = this.ctx.clock.now();
    return this.ctx.governor.run(
      { budget: 'gmail', lane: req.lane, kind, method: req.method, cost, signal: this.signal() },
      async io => {
        const started = this.ctx.clock.now();
        req.onSend?.(started);
        const waitMs = started - asked;
        const fail = (error: ProviderError): never => {
          this.ctx.log.event('sync.gmail.request_refused', {
            error: error.error,
            units: cost,
            waitMs,
          });
          throw error;
        };
        let response: Response;
        try {
          response = await this.deps.fetch(`${API}${this.target(req)}`, {
            method: req.httpMethod ?? 'GET',
            headers: this.headers(
              io.accessToken,
              req.body !== undefined ? { 'content-type': 'application/json' } : {},
            ),
            ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
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
          data = parseAnswer<T>(text, response.status, kind);
        } catch {
          return fail(googleError(failure));
        }
        this.spent += cost;
        this.ctx.log.event('sync.gmail.request', {
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

  /**
   * Several reads of one method in one HTTP batch, admitted as one governed request whose cost is the sum of its parts
   * (batching saves round trips, not units). A part Gmail refused inside the 200 is reported to `governor.observe`
   * after `run` resolves and comes back as `{ ok: false }`; it is never re-sent here. Envelope failures and pauses throw.
   */
  async batch<T>(reqs: GmailRequest[], lane: SyncLane): Promise<PartOutcome<T>[]> {
    if (reqs.length === 0) return [];
    reqs.forEach(r => this.check(r));
    if (reqs.length === 1) {
      try {
        return [{ ok: true, data: await this.call<T>({ ...reqs[0], lane }) }];
      } catch (error) {
        if (error instanceof ProviderError && !isStop(error)) return [{ ok: false, error }];
        throw error;
      }
    }
    const costs = reqs.map(r => this.cost(r));
    const cost = costs.reduce((a, b) => a + b, 0);
    // One governed request per batch; a mixed batch (messages and threads) logs as the batch itself.
    const method = reqs.every(r => r.method === reqs[0].method) ? reqs[0].method : 'gmail.batch';
    const boundary = `aplos_batch_${++this.boundaries}`;
    const body = buildBatch(
      reqs.map(r => ({ target: `${BATCH_PATH}${this.target(r)}` })),
      boundary,
    );
    const asked = this.ctx.clock.now();
    let waitMs = 0;
    const parts = await this.ctx.governor.run(
      { budget: 'gmail', lane, kind: 'read', method, cost, signal: this.signal() },
      async io => {
        const started = this.ctx.clock.now();
        waitMs = started - asked;
        const fail = (error: ProviderError): never => {
          this.ctx.log.event('sync.gmail.request_refused', {
            error: error.error,
            units: cost,
            waitMs,
          });
          throw error;
        };
        let response: Response;
        try {
          response = await this.deps.fetch(BATCH_URL, {
            method: 'POST',
            headers: this.headers(io.accessToken, {
              'content-type': `multipart/mixed; boundary=${boundary}`,
            }),
            body,
            signal: io.signal,
          });
        } catch (error) {
          if (io.signal.aborted) throw io.signal.reason ?? error;
          return fail(
            googleError({
              method,
              kind: 'read',
              now: this.ctx.clock.now(),
              network: networkKind(error),
            }),
          );
        }
        const text = await response.text();
        if (!response.ok) {
          return fail(
            googleError({
              method,
              kind: 'read',
              now: this.ctx.clock.now(),
              status: response.status,
              body: text,
              headers: response.headers,
            }),
          );
        }
        try {
          const parsed = parseBatch(response.headers.get('content-type'), text, reqs.length);
          this.ctx.log.event('sync.gmail.request', {
            method: 'gmail.batch',
            status: response.status,
            units: cost,
            durationMs: this.ctx.clock.now() - started,
            waitMs,
          });
          return parsed;
        } catch {
          return fail(
            googleError({
              method,
              kind: 'read',
              now: this.ctx.clock.now(),
              status: response.status,
              body: '',
            }),
          );
        }
      },
    );

    let observed = false;
    return parts.map((part, i): PartOutcome<T> => {
      const req = reqs[i];
      const now = this.ctx.clock.now();
      let error: ProviderError | undefined;
      if (!part)
        error = googleError({
          method: req.method,
          kind: 'read',
          now,
          network: 'reset',
          item: req.item,
        });
      else if (part.status < 200 || part.status >= 300) {
        error = googleError({
          method: req.method,
          kind: 'read',
          now,
          status: part.status,
          body: part.body,
          headers: part.headers,
          item: req.item,
        });
      } else {
        try {
          const data = parseAnswer<T>(part.body, part.status, 'read');
          this.spent += costs[i];
          return { ok: true, data };
        } catch {
          error = googleError({
            method: req.method,
            kind: 'read',
            now,
            status: part.status,
            body: part.body,
          });
        }
      }
      this.ctx.log.event('sync.gmail.request_refused', {
        error: error.error,
        units: costs[i],
        waitMs,
      });
      // One refusal inside a 200 is one event for the governor, however many parts carried it.
      if (!observed && isStop(error)) {
        observed = true;
        this.ctx.governor.observe('gmail', error.error, error.scope);
      }
      return { ok: false, error };
    });
  }
}

// ---- the lane's own pacer ----

/** Half of Google's 6,000 units a minute: other Macs and any older build share the per-user quota (ARCH 6.5). */
export const PACER_TARGET = 3_000;
const PACER_WINDOW_MS = 60_000;

interface Waiter {
  first: boolean;
  cost: number;
  clock: Clock;
  go: () => void;
}

/**
 * The Gmail lane's pacer (plan 20 PV0 item 1), so `prov-gmail` never runs unpaced before `prov-gov`'s governor lands:
 * wrapped around whatever governor the actor passes. A sliding 60-second log of the units sent, a 3,000-unit target,
 * one request in flight, and interactive and op-flush calls first. It only waits: it never sends past the target and
 * never retries, and pauses, refusals and tokens stay the inner governor's. One per adapter, so per account.
 *
 * The budget wait happens in the queue, not while holding the one slot: the next call to go is the first waiter (in
 * queue order, interactive ones before sync) whose cost fits the window now. A background batch that must wait 40 s
 * therefore cannot hold up an open that fits, and a new arrival re-arms the wake-up.
 */
export class GmailPacer {
  private readonly sent: { at: number; cost: number }[] = [];
  private busy = false;
  private readonly queue: Waiter[] = [];
  private wake?: AbortController;

  constructor(
    readonly target = PACER_TARGET,
    readonly windowMs = PACER_WINDOW_MS,
  ) {}

  bind(inner: BoundGovernor, clock: Clock): BoundGovernor {
    return new PacedGovernor(this, inner, clock);
  }

  async run<T>(
    inner: BoundGovernor,
    clock: Clock,
    req: GovernedRequest,
    fn: (io: RequestIo) => Promise<T>,
  ): Promise<T> {
    await this.acquire(
      req.lane === 'interactive' || req.lane === 'opFlush',
      req.cost,
      clock,
      req.signal,
    );
    try {
      return await inner.run(req, async io => {
        // Admission checked the window, so this returns at once; it stays so a re-send by the inner governor is paced.
        await this.room(req.cost, clock, io.signal);
        this.sent.push({ at: clock.now(), cost: req.cost });
        return fn(io);
      });
    } finally {
      this.release();
    }
  }

  private acquire(first: boolean, cost: number, clock: Clock, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const entry: Waiter = {
        first,
        cost,
        clock,
        go: () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        },
      };
      const abort = () => {
        const at = this.queue.indexOf(entry);
        if (at >= 0) this.queue.splice(at, 1);
        reject(signal!.reason);
        this.pump();
      };
      signal?.addEventListener('abort', abort, { once: true });
      // The open the user is waiting for goes ahead of sync, never ahead of another interactive call.
      const at = first ? this.queue.findIndex(w => !w.first) : -1;
      this.queue.splice(at === -1 ? this.queue.length : at, 0, entry);
      this.pump();
    });
  }

  private release(): void {
    this.busy = false;
    this.pump();
  }

  /** Admits the best waiter that fits now, or sleeps until the best group's first waiter will fit. */
  private pump(): void {
    this.wake?.abort();
    this.wake = undefined;
    if (this.busy || this.queue.length === 0) return;
    const group = this.queue.filter(w => w.first === this.queue[0].first);
    const now = group[0].clock.now();
    this.expire(now);
    const waits = group.map(w => this.waitFor(w.cost, now));
    const at = waits.findIndex(wait => wait === 0);
    if (at >= 0) return this.admit(group[at]);
    this.sleepThenPump(group[0].clock, Math.min(...waits));
  }

  private admit(entry: Waiter): void {
    this.queue.splice(this.queue.indexOf(entry), 1);
    this.busy = true;
    entry.go();
  }

  private sleepThenPump(clock: Clock, ms: number): void {
    const wake = new AbortController();
    this.wake = wake;
    clock.sleep(Math.max(1, ms), wake.signal).then(
      () => this.pump(),
      () => undefined,
    );
  }

  private expire(now: number): void {
    while (this.sent.length && this.sent[0].at <= now - this.windowMs) this.sent.shift();
  }

  /** Milliseconds until `cost` fits in the sliding window; a call dearer than the whole target waits for an empty one. */
  private waitFor(cost: number, now: number): number {
    let used = this.sent.reduce((sum, e) => sum + e.cost, 0);
    if (used === 0 || used + cost <= this.target) return 0;
    for (const e of this.sent) {
      used -= e.cost;
      if (used + cost <= this.target) return Math.max(1, e.at + this.windowMs - now);
    }
    return this.windowMs;
  }

  private async room(cost: number, clock: Clock, signal: AbortSignal): Promise<void> {
    for (;;) {
      const now = clock.now();
      this.expire(now);
      const wait = this.waitFor(cost, now);
      if (wait === 0) return;
      await clock.sleep(wait, signal);
    }
  }
}

/** The pacer bound to one call's inner governor and clock; everything but `run` passes straight through. */
class PacedGovernor implements BoundGovernor {
  constructor(
    private readonly pacer: GmailPacer,
    private readonly inner: BoundGovernor,
    private readonly clock: Clock,
  ) {}

  run<T>(req: GovernedRequest, fn: (io: RequestIo) => Promise<T>): Promise<T> {
    return this.pacer.run(this.inner, this.clock, req, fn);
  }

  observe(budget: BudgetId, error: ClassifiedError, scope?: 'account' | 'project'): void {
    this.inner.observe(budget, error, scope);
  }

  charge(budget: BudgetId, amount: number): void {
    this.inner.charge(budget, amount);
  }

  batchSize(budget: BudgetId): number {
    return this.inner.batchSize(budget);
  }
}

/**
 * A 2xx body. `batchModify` answers 204 with no body: success, nothing to parse. A read answers 204 when its `fields`
 * mask leaves nothing (Google drops the empty object: `drafts.list` with no drafts, a search with no hits), which is
 * the empty answer `{}`, never `invalidResponse`. Any other empty or broken body throws.
 */
export function parseAnswer<T>(text: string, status: number, kind: string): T {
  if (text === '' && kind !== 'read') return undefined as T;
  if (text.trim() === '' && status === 204) return {} as T;
  return JSON.parse(text) as T;
}
