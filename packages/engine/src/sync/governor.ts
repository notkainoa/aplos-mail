import type { ClassifiedError, ErrorClass } from '@aplos/contract';
import {
  NotSentError,
  PausedError,
  PROJECT,
  ProviderError,
  type AccountId,
  type Admission,
  type BoundGovernor,
  type BudgetId,
  type BudgetSpec,
  type Clock,
  type GovernedRequest,
  type GovernorPort,
  type GovernorSnapshot,
  type Logger,
  type ProjectScope,
  type RequestIo,
  type RequestKind,
  type SyncLane,
  type TokenSource,
} from '../ports';
import { LANES, PRIORITY_LANES, defaultBudgets } from './budgets';
import { nextPacificMidnight } from './pacific';
import { SlidingWindow, type Charge } from './window';

/** Throttle cooldowns: 60 s, then 5 min, then 15 min, then 1 h at most (ARCH 6.3). */
export const COOLDOWN_STEPS_MS: readonly number[] = [60_000, 300_000, 900_000, 3_600_000];
/** Quiet time that resets the escalation, starts AIMD regrowth and gives back one in-flight slot. */
export const QUIET_MS = 600_000;
/** AIMD regrows once per minute after the quiet period. */
export const REGROW_INTERVAL_MS = 60_000;
/** Transient failures of reads and idempotent writes: three tries in total, waiting 1 s then 2 s (jittered). */
export const TRANSIENT_TRIES = 3;
export const TRANSIENT_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];
/** Google Calendar's anti-abuse `quotaExceeded` when the provider gives no time (plan 20). */
export const ANTI_ABUSE_MS = 3 * 3600_000;
/**
 * A send limit with no stated end blocks sends for an hour (proto-google 2.5: "can persist for hours"). A design
 * choice: the submission fails "until HH:MM" and the user may try again then.
 */
export const SEND_LIMIT_MS = 3600_000;
/**
 * The persisted window spend (`windowSpent`) is reserved in steps of this share of the primary target and refreshed
 * at least this often while units are spent, so `onChange` fires a few times a minute under load, not per request.
 */
export const RESERVE_STEP_SHARE = 0.1;
export const RESERVE_REFRESH_MS = 15_000;
/** A cached access token closer than this to expiry is refreshed first. */
export const TOKEN_EARLY_MS = 60_000;
/** The latest instant a Date can hold; longer waits are clamped to it. */
const MAX_TIME = 8.64e15;

export type DeviceRole = 'primary' | 'secondary';
type Scope = AccountId | ProjectScope;

export type GovernorLogEvent =
  'governor.admitted' | 'governor.paused' | 'governor.resumed' | 'governor.refused';
/** The only fields the trace hook gets: no content, tokens or addresses. */
export interface GovernorLogFields {
  account: Scope;
  budget: BudgetId;
  lane?: SyncLane;
  method?: string;
  units?: number;
  waitMs?: number;
  cls?: ErrorClass;
  reason?: string;
  status?: number;
}
/** A per-request trace hook for tests and the verbose protocol log; the F7 `Logger` gets the catalog events. */
export type GovernorLogger = (event: GovernorLogEvent, fields: GovernorLogFields) => void;

export interface GovernorOptions {
  /** Only `now` and `sleep`: the governor never arms a timer of its own. */
  clock: Pick<Clock, 'now' | 'sleep'>;
  /** Specs for every account until `setBudgets` gives an account its own. */
  budgets?: readonly BudgetSpec[];
  /** The host's token source; without one no request carries a token and a 401 is an auth block at once. */
  tokens?: TokenSource;
  /** The classifier registry. Falls back to a thrown `ProviderError`'s record; anything else is `transient`. */
  classify?: (error: unknown) => ClassifiedError | undefined;
  logger?: GovernorLogger;
  /** F7 catalog events (`governor.paused`, `governor.resumed`). */
  log?: Logger;
  /** Role before the lease says otherwise. Defaults to the conservative 'secondary' (ARCH 6.5). */
  role?: DeviceRole;
  /** Source of retry jitter, for reproducible tests. */
  random?: () => number;
}

/** What `run` may be told beyond the port: connect-time calls ignore the account's auth block (F3 `ConnectContext`). */
export interface RunMode {
  ignoreAuth?: boolean;
}

/** Live numbers that change on every request, for tests and diagnostics; never persisted. */
export interface MeterView {
  used: number;
  inFlight: number;
  inFlightLimit: number;
  target: number;
  queued: number;
}

const KNOWN_CLASSES: ReadonlySet<string> = new Set<ErrorClass>([
  'auth',
  'permission',
  'throttle',
  'daily',
  'send_limit',
  'anti_abuse',
  'config',
  'transient',
  'permanent',
  'cancelled',
]);
/** Classes that change governor state (`GOVERNOR_CLASS_POLICY` rows whose `pauses` is not `nothing`). */
const REFUSING: ReadonlySet<ErrorClass> = new Set<ErrorClass>([
  'throttle',
  'daily',
  'anti_abuse',
  'send_limit',
  'auth',
  'config',
]);

interface Block {
  account: Scope;
  budget: BudgetId;
  cls: ErrorClass;
  reason: string;
  /** Absent for auth and config blocks, which end only through `clear`. */
  until?: number;
}

/** What an admitted request holds. `retry` marks the one call `retryNow` let through a cooldown. */
interface Ticket {
  signal: AbortSignal;
  charge?: Charge;
  retry?: boolean;
}

interface Waiter {
  req: GovernedRequest;
  mode: RunMode;
  cost: number;
  slots: number;
  queuedAt: number;
  resolve: (ticket: Ticket) => void;
  reject: (error: unknown) => void;
  detach: () => void;
}

/** A signal that never aborts, for a send or write that has no caller signal. */
const NEVER = new AbortController().signal;

/** State of one budget of one account, or of `PROJECT` (project-wide daily stops and config blocks only). */
class Meter {
  window: SlidingWindow;
  /** AIMD target after a refusal, before regrowth and the role's cap; undefined when not in force. */
  aimdTarget?: number;
  /**
   * End of the last throttle cooldown. It stays after the cooldown passes, as the start of the quiet period, until
   * AIMD and the in-flight limit have regrown, so a restart restores both exactly (it is the persisted quiet mark).
   */
  cooldownUntil?: number;
  cooldownStep = 0;
  cooldownReason?: string;
  /** End of a daily or anti-abuse stop. */
  blockUntil?: number;
  blockCls?: ErrorClass;
  blockReason?: string;
  /** A send limit: refuses sends only. */
  sendBlockedUntil?: number;
  sendReason?: string;
  /** `PROJECT` meters only: a config block, until `clear`. */
  stop?: { reason: string; since: number };
  lastRefusalAt?: number;
  /** In-flight limit after a concurrency refusal, before regrowth (+1 per quiet 10 minutes); undefined when lifted. */
  capBase?: number;
  /** HTTP batch size before quiet growth, and when growth (+growBy per quiet 10 minutes) started counting. */
  batchBase: number;
  batchSince: number;
  inFlight = 0;
  /** The persisted upper bound on window spend and when it was set (see `reserve`). */
  reservedSpent = 0;
  reservedAt?: number;
  /** Aborted when a pause starts; every admitted read and idempotent write's signal follows it. */
  epoch = new AbortController();
  readonly queues = new Map<SyncLane, Waiter[]>(LANES.map(lane => [lane, []]));
  timer?: { at: number; controller: AbortController };
  pauseActive = false;
  pausedAt?: number;
  /** `retryNow` granted one call through this cooldown (`retryUsedFor` is the cooldown it was granted for). */
  retryPass = false;
  retryUsedFor?: number;
  /** The "Retry now" call, parked until the calls still in flight finish: it goes alone (prov-gov-attack-09). */
  retryWaiter?: Waiter;
  lastKey = '';

