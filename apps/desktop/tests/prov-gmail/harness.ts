/**
 * Shared rig for the prov-gmail tests: the Gmail emulator on a fake clock, a pass-through governor stub, the engine's
 * real store (`store-rig.ts`) fed StepResults the way the actor feeds it, and a capturing logger. Holds no tests of its own; it is named
 * `*.test.ts` only because the lane may add test files and nothing else under `tests/`.
 *
 * The governor stub stands in for prov-gov's governor until day 7 (plan 20 PV0 item 1): a sliding 60 s window with a
 * 3,000-unit target, one request in flight with the interactive lane first, PausedError before any I/O while paused or
 * blocked, one forced token refresh after a first 401, and a record of every call.
 */
import type { ClassifiedError } from '@aplos/contract';
import type { LogContext } from '@aplos/contract/log/events';
import {
  PausedError,
  ProviderError,
  type AdapterAccount,
  type AdapterContext,
  type BoundGovernor,
  type BudgetId,
  type GovernedRequest,
  type Logger,
  type PlanEnv,
  type PlanTrigger,
  type RequestIo,
  type RequestKind,
  type ScopeId,
  type StepResult,
  type SyncLane,
  type WorkflowCopy,
} from '@aplos/engine/ports';
import {
  FakeClock,
  SCOPE,
  createGmailEmulator,
  type GmailEmulator,
  type GmailEmulatorOptions,
} from '@aplos/emulators';
import { GmailAdapter, type GoogleProviderOptions } from '../../src/host/providers/google/adapter';
import { RigStore } from './store-rig';
import { googleError } from '../../src/host/providers/google/classify';

export const CLIENT_ID = 'prov-gmail-tests.apps.example.test';
export const ACCOUNT_ID = 'acct-gmail-1';
export const GMAIL_SCOPES = [
  'openid',
  'email',
  'profile',
  SCOPE.gmailModify,
  SCOPE.gmailSettingsBasic,
];

// ---- tokens ----

/** The host's TokenSource, cut down: one cached access token and a refresh against the emulator's token endpoint. */
export class TokenStub {
  refreshes = 0;
  constructor(
    private readonly emu: GmailEmulator,
    public access: string,
    public refreshToken: string,
    public expiresAt: number,
  ) {}

  cached(now: number): string | undefined {
    return now < this.expiresAt - 60_000 ? this.access : undefined;
  }

  async refresh(now: () => number): Promise<string> {
    this.refreshes++;
    const response = await this.emu.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    const text = await response.text();
    if (!response.ok)
      throw googleError({
        method: 'oauth.token',
        kind: 'idempotentWrite',
        now: now(),
        status: response.status,
        body: text,
      });
    const json = JSON.parse(text) as { access_token: string; expires_in: number };
    this.access = json.access_token;
    this.expiresAt = now() + json.expires_in * 1000;
    return this.access;
  }
}

// ---- governor stub ----

export interface GovCall {
  at: number;
  method: string;
  cost: number;
  lane: SyncLane;
  kind: RequestKind;
  outcome: 'sent' | 'paused';
}

export class StubGovernor implements BoundGovernor {
  readonly calls: GovCall[] = [];
  readonly errors: { error: ClassifiedError; scope: 'account' | 'project' }[] = [];
  /** Dispatched units by time, for the sliding window. */
  readonly dispatched: { at: number; cost: number }[] = [];
  maxInFlight = 0;
  pausedUntil = 0;
  dailyUntil = 0;
  blocked?: { cls: 'auth' | 'config'; reason: string };
  lastReason = '';
  /** Test hook: pause (as a refusal elsewhere would) once this many more requests have been sent. */
  pauseAfter?: number;
  private inFlight = 0;
  private readonly waiting: { interactive: boolean; go: () => void }[] = [];

  constructor(
    private readonly clock: FakeClock,
    private readonly tokens: TokenStub | undefined,
    readonly target = 3_000,
    private readonly size = 10,
  ) {}

  private refusal(): PausedError | undefined {
    const now = this.clock.now();
    if (this.blocked)
      return new PausedError(ACCOUNT_ID, 'gmail', this.blocked.cls, this.blocked.reason);
    if (this.dailyUntil > now)
      return new PausedError(ACCOUNT_ID, 'gmail', 'daily', this.lastReason, this.dailyUntil);
    if (this.pausedUntil > now)
      return new PausedError(ACCOUNT_ID, 'gmail', 'throttle', this.lastReason, this.pausedUntil);
    return undefined;
  }

