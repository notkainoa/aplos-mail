/**
 * Shared rig for the prov-gmail tests: the Gmail emulator on a fake clock, a pass-through governor stub, a fake store
 * that commits StepResults the way the actor will, and a capturing logger. Holds no tests of its own; it is named
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
  type FolderFacts,
  type GovernedRequest,
  type KnownLookup,
  type Logger,
  type MessageFacts,
  type PlanEnv,
  type PlannedStep,
  type PlanTrigger,
  type Placement,
  type RemoteDraftFact,
  type RequestIo,
  type RequestKind,
  type ScopeId,
  type StepResult,
  type SyncLane,
  type SyncState,
} from '@aplos/engine/ports';
import {
  FakeClock,
  SCOPE,
  createGmailEmulator,
  type GmailEmulator,
  type GmailEmulatorOptions,
} from '@aplos/emulators';
import { GmailAdapter, type GoogleProviderOptions } from '../../src/host/providers/google/adapter';
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

// ---- store ----

interface Row {
  facts: MessageFacts;
  /** Folder -> seen generation (null: written by history, open or search). */
  folders: Map<string, number | null>;
  seen: boolean;
  flagged: boolean;
}

const ROUND_SCOPES = new Set<ScopeId>(['window:inbox', 'backfill:inbox', 'sent:recent']);

export interface Commit {
  at: number;
  step: PlannedStep;
  result: StepResult;
}

/** The actor's commit, cut down to what the adapter's facts mean (no SQL, no change log). */
export class FakeStore implements KnownLookup {
  readonly rows = new Map<string, Row>();
  readonly states = new Map<ScopeId, SyncState>();
  readonly memory = new Map<string, string>();
  readonly folders = new Map<string, FolderFacts>();
  readonly drafts = new Map<string, RemoteDraftFact>();
  readonly tracked = new Set<string>();
  /** Message id -> draft id of the copies this device wrote (`drafts.remote_message_id`). */
  readonly ownDrafts = new Map<string, string>();
  readonly commits: Commit[] = [];
  readonly swept: string[] = [];
  seq = 0;
  baselineAt?: number;

  async knownThreads(ids: string[]): Promise<ReadonlySet<string>> {
    const all = new Set([...this.rows.values()].map(r => r.facts.remoteThreadId));
    return new Set(ids.filter(id => all.has(id)));
  }
  async knownMessages(ids: string[]): Promise<ReadonlySet<string>> {
    return new Set(ids.filter(id => this.rows.has(id)));
  }
  async trackedDraftIds(ids: string[]): Promise<ReadonlySet<string>> {
    return new Set(ids.filter(id => this.tracked.has(id)));
  }
  async draftsByMessageId(ids: string[]): Promise<ReadonlyMap<string, string>> {
    return new Map(
      ids.filter(id => this.ownDrafts.has(id)).map(id => [id, this.ownDrafts.get(id)!]),
    );
  }
  async threadMessages(threadId: string): Promise<{ remoteId: string; placements: Placement[] }[]> {
    return [...this.rows.values()]
      .filter(r => r.facts.remoteThreadId === threadId)
      .map(r => ({
        remoteId: r.facts.remoteId,
        placements: [...r.folders.keys()].map(folder => ({ folder })),
      }));
  }
  async placements(ids: string[]): Promise<ReadonlyMap<string, Placement[]>> {
    return new Map(
      ids
        .filter(id => this.rows.has(id))
        .map(id => [id, [...this.rows.get(id)!.folders.keys()].map(folder => ({ folder }))]),
    );
  }
  async folderUids(): Promise<number[]> {
    return [];
  }
  async eventEtags(): Promise<ReadonlyMap<string, string>> {
    return new Map();
  }

  state(scope: ScopeId): SyncState {
    return this.states.get(scope) ?? { scope, generation: 0, updatedAt: 0 };
  }

  commit(step: PlannedStep, result: StepResult, now: number): void {
    this.commits.push({ at: now, step, result });
    const own = result.nextStates.find(s => s.scope === step.scope);
    const stamp = ROUND_SCOPES.has(step.scope) && own ? own.generation : null;
    for (const f of result.folders ?? []) this.folders.set(f.remoteId, f);
    for (const facts of result.upserts ?? []) {
      const before = this.rows.get(facts.remoteId);
      const folders = new Map<string, number | null>();
      for (const p of facts.placements)
        folders.set(p.folder, stamp ?? before?.folders.get(p.folder) ?? null);
      this.rows.set(facts.remoteId, {
        facts,
        folders,
        seen: facts.flags.seen,
        flagged: facts.flags.flagged,
      });
    }
    for (const p of result.placements ?? []) {
      const row = p.remoteId ? this.rows.get(p.remoteId) : undefined;
      if (!row) continue;
      if (!p.present) row.folders.delete(p.folder);
      else {
        const old = row.folders.get(p.folder);
        row.folders.set(p.folder, stamp === null ? (old ?? null) : Math.max(old ?? stamp, stamp));
      }
    }
    for (const d of result.labelDeltas ?? []) {
      const row = this.rows.get(d.remoteId);
      if (!row) continue;
      for (const l of d.add) if (!row.folders.has(l)) row.folders.set(l, null);
      for (const l of d.remove) row.folders.delete(l);
    }
    for (const d of result.flagDeltas ?? []) {
      const row = d.remoteId ? this.rows.get(d.remoteId) : undefined;
      if (!row) continue;
      if (d.seen !== undefined) row.seen = d.seen;
      if (d.flagged !== undefined) row.flagged = d.flagged;
    }
    for (const r of result.removals ?? []) this.rows.delete(r.remoteId);
    for (const d of result.drafts ?? []) this.drafts.set(d.remoteDraftId, d);
    if (result.scopeCovered) {
      const { bound, generation } = result.scopeCovered;
      for (const [id, row] of this.rows) {
        const gen = row.folders.get(bound.folder);
        const date = row.facts.internalDate;
        if (gen === undefined || gen === null || gen >= generation) continue;
        if (bound.since !== undefined && !(date > bound.since)) continue;
        if (bound.until !== undefined && !(date < bound.until)) continue;
        row.folders.delete(bound.folder);
        this.swept.push(id);
      }
    }
    for (const s of result.nextStates) this.states.set(s.scope, s);
    for (const [k, v] of Object.entries(result.memory ?? {})) {
      if (v === null) this.memory.delete(k);
      else this.memory.set(k, v);
    }
    if (result.baselineReached && this.baselineAt === undefined) this.baselineAt = now;
  }

  /** Threads with at least one message in `folder`. */
  threadsIn(folder: string): Set<string> {
    return new Set(
      [...this.rows.values()].filter(r => r.folders.has(folder)).map(r => r.facts.remoteThreadId),
    );
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
  store: FakeStore;
  log: CaptureLog;
  adapter: GmailAdapter;
  account: AdapterAccount;
  /** Every request the adapter (and the token stub) sent, with the path and query; Gmail ids stay in memory only. */
  fetches: FetchRecord[];
  ctx(): AdapterContext;
  env(focused?: boolean): PlanEnv;
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
  const store = new FakeStore();
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
      lookup: store,
      memory: store.memory,
      generation: ++store.seq,
    }),
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
        const result = await adapter.syncStep(step, store.state(step.scope), r.ctx());
        store.commit(step, result, clock.now());
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