  constructor(
    readonly account: Scope,
    public spec: BudgetSpec,
    public role: DeviceRole,
    now: number,
  ) {
    this.window = new SlidingWindow(spec.windowMs);
    this.batchBase = spec.batch?.start ?? 1;
    this.batchSince = now;
  }

  queued(): Waiter[] {
    return [...this.queues.values()].flat();
  }
}

/** Whether a pause may abort the request in flight: never a send or write whose bytes may have left. */
function abortable(kind: RequestKind): boolean {
  return kind === 'read' || kind === 'idempotentWrite';
}

const keyOf = (account: Scope, budget: BudgetId) => `${account}\u0000${budget}`;

/**
 * The budget keeper (ARCH 6, plan 20 PV2), implementing F3 `GovernorPort`. Every provider request goes through `run`,
 * which waits on the injected clock until the request fits its lane's share of the target in the sliding window and
 * an in-flight slot is free, fetches the access token, charges it, and only then calls `fn`. It is the only code that
 * re-sends a request: a transient failure of a read or idempotent write, and any kind once after a first 401 and one
 * forced token refresh. Each class's action is `GOVERNOR_CLASS_POLICY`.
 */
export class Governor implements GovernorPort {
  private readonly clock: Pick<Clock, 'now' | 'sleep'>;
  private readonly defaults = new Map<BudgetId, BudgetSpec>();
  private readonly accountSpecs = new Map<AccountId, Map<BudgetId, BudgetSpec>>();
  private readonly tokens?: TokenSource;
  private readonly classifier?: (error: unknown) => ClassifiedError | undefined;
  private readonly logger?: GovernorLogger;
  private readonly log?: Logger;
  private readonly random: () => number;
  private readonly defaultRole: DeviceRole;
  private readonly roles = new Map<AccountId, DeviceRole>();
  private readonly meters = new Map<string, Meter>();
  /** Auth blocks are the account's, over every budget (F3 `GovernorSnapshot`). */
  private readonly authBlocks = new Map<AccountId, { reason: string; since: number }>();
  /** One token refresh at a time per account (D21), and a count of refreshes so concurrent 401s share one. */
  private readonly refreshing = new Map<AccountId, Promise<string>>();
  private readonly tokenGen = new Map<AccountId, number>();
  private readonly listeners = new Set<(account: Scope, snapshot: GovernorSnapshot) => void>();

  constructor(options: GovernorOptions) {
    this.clock = options.clock;
    for (const spec of options.budgets ?? defaultBudgets) this.defaults.set(spec.id, spec);
    this.tokens = options.tokens;
    this.classifier = options.classify;
    this.logger = options.logger;
    this.log = options.log;
    this.random = options.random ?? Math.random;
    this.defaultRole = options.role ?? 'secondary';
  }

  // ---------------------------------------------------------------- GovernorPort

  run<T>(account: AccountId, req: GovernedRequest, fn: (io: RequestIo) => Promise<T>): Promise<T> {
    return this.runWith(account, req, fn, {});
  }

  observe(
    account: AccountId,
    budget: BudgetId,
    error: ClassifiedError,
    scope: 'account' | 'project' = 'account',
  ): void {
    const m = this.meter(account, budget);
    this.refresh(m);
    const cls = this.normalize(error.class);
    if (cls !== 'cancelled') {
      this.trace('governor.refused', {
        account,
        budget,
        method: error.method,
        cls,
        reason: error.reason,
        status: error.status,
      });
    }
    if (REFUSING.has(cls)) this.applyRefusal(m, { ...error, class: cls }, scope, false);
  }

  charge(account: AccountId, budget: BudgetId, amount: number): void {
    if (!(amount > 0)) return;
    const m = this.meter(account, budget);
    m.window.charge(this.clock.now(), amount);
    this.reserve(m);
    this.pump(m);
  }

  admission(account: AccountId, budget: BudgetId, _lane: SyncLane, kind?: RequestKind): Admission {
    const m = this.meter(account, budget);
    this.refresh(m);
    return refusalOf(this.blockFor(m, kind, this.clock.now(), false));
  }

  batchSize(account: AccountId, budget: BudgetId): number {
    const m = this.meter(account, budget);
    this.refresh(m);
    return this.batchNow(m, this.clock.now());
  }

  retryNow(account: AccountId, budget: BudgetId): Admission {
    const m = this.meter(account, budget);
    this.refresh(m);
    const now = this.clock.now();
    const block = this.blockFor(m, undefined, now, false);
    if (!block) return { ok: true };
    // Only a throttle cooldown on this budget, with nothing else in force underneath, and once per cooldown.
    const project = this.peek(PROJECT, m.spec.id);
    const onlyCooldown =
      block.cls === 'throttle' &&
      block.account === m.account &&
      !(m.blockUntil !== undefined && m.blockUntil > now) &&
      !(project && this.budgetPause(project, now));
    if (!onlyCooldown || m.retryUsedFor === m.cooldownUntil) return refusalOf(block);
    m.retryPass = true;
    m.retryUsedFor = m.cooldownUntil;
    return { ok: true };
  }

  setRole(account: AccountId, role: DeviceRole): void {
    this.roles.set(account, role);
    for (const m of this.accountMeters(account)) {
      m.role = role;
      this.refresh(m);
      this.pump(m);
    }
  }

  clear(account: AccountId | ProjectScope, cls: 'auth' | 'config'): void {
    const now = this.clock.now();
    if (cls === 'auth') {
      if (account === PROJECT || !this.authBlocks.delete(account)) return;
      for (const m of this.budgetMeters(account)) {
        this.trace('governor.resumed', { account, budget: m.spec.id, cls: 'auth' });
        this.catalogResumed(m, 'reconnect', now);
        m.pauseActive = this.budgetPause(m, now) !== undefined;
        this.refresh(m);
        this.emitIfChanged(m);
        this.pump(m);
      }
      return;
    }
    // A config block is always the project's; clearing it from an account clears it for every account.
    for (const project of this.scopeMeters(PROJECT)) {
      if (!project.stop) continue;
      project.stop = undefined;
      this.trace('governor.resumed', { account: PROJECT, budget: project.spec.id, cls: 'config' });
      this.catalogResumed(project, 'manual', now);
      project.pauseActive = this.budgetPause(project, now) !== undefined;
      this.emitIfChanged(project);
      for (const m of this.budgetPeers(project.spec.id)) {
        m.pauseActive = this.budgetPause(m, now) !== undefined;
        this.refresh(m);
        this.pump(m);
      }
    }
  }