  private async slot(interactive: boolean): Promise<void> {
    if (this.inFlight === 0 && this.waiting.length === 0) {
      this.inFlight = 1;
      return;
    }
    await new Promise<void>(go => {
      const entry = { interactive, go };
      // The interactive open jumps the queue but still waits for the one request in flight.
      if (interactive) {
        const at = this.waiting.findIndex(w => !w.interactive);
        this.waiting.splice(at === -1 ? this.waiting.length : at, 0, entry);
      } else this.waiting.push(entry);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next.go();
    else this.inFlight = 0;
  }

  /** Milliseconds until `cost` fits in the sliding window, 0 when it fits now. */
  private budgetWait(cost: number): number {
    const now = this.clock.now();
    const live = this.dispatched.filter(d => d.at > now - 60_000);
    let used = live.reduce((sum, d) => sum + d.cost, 0);
    if (used + cost <= this.target) return 0;
    for (const d of live) {
      used -= d.cost;
      if (used + cost <= this.target) return d.at + 60_000 - now;
    }
    return 60_000;
  }

  private async token(): Promise<string | undefined> {
    if (!this.tokens) return undefined;
    return this.tokens.cached(this.clock.now()) ?? (await this.refresh());
  }

  private async refresh(): Promise<string> {
    const paused = this.refusal();
    if (paused) throw paused;
    this.calls.push({
      at: this.clock.now(),
      method: 'oauth.token',
      cost: 0,
      lane: 'interactive',
      kind: 'idempotentWrite',
      outcome: 'sent',
    });
    try {
      return await this.tokens!.refresh(() => this.clock.now());
    } catch (error) {
      if (error instanceof ProviderError) this.apply(error.error, error.scope);
      throw error;
    }
  }

  async run<T>(req: GovernedRequest, fn: (io: RequestIo) => Promise<T>): Promise<T> {
    try {
      return await this.attempt(req, fn, true);
    } catch (error) {
      // One forced refresh after a first 401, then one more attempt; a second 401 blocks the account.
      if (
        error instanceof ProviderError &&
        error.error.class === 'auth' &&
        error.error.status === 401 &&
        this.tokens
      ) {
        await this.refresh();
        return this.attempt(req, fn, false);
      }
      throw error;
    }
  }

  private async attempt<T>(
    req: GovernedRequest,
    fn: (io: RequestIo) => Promise<T>,
    first: boolean,
  ): Promise<T> {
    const early = this.refusal();
    if (early) {
      this.calls.push({
        at: this.clock.now(),
        method: req.method,
        cost: req.cost,
        lane: req.lane,
        kind: req.kind,
        outcome: 'paused',
      });
      throw early;
    }
    await this.slot(req.lane === 'interactive');
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      for (;;) {
        const paused = this.refusal();
        if (paused) {
          this.calls.push({
            at: this.clock.now(),
            method: req.method,
            cost: req.cost,
            lane: req.lane,
            kind: req.kind,
            outcome: 'paused',
          });
          throw paused;
        }
        const wait = this.budgetWait(req.cost);
        if (wait <= 0) break;
        await this.clock.sleep(wait, req.signal);
      }
      const accessToken = req.auth === false ? undefined : await this.token();
      if (this.pauseAfter !== undefined && this.pauseAfter-- <= 0) {
        this.pauseAfter = undefined;
        this.pausedUntil = this.clock.now() + 60_000;
        this.lastReason = 'rateLimitExceeded';
        throw this.refusal()!;
      }
      this.dispatched.push({ at: this.clock.now(), cost: req.cost });
      this.calls.push({
        at: this.clock.now(),
        method: req.method,
        cost: req.cost,
        lane: req.lane,
        kind: req.kind,
        outcome: 'sent',
      });
      try {
        return await fn({
          signal: req.signal ?? new AbortController().signal,
          ...(accessToken ? { accessToken } : {}),
        });
      } catch (error) {
        if (error instanceof ProviderError && !(first && error.error.status === 401 && this.tokens))
          this.apply(error.error, error.scope);
        throw error;
      }
    } finally {
      this.release();
    }
  }

  apply(error: ClassifiedError, scope: 'account' | 'project' = 'account'): void {
    this.errors.push({ error, scope });
    const now = this.clock.now();
    this.lastReason = error.reason;
    if (error.class === 'throttle') this.pausedUntil = now + (error.retryAfterMs ?? 60_000);
    if (error.class === 'daily') this.dailyUntil = error.resumeAt ?? now + 86_400_000;
    if (error.class === 'auth' || error.class === 'config')
      this.blocked = { cls: error.class, reason: error.reason };
  }

  observe(_budget: BudgetId, error: ClassifiedError, scope?: 'account' | 'project'): void {
    this.apply(error, scope);
  }

  charge(): void {}

  batchSize(): number {
    return this.size;
  }

  sentCalls(): GovCall[] {
    return this.calls.filter(c => c.outcome === 'sent');
  }
}

// ---- logger ----

export interface LogLine {
  event: string;
  fields: Record<string, unknown>;
  context: LogContext;
}

/** A raw capture: no redaction, so a test sees exactly what the adapter handed the Logger. */
export class CaptureLog implements Logger {
  constructor(
    readonly lines: LogLine[] = [],
    private readonly context: LogContext = {},
  ) {}
  event(id: string, fields: object): void {
    this.lines.push({
      event: id,
      fields: { ...(fields as Record<string, unknown>) },
      context: this.context,
    });
  }
  with(context: LogContext): Logger {
    return new CaptureLog(this.lines, { ...this.context, ...context });
  }
  enabled(): boolean {
    return true;
  }
}

// ---- the rig ----

export interface FetchRecord {
  at: number;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body?: string;
}

export interface Rig {
  clock: FakeClock;
  emu: GmailEmulator;
  tokens: TokenStub;
  governor: StubGovernor;
  store: RigStore;
  log: CaptureLog;
  adapter: GmailAdapter;
  account: AdapterAccount;
  /** Every request the adapter (and the token stub) sent, with the path and query; Gmail ids stay in memory only. */
  fetches: FetchRecord[];
  ctx(): AdapterContext;
  env(focused?: boolean): PlanEnv;
  /** The `workflow` round's copies, the actor's `onWorkflowCopies` hook: feed them to a state channel's `ingest`. */
  onWorkflowCopies?: (copies: WorkflowCopy[]) => void;
  /** One `workflow` round as the actor runs it: the channel's round, copies delivered, as a `StepResult`. */
  workflowRound(scope: ScopeId): Promise<StepResult>;
  /** Runs planned steps the way the actor will, until `until` holds, nothing is runnable, or a step stops short. */
  drive(opts?: {
    trigger?: PlanTrigger;
    until?: () => boolean;
    scopes?: ScopeId[];
    maxSteps?: number;
  }): Promise<number>;
  /** Gmail ids fetched by `messages.get` (single or batched), in order. */
  messageGets(): string[];
  /** Every metadata fetch in order: a message id for `messages.get`, `thread:<id>` for `threads.get`. */
  metadataGets(): string[];
}

/** Distinct threads among a step's upserts (a `threads.get` entry upserts every message of its thread). */
export const upsertThreads = (result: StepResult | undefined): number =>
  new Set((result?.upserts ?? []).map(u => u.remoteThreadId)).size;

export interface RigOptions {
  threads?: number;
  seed?: number;
  emulator?: Partial<GmailEmulatorOptions>;
  adapter?: Partial<GoogleProviderOptions>;
  target?: number;
  batch?: number;
}

export async function rig(options: RigOptions = {}): Promise<Rig> {
  const clock = new FakeClock();
  // retryAfter pinned to 'none' as in the legacy D1 gate: the verdict must not depend on a header Gmail may not send.
  const emu = createGmailEmulator({ clock, retryAfter: 'none', ...options.emulator });
  emu.oauth.addClient(CLIENT_ID);
  if (options.threads) emu.seedMailbox({ threads: options.threads, seed: options.seed ?? 23 });
  const session = await emu.oauth.signIn({
    clientId: CLIENT_ID,
    scopes: GMAIL_SCOPES,
    fetch: emu.fetch,
  });
  const tokens = new TokenStub(
    emu,
    session.accessToken,
    session.refreshToken!,
    clock.now() + Number(session.response.expires_in) * 1000,
  );
  const governor = new StubGovernor(clock, tokens, options.target ?? 3_000, options.batch ?? 10);
  const log = new CaptureLog();
  const fetches: FetchRecord[] = [];
  const spy: typeof fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    fetches.push({
      at: clock.now(),
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: new Headers(init?.headers),
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
    return emu.fetch(input, init);
  };
  const user = emu.users()[0];
  const account: AdapterAccount = {
    id: ACCOUNT_ID,
    provider: 'google',
    address: user.email,
    grantedScopes: GMAIL_SCOPES,
    capabilities: {
      labels: true,
      folders: false,
      drafts: true,
      serverSearch: true,
      calendar: false,
      filters: true,
      push: false,
      sendAs: true,
      unsubscribeHeaders: true,
      threading: 'native',
    },
  };
  const adapter = new GmailAdapter(account, { fetch: spy, ...options.adapter });
  const store = new RigStore(account, () => clock.now());
  const stopper = new AbortController();
  const r: Rig = {
    clock,
    emu,
    tokens,
    governor,
    store,
    log,
    adapter,
    account,
    fetches,
    ctx: () => ({
      account,
      governor,
      clock: {
        now: () => clock.now(),
        sleep: (ms, s) => clock.sleep(ms, s),
        timer: () => ({ cancel() {} }),
      },
      log: log.with({ account: ACCOUNT_ID }),
      signal: stopper.signal,
      lookup: store.lookup,
      memory: store.memory,
      generation: store.seq,
    }),
    async workflowRound(scope: ScopeId): Promise<StepResult> {
      const round = await adapter.workflow!.round(store.state(scope), r.ctx());
      r.onWorkflowCopies?.(round.copies);
      return { nextStates: [round.nextState], done: true, costUnits: round.costUnits };
    },
    env: (focused = true) => ({
      now: clock.now(),
      focused,
      windowVisible: focused,
      onBattery: false,
    }),
    async drive(opts = {}) {
      let trigger: PlanTrigger = opts.trigger ?? 'first';
      let ran = 0;
      for (; ran < (opts.maxSteps ?? 500); ran++) {
        if (opts.until?.()) break;
        const steps = adapter.plan({
          account,
          states: [...store.states.values()],
          trigger,
          env: r.env(),
          memory: store.memory,
        });
        const step = steps.find(
          s => (s.notBefore ?? 0) <= clock.now() && (!opts.scopes || opts.scopes.includes(s.scope)),
        );
        if (!step) break;
        const fence = store.seq;
        // The `workflow` scope runs the channel's round, not `syncStep` — exactly as the actor does.
        const result =
          step.scope === 'workflow' && adapter.workflow
            ? await r.workflowRound(step.scope)
            : await adapter.syncStep(step, store.state(step.scope), r.ctx());
        store.commit(step, result, clock.now(), fence);
        trigger = 'poll';
        if (!result.done) {
          ran++;
          break;
        }
      }
      return ran;
    },
    messageGets() {
      const ids: string[] = [];
      for (const f of fetches) {
        const direct = /\/messages\/([0-9a-f]+)$/.exec(f.path);
        if (direct && f.query.get('format') === 'metadata') ids.push(direct[1]);
        if (f.body)
          for (const m of f.body.matchAll(
            /GET \/gmail\/v1\/users\/me\/messages\/([0-9a-f]+)\?[^ ]*format=metadata/g,
          ))
            ids.push(m[1]);
      }
      return ids;
    },
    metadataGets() {
      const out: string[] = [];
      const add = (path: string, query: string) => {
        if (!/[?&]format=metadata/.test(`?${query}`)) return;
        const m = /\/(messages|threads)\/([0-9a-f]+)$/.exec(path);
        if (m) out.push(m[1] === 'threads' ? `thread:${m[2]}` : m[2]);
      };
      for (const f of fetches) {
        add(f.path, f.query.toString());
        if (f.body)
          for (const m of f.body.matchAll(
            /GET \/gmail\/v1\/users\/me(\/(?:messages|threads)\/[0-9a-f]+)\?(\S*) HTTP/g,
          ))
            add(m[1], m[2]);
      }
      return out;
    },
  };
  return r;
}

/** Gmail requests in the emulator log (batch envelopes and the OAuth endpoint excluded), optionally from `since`. */
export function gmailLog(emu: GmailEmulator, since = 0) {
  return emu.log.filter(
    e => e.service === 'gmail' && e.apiMethod !== 'gmail.batch' && e.at >= since,
  );
}

/** Highest units the emulator charged in any 60 s window, recomputed from its own request log. */
export function peakWindowUnits(emu: GmailEmulator): number {
  const charged = emu.log.filter(e => e.units > 0).map(e => ({ at: e.at, units: e.units }));
  let peak = 0;
  for (const end of charged) {
    const sum = charged
      .filter(c => c.at > end.at - 60_000 && c.at <= end.at)
      .reduce((a, c) => a + c.units, 0);
    peak = Math.max(peak, sum);
  }
  return peak;
}

export const refusals = (emu: GmailEmulator, since = 0) =>
  emu.log.filter(e => e.at >= since && (e.status === 403 || e.status === 429));