  snapshot(account: AccountId | ProjectScope): GovernorSnapshot[] {
    const now = this.clock.now();
    return this.budgetMeters(account).map(m => {
      this.refresh(m);
      return this.describe(m, now);
    });
  }

  /**
   * Seeds state after a restart from the snapshots the actor persisted in `governor_state`. The window's charges are
   * not persisted; the reserved `windowSpent` is charged again instead, which can only make the governor wait longer.
   */
  restore(account: AccountId | ProjectScope, snapshots: GovernorSnapshot[]): void {
    const now = this.clock.now();
    for (const snap of snapshots) {
      if (!this.specFor(account, snap.budget)) continue;
      const m = this.meter(account, snap.budget);
      const roleMax = Math.max(m.spec.target.primary, m.spec.target.secondary);
      m.cooldownUntil = snap.cooldownUntil;
      m.cooldownStep = snap.cooldownStep ?? 0;
      m.cooldownReason = snap.cls === 'throttle' ? snap.reason : undefined;
      // AIMD and the in-flight cap only exist inside a quiet period, which the kept cooldown end marks.
      m.aimdTarget =
        snap.cooldownUntil !== undefined && snap.target < roleMax
          ? snap.target - this.regrowSteps(m, now) * this.regrowStep(m.spec)
          : undefined;
      m.capBase =
        snap.cooldownUntil !== undefined && snap.inFlightLimit < m.spec.inFlight
          ? snap.inFlightLimit - this.quietSteps(m, now)
          : undefined;
      if (m.spec.batch && Number.isFinite(snap.batchSize)) {
        m.batchBase = Math.min(m.spec.batch.max, Math.max(m.spec.batch.min, snap.batchSize));
        m.batchSince = now;
      }
      const blockCls =
        snap.cls === 'daily' || snap.cls === 'anti_abuse' ? snap.cls : undefined;
      m.blockUntil = snap.dailyBlockUntil;
      m.blockCls = blockCls ?? 'daily';
      m.blockReason = blockCls ? snap.reason : undefined;
      m.sendBlockedUntil = snap.sendBlockedUntil;
      m.sendReason = snap.cls === 'send_limit' ? snap.reason : undefined;
      m.lastRefusalAt = snap.lastRefusalAt;
      if (snap.blocked?.cls === 'auth' && account !== PROJECT && !this.authBlocks.has(account)) {
        this.authBlocks.set(account, {
          reason: snap.cls === 'auth' ? (snap.reason ?? '') : '',
          since: snap.blocked.since,
        });
      }
      if (snap.blocked?.cls === 'config') {
        const project = this.meter(PROJECT, snap.budget);
        project.stop ??= {
          reason: snap.cls === 'config' ? (snap.reason ?? '') : '',
          since: snap.blocked.since,
        };
      }
      m.window = new SlidingWindow(m.spec.windowMs);
      if (snap.windowSpent > 0) {
        // Every unit the old process spent left by windowAt + RESERVE_REFRESH_MS (and by now), so a charge at the
        // earlier of the two outlives all of them.
        m.window.charge(Math.min(now, snap.windowAt + RESERVE_REFRESH_MS), snap.windowSpent);
      }
      m.reservedSpent = snap.windowSpent;
      m.reservedAt = snap.windowAt || undefined;
      m.pauseActive = false;
      m.lastKey = this.changeKey(this.describe(m, now));
      this.refresh(m);
    }
    // Start every pause the snapshots carry (auth included) on every meter they cover.
    const touched =
      account === PROJECT
        ? [...this.meters.values()].filter(m => snapshots.some(s => s.budget === m.spec.id))
        : this.budgetMeters(account);
    for (const m of touched) {
      const block = this.blockFor(m, undefined, now, false);
      if (block && !m.pauseActive) this.startPause(m, block);
      this.pump(m);
    }
  }

  onChange(listener: (account: Scope, snapshot: GovernorSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---------------------------------------------------------------- beyond the port

  /** `GovernorPort` bound to one account: `AdapterContext.governor`. */
  bind(account: AccountId): BoundGovernor {
    return this.binding(account, {});
  }

  /** The `ConnectContext.governor`: ignores the account's auth block, honours cooldowns, daily stops and config. */
  bindConnect(account: AccountId): BoundGovernor {
    return this.binding(account, { ignoreAuth: true });
  }

  /** The account's own specs from `ProviderFactory.budgets` (JMAP and IMAP derive theirs from `provider_memory`). */
  setBudgets(account: AccountId, specs: readonly BudgetSpec[]): void {
    const map = new Map(specs.map(spec => [spec.id, spec] as const));
    this.accountSpecs.set(account, map);
    for (const m of this.accountMeters(account)) {
      const spec = map.get(m.spec.id);
      if (!spec) continue;
      m.spec = spec;
      if (spec.batch) m.batchBase = Math.min(spec.batch.max, Math.max(spec.batch.min, m.batchBase));
      this.pump(m);
    }
  }

  /** Live numbers for tests and diagnostics. */
  inspect(account: AccountId, budget: BudgetId): MeterView {
    const m = this.meter(account, budget);
    const now = this.clock.now();
    return {
      used: m.window.used(now),
      inFlight: m.inFlight,
      inFlightLimit: this.limit(m, now),
      target: this.effectiveTarget(m, now),
      queued: m.queued().length,
    };
  }

  // ---------------------------------------------------------------- one request

  private binding(account: AccountId, mode: RunMode): BoundGovernor {
    return {
      run: (req, fn) => this.runWith(account, req, fn, mode),
      observe: (budget, error, scope) => this.observe(account, budget, error, scope),
      charge: (budget, amount) => this.charge(account, budget, amount),
      batchSize: budget => this.batchSize(account, budget),
    };
  }

  /** `run` with a `RunMode` (connect-time calls). */
  async runWith<T>(
    account: AccountId,
    req: GovernedRequest,
    fn: (io: RequestIo) => Promise<T>,
    mode: RunMode,
  ): Promise<T> {
    const m = this.meter(account, req.budget);
    const cost = Math.max(0, req.cost);
    const slots = Math.max(1, req.slots ?? 1);
    const wantsToken = req.auth !== false && this.tokens !== undefined;
    let transientTries = 0;
    let refreshed = false;
    let forceToken = false;
    let tokenGenUsed = -1;
    for (;;) {
      let ticket: Ticket;
      try {
        ticket = await this.admit(m, req, cost, slots, mode);
      } catch (error) {
        throw this.beforeSend(m, req, mode, error);
      }
      let accessToken: string | undefined;
      let failure: { retryIn: number } | { error: unknown } | { refresh: true };
      try {
        // A pause may have started between admission and this turn: nothing has left yet.
        let refused = this.beforeCall(m, req, ticket, mode);
        if (refused === undefined && wantsToken) {
          try {
            accessToken = await this.accessToken(account, forceToken, tokenGenUsed, mode);
            tokenGenUsed = this.tokenGen.get(account) ?? 0;
          } catch (error) {
            refused = error;
          }
          forceToken = false;
          refused ??= this.beforeCall(m, req, ticket, mode);
        }
        if (refused !== undefined) throw new BeforeCall(refused);
        // If time moved between admission and now, the provider counts the request from now.
        if (ticket.charge) {
          m.window.restamp(ticket.charge, this.clock.now());
          this.reserve(m);
        }
        for (const [budget, extra] of Object.entries(req.costs ?? {}) as [BudgetId, number][]) {
          if (budget !== req.budget) this.charge(account, budget, extra);
        }
        transientTries++;
        const value = await fn({ signal: ticket.signal, accessToken });
        this.succeeded(m, ticket);
        return value;
      } catch (error) {
        if (error instanceof BeforeCall) throw this.beforeSend(m, req, mode, error.error);
        failure = this.settleFailure(m, req, cost, error, ticket, {
          transientTries,
          canRefresh: wantsToken && !refreshed,
          mode,
        });
      } finally {
        m.inFlight -= slots;
        this.pump(m);
      }
      if ('error' in failure) throw failure.error;
      if ('refresh' in failure) {
        // A first 401: one forced refresh and one re-send, re-admitted like any request (F3 `GovernorPort.run`). The
        // re-send is not a transient try.
        refreshed = true;
        forceToken = true;
        transientTries--;
        continue;
      }
      await this.clock.sleep(failure.retryIn, this.waitSignal(m, req));
    }
  }

  /**
   * The access token for a request: the cached one unless it is near expiry or `forced` (a 401 answered the last
   * one). Refreshes run one at a time per account as governed `oauth` requests, so an auth-blocked account makes no
   * token call, and concurrent 401s on the same token share one refresh (prov-gov-T09).
   */
  private async accessToken(
    account: AccountId,
    forced: boolean,
    usedGen: number,
    mode: RunMode,
  ): Promise<string> {
    const tokens = this.tokens!;
    const cached = tokens.cached(account);
    const fresh = cached !== undefined && cached.expiresAt - TOKEN_EARLY_MS > this.clock.now();
    // A newer token than the one the 401 answered already exists: use it rather than refresh again.
    const newer = forced && (this.tokenGen.get(account) ?? 0) > usedGen;
    if (fresh && (!forced || newer)) return cached.token;
    let pending = this.refreshing.get(account);
    if (!pending) {
      pending = this.runWith(
        account,
        {
          budget: 'oauth',
          lane: 'interactive',
          kind: 'idempotentWrite',
          method: 'oauth.token',
          cost: 1,
          auth: false,
        },
        io => tokens.refresh(account, io),
        mode,
      ).then(
        result => {
          this.tokenGen.set(account, (this.tokenGen.get(account) ?? 0) + 1);
          return result.token;
        },
      );
      const settled = pending.finally(() => this.refreshing.delete(account));
      settled.catch(() => {});
      this.refreshing.set(account, pending);
    }
    return pending;
  }

  /**
   * For `kind: 'send'`, anything thrown before `fn` ran is proof the mail never left: a `PausedError` when a block or
   * pause caused it, else a `NotSentError`, never a plain error `SendPort` would treat as uncertain.
   */
  private beforeSend(m: Meter, req: GovernedRequest, mode: RunMode, error: unknown): unknown {
    if (req.kind !== 'send' || error instanceof PausedError || error instanceof NotSentError) {
      return error;
    }
    const block = this.blockFor(m, 'send', this.clock.now(), mode.ignoreAuth === true);
    if (block) return this.paused(block);
    const classified = this.classified(error) ?? {
      class: 'transient',
      provider: m.spec.id,
      method: req.method,
      reason: 'unclassified',
    };
    return new NotSentError(classified);
  }

  // ---------------------------------------------------------------- admission

  private admit(
    m: Meter,
    req: GovernedRequest,
    cost: number,
    slots: number,
    mode: RunMode,
  ): Promise<Ticket> {
    this.refresh(m);
    const now = this.clock.now();
    const block = this.blockFor(m, req.kind, now, mode.ignoreAuth === true);
    if (block) {
      if (m.retryPass && block.cls === 'throttle' && block.account === m.account) {
        // "Retry now": one call passes the cooldown, alone, without waiting for budget (F3 `retryNow`). A call still in
        // flight (a send, which a pause never aborts) keeps its slot: the retry waits for it rather than run beside it.
        m.retryPass = false;
        if (m.inFlight === 0) return Promise.resolve(this.grantRetry(m, req, cost, slots));
        if (req.signal?.aborted) return Promise.reject(req.signal.reason);
        return new Promise<Ticket>((resolve, reject) => {
          const waiter: Waiter = { req, mode, cost, slots, queuedAt: now, resolve, reject, detach: () => {} };
          if (req.signal) {
            const signal = req.signal;
            const onAbort = () => {
              if (m.retryWaiter === waiter) m.retryWaiter = undefined;
              reject(signal.reason);
            };
            signal.addEventListener('abort', onAbort, { once: true });
            waiter.detach = () => signal.removeEventListener('abort', onAbort);
          }
          m.retryWaiter = waiter;
        });
      }
      return Promise.reject(this.paused(block));
    }
    for (const budget of Object.keys(req.costs ?? {}) as BudgetId[]) {
      if (budget === req.budget) continue;
      const other = this.blockFor(this.meter(m.account, budget), req.kind, now, mode.ignoreAuth === true);
      if (other) return Promise.reject(this.paused(other));
    }
    if (req.signal?.aborted) return Promise.reject(req.signal.reason);
    return new Promise<Ticket>((resolve, reject) => {
      const queue = m.queues.get(req.lane);
      if (!queue) {
        reject(new Error(`unknown lane ${req.lane}`));
        return;
      }
      const waiter: Waiter = {
        req,
        mode,
        cost,
        slots,
        queuedAt: now,
        resolve,
        reject,
        detach: () => {},
      };
      if (req.signal) {
        const signal = req.signal;
        const onAbort = () => {
          const at = queue.indexOf(waiter);
          if (at >= 0) queue.splice(at, 1);
          reject(signal.reason);
          this.pump(m);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.detach = () => signal.removeEventListener('abort', onAbort);
      }
      queue.push(waiter);
      this.pump(m);
    });
  }

  /** The last check before `fn` runs: a pause, a send limit or a cancel that came after admission. */
  private beforeCall(m: Meter, req: GovernedRequest, ticket: Ticket, mode: RunMode): unknown {
    this.refresh(m);
    const block = this.blockFor(m, req.kind, this.clock.now(), mode.ignoreAuth === true);
    const passes = ticket.retry && block?.cls === 'throttle' && block.account === m.account;
    if (block && !passes) return this.paused(block);
    if (ticket.signal.aborted) return ticket.signal.reason;
    if (req.signal?.aborted) return req.signal.reason;
    return undefined;
  }

  /**
   * Admits queued requests in lane order, FIFO within a lane. Each lane has two limits: its own spend may not pass its
   * share of the target (prefetch: at most 20%), and the window's total may not pass the largest share of this lane
   * and every lane below it, so a lane never gets less headroom than a lane it outranks (ARCH 4.1, 6.2). A request
   * blocked by the total or by every slot holds every lane below it. A request blocked only by its own lane's share or
   * its lane's slots holds its lane but lets lower lanes with room go. A request larger than its lane's share waits
   * for an empty window and holds the lanes below it so the window drains; one heavier than the live in-flight limit
   * runs alone (F3 `GovernedRequest.slots`).
   */
  private pump(m: Meter): void {
    this.refresh(m);
    const now = this.clock.now();
    if (m.retryWaiter && m.inFlight === 0) {
      const w = m.retryWaiter;
      m.retryWaiter = undefined;
      w.detach();
      w.resolve(this.grantRetry(m, w.req, w.cost, w.slots));
    }
    if (this.budgetPause(m, now)) {
      this.disarm(m);
      return;
    }
    const authBlocked = m.account !== PROJECT && this.authBlocks.has(m.account);
    const target = this.effectiveTarget(m, now);
    const limit = this.limit(m, now);
    // The reserve shrinks with the limit, so a limit of 1 reserves nothing and no lane starves (review objection 6).
    const reserved = Math.max(0, Math.min(m.spec.reservedInteractive, limit - 1));
    let wakeAt = Infinity;
    scan: for (const [index, lane] of LANES.entries()) {
      const queue = m.queues.get(lane)!;
      const share = m.spec.laneShare[lane] ?? 0;
      const ownLimit = Math.floor(target * share);
      const lower = LANES.slice(index + 1).map(l => m.spec.laneShare[l] ?? 0);
      const totalLimit = Math.floor(target * Math.max(share, ...lower));
      const laneCap = PRIORITY_LANES.has(lane) ? limit : limit - reserved;
      while (queue.length) {
        const w = queue[0];
        if (authBlocked && !w.mode.ignoreAuth) {
          // Queued before the block began; startPause normally rejects these.
          queue.shift();
          w.detach();
          w.reject(this.paused(this.blockFor(m, w.req.kind, now, false)!));
          continue;
        }
        const bigCost = w.cost > ownLimit;
        const bigSlots = w.slots > laneCap;
        const fits = (total: number, own: number) =>
          w.cost === 0 ||
          (bigCost ? total === 0 : total + w.cost <= totalLimit && own + w.cost <= ownLimit);
        const used = m.window.used(now);
        const budgetOk = fits(used, m.window.used(now, lane));
        const slotsOk = bigSlots ? m.inFlight === 0 : m.inFlight + w.slots <= laneCap;
        if (budgetOk && slotsOk) {
          queue.shift();
          this.grant(m, w, now, bigCost);
          continue;
        }
        if (!budgetOk) wakeAt = Math.min(wakeAt, m.window.fitsAt(now, fits, lane));
        const holdsLower =
          bigCost || bigSlots || used + w.cost > totalLimit || m.inFlight + w.slots > limit;
        if (holdsLower) break scan;
        break;
      }
    }
    if (wakeAt !== Infinity) wakeAt = Math.min(wakeAt, this.nextTargetChange(m, now));
    else if (m.inFlight >= limit && m.queued().length) wakeAt = this.nextTargetChange(m, now);
    this.arm(m, wakeAt);
  }

  private grantRetry(m: Meter, req: GovernedRequest, cost: number, slots: number): Ticket {
    const charge = m.window.charge(this.clock.now(), cost, req.lane);
    m.inFlight += slots;
    this.reserve(m);
    return { signal: this.ioSignal(m, req), charge, retry: true };
  }

  private grant(m: Meter, w: Waiter, now: number, oversize: boolean): void {
    w.detach();
    const charge = m.window.charge(now, w.cost, w.req.lane);
    m.inFlight += w.slots;
    this.trace('governor.admitted', {
      account: m.account,
      budget: m.spec.id,
      lane: w.req.lane,
      method: w.req.method,
      units: w.cost,
      waitMs: now - w.queuedAt,
      reason: oversize ? 'oversize' : undefined,
    });
    this.reserve(m);
    w.resolve({ signal: this.ioSignal(m, w.req), charge });
  }

  /** The signal `fn` gets: a pause aborts reads and idempotent writes, never a send or write (principle 4). */
  private ioSignal(m: Meter, req: GovernedRequest): AbortSignal {
    return abortable(req.kind) ? this.waitSignal(m, req) : (req.signal ?? NEVER);
  }

  /** What a wait between tries follows: a pause or the caller's cancel. */
  private waitSignal(m: Meter, req: GovernedRequest): AbortSignal {
    return req.signal ? AbortSignal.any([m.epoch.signal, req.signal]) : m.epoch.signal;
  }

  /**
   * Keeps `reservedSpent` (persisted as `windowSpent`) at or above the window's spend, refreshed at least every
   * RESERVE_REFRESH_MS while units are spent. Then every unit spent before a crash left by `reservedAt +
   * RESERVE_REFRESH_MS`, and the units still counting at any later moment are at most `reservedSpent`, so `restore` can
   * charge them again without re-spending the minute.
   */
  private reserve(m: Meter): void {
    const now = this.clock.now();
    const used = m.window.used(now);
    if (used === 0) return;
    if (used <= m.reservedSpent && m.reservedAt !== undefined && now - m.reservedAt < RESERVE_REFRESH_MS) {
      return;
    }
    const step = Math.max(1, Math.ceil(m.spec.target.primary * RESERVE_STEP_SHARE));
    m.reservedSpent = Math.ceil(used / step) * step;
    m.reservedAt = now;
    this.emitIfChanged(m);
  }

  private arm(m: Meter, at: number): void {
    const now = this.clock.now();
    if (at === Infinity || at <= now) {
      this.disarm(m);
      return;
    }
    if (m.timer?.at === at) return;
    this.disarm(m);
    const controller = new AbortController();
    m.timer = { at, controller };
    this.clock.sleep(at - now, controller.signal).then(
      () => {
        if (m.timer?.controller !== controller) return;
        m.timer = undefined;
        this.pump(m);
      },
      () => {},
    );
  }

  private disarm(m: Meter): void {
    m.timer?.controller.abort();
    m.timer = undefined;
  }

  // ---------------------------------------------------------------- outcomes

  /** A call the provider accepted. "Retry now"'s call ends its cooldown (a design choice); the step stays. */
  private succeeded(m: Meter, ticket: Ticket): void {
    const now = this.clock.now();
    if (!ticket.retry || m.cooldownUntil === undefined || m.cooldownUntil <= now) return;
    m.cooldownUntil = now;
    m.retryPass = false;
    this.refresh(m);
  }

  private settleFailure(
    m: Meter,
    req: GovernedRequest,
    cost: number,
    error: unknown,
    ticket: Ticket,
    ctx: { transientTries: number; canRefresh: boolean; mode: RunMode },
  ): { retryIn: number } | { error: unknown } | { refresh: true } {
    const found = this.classified(error);
    const classified = found && { ...found, class: this.normalize(found.class) };
    const scope = error instanceof ProviderError ? error.scope : 'account';
    const cls: ErrorClass = classified?.class ?? 'transient';
    const log = () =>
      this.trace('governor.refused', {
        account: m.account,
        budget: m.spec.id,
        lane: req.lane,
        method: req.method,
        units: cost,
        cls,
        reason: classified?.reason ?? 'unclassified',
        status: classified?.status,
      });
    if (classified && cls === 'auth' && ctx.canRefresh) {
      log();
      return { refresh: true };
    }
    // The provider answered with a refusal: apply it even if a cancel or a sibling's pause raced it.
    if (classified && REFUSING.has(cls)) {
      log();
      // A connect-time auth refusal (a failed code exchange) fails the connect; it does not block the account.
      if (!(cls === 'auth' && ctx.mode.ignoreAuth)) {
        this.applyRefusal(m, classified, scope, ticket.retry === true);
      }
      return { error };
    }
    // A read cut short by our own abort (a sibling's pause) or the caller's: nothing to learn.
    if (ticket.signal.aborted && abortable(req.kind)) return { error: ticket.signal.reason ?? error };
    if (cls === 'cancelled') return { error };
    log();
    if (cls !== 'transient') return { error };
    if (abortable(req.kind)) {
      if (ctx.transientTries >= TRANSIENT_TRIES) return { error };
      const base =
        TRANSIENT_DELAYS_MS[Math.min(ctx.transientTries - 1, TRANSIENT_DELAYS_MS.length - 1)];
      return { retryIn: Math.round(base * (1 + 0.25 * this.random())) };
    }
    // A write or send that failed in transit (a cancel included) may have been applied: never re-sent, uncertain.
    if (classified?.uncertain === false) return { error };
    if (error instanceof ProviderError && error.error.uncertain) return { error };
    const record: ClassifiedError = classified
      ? { ...classified, uncertain: true }
      : {
          class: 'transient',
          provider: m.spec.id,
          method: req.method,
          reason: 'unclassified',
          uncertain: true,
        };
    const wrapped = new ProviderError(record, scope);
    (wrapped as { cause?: unknown }).cause = error;
    return { error: wrapped };
  }

  /**
   * One refusal's state change (`GOVERNOR_CLASS_POLICY`). `fresh` marks the call `retryNow` let through a cooldown:
   * its refusal escalates as a new one would, though it was sent during the pause.
   */
  private applyRefusal(
    m: Meter,
    error: ClassifiedError,
    scope: 'account' | 'project',
    fresh: boolean,
  ): void {
    const now = this.clock.now();
    this.refresh(m);
    const after = (ms: number) => Math.min(MAX_TIME, now + ms);
    m.retryPass = false;
    const at = (time: number | undefined) =>
      time !== undefined && time > now ? Math.min(MAX_TIME, time) : undefined;
    switch (error.class) {
      case 'throttle': {
        const before = this.blockFor(m, undefined, now, false);
        const limitNow = this.limit(m, now);
        let until: number;
        if (m.cooldownUntil !== undefined && m.cooldownUntil > now && !fresh) {
          // Sent before the pause began: it may lengthen the pause but does not escalate or halve again. The target
          // may not rise above what was in force when it was refused.
          until = Math.max(m.cooldownUntil, after(error.retryAfterMs ?? 0));
          m.aimdTarget = this.effectiveTarget(m, now);
        } else {
          const step = COOLDOWN_STEPS_MS[Math.min(m.cooldownStep, COOLDOWN_STEPS_MS.length - 1)];
          until = after(Math.max(error.retryAfterMs ?? 0, step));
          m.cooldownStep++;
          m.aimdTarget = Math.max(m.spec.floor, Math.floor(this.effectiveTarget(m, now) / 2));
          if (m.spec.batch) m.batchBase = Math.max(m.spec.batch.min, Math.floor(this.batchNow(m, now) / 2));
        }
        // The in-flight limit regrows from the end of this cooldown; freeze what it has regrown to so far.
        if (error.concurrency) m.capBase = 1;
        else if (m.capBase !== undefined) m.capBase = limitNow;
        m.cooldownUntil = until;
        m.cooldownReason = error.reason;
        // Batch growth counts quiet time again from the end of this cooldown.
        m.batchSince = until;
        m.lastRefusalAt = now;
        this.afterChange(m, before, error.status);
        return;
      }
      case 'daily':
      case 'anti_abuse': {
        // Gmail's per-project `dailyLimitExceeded` blocks the budget on PROJECT, so every account stops.
        const target = error.class === 'daily' && scope === 'project' ? this.meter(PROJECT, m.spec.id, m.spec) : m;
        const fallback = error.class === 'daily' ? nextPacificMidnight(now) : after(ANTI_ABUSE_MS);
        const until = at(error.resumeAt) ?? fallback;
        const before = this.blockFor(target, undefined, now, false);
        if (until >= (target.blockUntil ?? 0)) {
          target.blockUntil = until;
          target.blockCls = error.class;
          target.blockReason = error.reason;
        }
        target.lastRefusalAt = now;
        if (target.account === PROJECT) this.projectChanged(target, error.status);
        else this.afterChange(target, before, error.status);
        if (error.class === 'daily') this.catalog('governor.daily_stopped', target, { reason: error.reason, until });
        return;
      }
      case 'send_limit': {
        const stated =
          at(error.resumeAt) ??
          (error.retryAfterMs !== undefined && error.retryAfterMs > 0 ? after(error.retryAfterMs) : undefined);
        const until = stated ?? after(SEND_LIMIT_MS);
        if (until >= (m.sendBlockedUntil ?? 0)) {
          m.sendBlockedUntil = until;
          m.sendReason = error.reason;
        }
        m.lastRefusalAt = now;
        this.emitIfChanged(m);
        return;
      }
      case 'auth': {
        if (m.account === PROJECT) return;
        m.lastRefusalAt = now;
        this.blockAccount(m.account, error.reason, now, error.status);
        return;
      }
      case 'config': {
        const project = this.meter(PROJECT, m.spec.id, m.spec);
        project.stop ??= { reason: error.reason, since: now };
        project.lastRefusalAt = now;
        this.projectChanged(project, error.status);
        return;
      }
      default:
        return;
    }
  }

  /** Starts the pause a refusal began on one meter, if it is new or longer, and persists the change. */
  private afterChange(m: Meter, before: Block | undefined, status?: number): void {
    const now = this.clock.now();
    const block = this.blockFor(m, undefined, now, false);
    if (block && (!before || block.until !== before.until || block.cls !== before.cls)) {
      this.startPause(m, block, status);
    }
    this.emitIfChanged(m);
  }

  /** A project block changed: every account's meter of that budget pauses with it. */
  private projectChanged(project: Meter, status?: number): void {
    const now = this.clock.now();
    const block = this.budgetPause(project, now);
    if (block) this.startPause(project, block, status);
    this.emitIfChanged(project);
    for (const m of this.budgetPeers(project.spec.id)) {
      const own = this.blockFor(m, undefined, now, false);
      if (own) this.startPause(m, own, status);
    }
  }

  /** An auth block: every budget of the account, token calls included, until `clear(account, 'auth')`. */
  private blockAccount(account: AccountId, reason: string, now: number, status?: number): void {
    if (this.authBlocks.has(account)) return;
    this.authBlocks.set(account, { reason, since: now });
    for (const m of this.budgetMeters(account)) {
      this.startPause(m, this.blockFor(m, undefined, now, false)!, status);
      this.emitIfChanged(m);
    }
  }

  /** Rejects queued requests and aborts in-flight reads and idempotent writes on this meter. */
  private startPause(m: Meter, block: Block, status?: number): void {
    const now = this.clock.now();
    const paused = this.paused(block);
    // Queued connect-time requests (which ignore auth blocks) stay queued through an auth block.
    const keepsConnect = block.cls === 'auth';
    m.pauseActive = true;
    m.pausedAt ??= now;
    m.epoch.abort(paused);
    m.epoch = new AbortController();
    for (const queue of m.queues.values()) {
      for (const waiter of [...queue]) {
        if (keepsConnect && waiter.mode.ignoreAuth) continue;
        queue.splice(queue.indexOf(waiter), 1);
        waiter.detach();
        waiter.reject(paused);
      }
    }
    // A new refusal ends the "Retry now" allowance, parked call included.
    const retry = m.retryWaiter;
    if (retry) {
      m.retryWaiter = undefined;
      retry.detach();
      retry.reject(paused);
    }
    if (!keepsConnect) this.disarm(m);
    this.trace('governor.paused', {
      account: m.account,
      budget: m.spec.id,
      cls: block.cls,
      reason: block.reason,
      status,
      waitMs: block.until === undefined ? undefined : block.until - now,
    });
    this.catalog('governor.paused', m, {
      class: block.cls,
      reason: block.reason,
      pauseMs: block.until === undefined ? 0 : Math.max(0, block.until - now),
      until: block.until,
      step: block.cls === 'throttle' ? m.cooldownStep : undefined,
      concurrency: block.cls === 'throttle' && m.capBase !== undefined ? true : undefined,
    });
  }

  // ---------------------------------------------------------------- state

  /** A time-limited pause on this meter alone: the later of its cooldown and its daily or anti-abuse stop. */
  private ownPause(m: Meter, now: number): Block | undefined {
    const cooling = m.cooldownUntil !== undefined && m.cooldownUntil > now ? m.cooldownUntil : 0;
    const blocked = m.blockUntil !== undefined && m.blockUntil > now ? m.blockUntil : 0;
    if (!cooling && !blocked) return undefined;
    const base = { account: m.account, budget: m.spec.id };
    return blocked >= cooling
      ? { ...base, until: blocked, cls: m.blockCls ?? 'daily', reason: m.blockReason ?? '' }
      : { ...base, until: cooling, cls: 'throttle', reason: m.cooldownReason ?? '' };
  }

  /** What stops every request on this budget: a project config block, then the later of its own and the project's pause. */
  private budgetPause(m: Meter, now: number): Block | undefined {
    const project = m.account === PROJECT ? m : this.peek(PROJECT, m.spec.id);
    if (project?.stop) {
      return { account: PROJECT, budget: m.spec.id, cls: 'config', reason: project.stop.reason };
    }
    const own = this.ownPause(m, now);
    const shared = project && project !== m ? this.ownPause(project, now) : undefined;
    if (!shared) return own;
    if (!own) return shared;
    return shared.until! > own.until! ? shared : own;
  }

  /** What refuses a request of `kind` now: the account's auth block, a pause, or for a send a send limit. */
  private blockFor(
    m: Meter,
    kind: RequestKind | undefined,
    now: number,
    ignoreAuth: boolean,
  ): Block | undefined {
    if (!ignoreAuth && m.account !== PROJECT) {
      const auth = this.authBlocks.get(m.account);
      if (auth) return { account: m.account, budget: m.spec.id, cls: 'auth', reason: auth.reason };
    }
    const pause = this.budgetPause(m, now);
    if (pause) return pause;
    if (kind === 'send' && m.sendBlockedUntil !== undefined && m.sendBlockedUntil > now) {
      return {
        account: m.account,
        budget: m.spec.id,
        until: m.sendBlockedUntil,
        cls: 'send_limit',
        reason: m.sendReason ?? '',
      };
    }
    return undefined;
  }

  /** Lazily applies everything time does: pause ends, the quiet reset, AIMD and in-flight regrowth. */
  private refresh(m: Meter): void {
    const now = this.clock.now();
    if (m.blockUntil !== undefined && m.blockUntil <= now) m.blockUntil = undefined;
    if (m.sendBlockedUntil !== undefined && m.sendBlockedUntil <= now) m.sendBlockedUntil = undefined;
    if (!(m.cooldownUntil !== undefined && m.cooldownUntil > now)) m.retryPass = false;
    // AIMD ends only once it has regrown past every role's target, so a role flip cannot skip it.
    const aimd = this.aimdValue(m, now);
    const roleMax = Math.max(m.spec.target.primary, m.spec.target.secondary);
    if (aimd !== undefined && aimd >= roleMax) m.aimdTarget = undefined;
    if (m.capBase !== undefined && this.limit(m, now) >= m.spec.inFlight) m.capBase = undefined;
    if (m.cooldownUntil !== undefined && now >= m.cooldownUntil + QUIET_MS) {
      m.cooldownStep = 0;
      // The quiet mark is kept while anything still regrows from it.
      if (m.aimdTarget === undefined && m.capBase === undefined) {
        m.cooldownUntil = undefined;
        m.cooldownReason = undefined;
      }
    }
    if (m.pauseActive && !this.blockFor(m, undefined, now, false)) {
      m.pauseActive = false;
      this.trace('governor.resumed', { account: m.account, budget: m.spec.id });
      this.catalogResumed(m, 'timer', now);
    }
    this.emitIfChanged(m);
  }

  /** The HTTP batch size: halved on a throttle, then +growBy per quiet 10 minutes up to max (F3 `BudgetSpec.batch`). */
  private batchNow(m: Meter, now: number): number {
    const batch = m.spec.batch;
    if (!batch) return 1;
    const quiet = now < m.batchSince ? 0 : Math.floor((now - m.batchSince) / QUIET_MS);
    return Math.min(batch.max, m.batchBase + quiet * batch.growBy);
  }

  /** The AIMD target with its regrowth so far, before the role's cap. */
  private aimdValue(m: Meter, now: number): number | undefined {
    if (m.aimdTarget === undefined) return undefined;
    return m.aimdTarget + this.regrowSteps(m, now) * this.regrowStep(m.spec);
  }

  private regrowSteps(m: Meter, now: number): number {
    if (m.cooldownUntil === undefined || now < m.cooldownUntil + QUIET_MS) return 0;
    return Math.floor((now - m.cooldownUntil - QUIET_MS) / REGROW_INTERVAL_MS) + 1;
  }

  /** Whole quiet 10-minute periods since the cooldown ended: the in-flight limit regrows by one per period. */
  private quietSteps(m: Meter, now: number): number {
    if (m.cooldownUntil === undefined || now < m.cooldownUntil) return 0;
    return Math.floor((now - m.cooldownUntil) / QUIET_MS);
  }

  private limit(m: Meter, now: number): number {
    if (m.capBase === undefined) return m.spec.inFlight;
    return Math.min(m.spec.inFlight, Math.max(1, m.capBase + this.quietSteps(m, now)));
  }

  private effectiveTarget(m: Meter, now: number): number {
    return Math.min(m.spec.target[m.role], this.aimdValue(m, now) ?? Infinity);
  }

  /** ARCH 6.2: Gmail regrows 250 a minute, 1/18 of its 4,500 primary target; other budgets in proportion. */
  private regrowStep(spec: BudgetSpec): number {
    return Math.max(1, Math.round(spec.target.primary / 18));
  }

  /** When the target or the in-flight limit next changes on its own, while something waits. */
  private nextTargetChange(m: Meter, now: number): number {
    const q = m.cooldownUntil;
    if (q === undefined) return Infinity;
    let next = Infinity;
    if (m.aimdTarget !== undefined) {
      const start = q + QUIET_MS;
      next =
        now < start
          ? start
          : start + (Math.floor((now - start) / REGROW_INTERVAL_MS) + 1) * REGROW_INTERVAL_MS;
    }
    if (m.capBase !== undefined) {
      const cap = now < q ? q + QUIET_MS : q + (Math.floor((now - q) / QUIET_MS) + 1) * QUIET_MS;
      next = Math.min(next, cap);
    }
    return next;
  }

  private describe(m: Meter, now: number): GovernorSnapshot {
    const auth = m.account === PROJECT ? undefined : this.authBlocks.get(m.account);
    const own = this.ownPause(m, now);
    const sending =
      m.sendBlockedUntil !== undefined && m.sendBlockedUntil > now
        ? { cls: 'send_limit' as const, reason: m.sendReason ?? '' }
        : undefined;
    const shown = auth
      ? { cls: 'auth' as const, reason: auth.reason }
      : m.stop
        ? { cls: 'config' as const, reason: m.stop.reason }
        : (own ?? sending);
    const blocked = auth
      ? { cls: 'auth' as const, since: auth.since }
      : m.stop
        ? { cls: 'config' as const, since: m.stop.since }
        : undefined;
    return dropUndefined<GovernorSnapshot>({
      budget: m.spec.id,
      target: this.effectiveTarget(m, now),
      inFlightLimit: this.limit(m, now),
      batchSize: this.batchNow(m, now),
      windowSpent: m.reservedAt !== undefined ? m.reservedSpent : 0,
      windowAt: m.reservedAt ?? 0,
      cooldownUntil: m.cooldownUntil,
      cooldownStep: m.cooldownStep,
      dailyBlockUntil: m.blockUntil !== undefined && m.blockUntil > now ? m.blockUntil : undefined,
      sendBlockedUntil: sending ? m.sendBlockedUntil : undefined,
      blocked,
      cls: shown?.cls,
      reason: shown?.reason,
      lastRefusalAt: m.lastRefusalAt,
    });
  }

  private changeKey(snap: GovernorSnapshot): string {
    return JSON.stringify(snap);
  }

  private emitIfChanged(m: Meter): void {
    const snap = this.describe(m, this.clock.now());
    const key = this.changeKey(snap);
    if (key === m.lastKey) return;
    m.lastKey = key;
    for (const listener of this.listeners) {
      try {
        listener(m.account, snap);
      } catch {
        // A failing listener must not break pacing.
      }
    }
  }

  // ---------------------------------------------------------------- meters

  private specFor(account: Scope, budget: BudgetId): BudgetSpec | undefined {
    if (account !== PROJECT) {
      const own = this.accountSpecs.get(account)?.get(budget);
      if (own) return own;
    }
    const fallback = this.defaults.get(budget);
    if (fallback || account !== PROJECT) return fallback;
    for (const specs of this.accountSpecs.values()) {
      const spec = specs.get(budget);
      if (spec) return spec;
    }
    return undefined;
  }

  private meter(account: Scope, budget: BudgetId, like?: BudgetSpec): Meter {
    const key = keyOf(account, budget);
    let m = this.meters.get(key);
    if (!m) {
      const spec = this.specFor(account, budget) ?? like;
      if (!spec) throw new Error(`unknown budget ${budget}`);
      const role = account === PROJECT ? this.defaultRole : (this.roles.get(account) ?? this.defaultRole);
      m = new Meter(account, spec, role, this.clock.now());
      m.lastKey = this.changeKey(this.describe(m, this.clock.now()));
      this.meters.set(key, m);
    }
    return m;
  }

  private peek(account: Scope, budget: BudgetId): Meter | undefined {
    return this.meters.get(keyOf(account, budget));
  }

  private scopeMeters(account: Scope): Meter[] {
    return [...this.meters.values()].filter(m => m.account === account);
  }

  private accountMeters(account: AccountId): Meter[] {
    return this.scopeMeters(account);
  }

  /** Every account's meter of one budget (not the project's). */
  private budgetPeers(budget: BudgetId): Meter[] {
    return [...this.meters.values()].filter(m => m.account !== PROJECT && m.spec.id === budget);
  }

  /**
   * Every budget of an account: its own specs (or the defaults), the token endpoint, and any budget it has used. For
   * `PROJECT`, the budgets that have project state.
   */
  private budgetMeters(account: Scope): Meter[] {
    if (account === PROJECT) return this.scopeMeters(PROJECT);
    const ids = new Set<BudgetId>([
      ...(this.accountSpecs.get(account)?.keys() ?? this.defaults.keys()),
      ...this.scopeMeters(account).map(m => m.spec.id),
    ]);
    if (this.specFor(account, 'oauth')) ids.add('oauth');
    return [...ids].filter(id => this.specFor(account, id)).map(id => this.meter(account, id));
  }

  // ---------------------------------------------------------------- helpers

  private classified(error: unknown): ClassifiedError | undefined {
    return this.classifier?.(error) ?? (error instanceof ProviderError ? error.error : undefined);
  }

  /** The F1 enum is open: a class this engine does not know is treated as `transient`. */
  private normalize(cls: string): ErrorClass {
    return KNOWN_CLASSES.has(cls) ? (cls as ErrorClass) : 'transient';
  }

  private paused(block: Block): PausedError {
    return new PausedError(block.account, block.budget, block.cls, block.reason, block.until);
  }

  private trace(event: GovernorLogEvent, fields: GovernorLogFields): void {
    try {
      this.logger?.(event, dropUndefined(fields));
    } catch {
      // Logging never breaks pacing.
    }
  }

  private catalog(
    id: 'governor.paused' | 'governor.daily_stopped',
    m: Meter,
    fields: Record<string, unknown>,
  ): void {
    if (!this.log) return;
    const logger = m.account === PROJECT ? this.log : this.log.with({ account: m.account });
    const data = dropUndefined({
      budget: m.spec.id,
      ...fields,
      reason: (fields.reason as string) || 'unknown',
    });
    logger.event(id, data as never);
  }

  private catalogResumed(m: Meter, why: 'timer' | 'reconnect' | 'wake' | 'manual', now: number): void {
    const since = m.pausedAt;
    m.pausedAt = undefined;
    if (!this.log || since === undefined) return;
    const logger = m.account === PROJECT ? this.log : this.log.with({ account: m.account });
    logger.event('governor.resumed', { budget: m.spec.id, pausedMs: Math.max(0, now - since), why });
  }
}

/** Marks an error raised before `fn` ran, so `run` maps it for sends instead of classifying it as a failure. */
class BeforeCall {
  constructor(readonly error: unknown) {}
}

function refusalOf(block: Block | undefined): Admission {
  if (!block) return { ok: true };
  return block.until === undefined
    ? { ok: false, cls: block.cls, reason: block.reason }
    : { ok: false, cls: block.cls, reason: block.reason, until: block.until };
}

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
