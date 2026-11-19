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
  type GovernedRequest,
  type GovernorPort,
  type GovernorSnapshot,
  type ProjectScope,
  type RequestIo,
  type RequestKind,
  type SyncLane,
  type TokenSource,
} from '../ports';
import { LANES, PRIORITY_LANES } from './budgets';
import {
  ANTI_ABUSE_MS,
  BeforeCall,
  COOLDOWN_STEPS_MS,
  Meter,
  NEVER,
  REFUSING,
  RESERVE_REFRESH_MS,
  RESERVE_STEP_SHARE,
  SEND_LIMIT_MS,
  TOKEN_EARLY_MS,
  TRANSIENT_DELAYS_MS,
  TRANSIENT_TRIES,
  abortable,
  refusalOf,
  type Block,
  type DeviceRole,
  type RunMode,
  type Ticket,
  type Waiter,
} from './governor-meter';
import {
  after,
  batchNow,
  effectiveTarget,
  futureTime,
  inFlightLimit,
  nextTargetChange,
} from './governor-math';
import { changeKey, restoreMeterState, restoreWindow } from './governor-snapshot';
import { GovernorState, type GovernorOptions } from './governor-state';
import { nextPacificMidnight } from './pacific';

export {
  ANTI_ABUSE_MS,
  COOLDOWN_STEPS_MS,
  QUIET_MS,
  REGROW_INTERVAL_MS,
  RESERVE_REFRESH_MS,
  RESERVE_STEP_SHARE,
  SEND_LIMIT_MS,
  TOKEN_EARLY_MS,
  TRANSIENT_DELAYS_MS,
  TRANSIENT_TRIES,
} from './governor-meter';
export type { DeviceRole, MeterView, RunMode } from './governor-meter';
export { GovernorState } from './governor-state';
export type {
  GovernorLogEvent,
  GovernorLogFields,
  GovernorLogger,
  GovernorOptions,
} from './governor-state';

/**
 * The budget keeper (ARCH 6, plan 20 PV2), implementing F3 `GovernorPort`. Every provider request goes through `run`,
 * which waits on the injected clock until the request fits its lane's share of the target in the sliding window and
 * an in-flight slot is free, fetches the access token, charges it, and only then calls `fn`. It is the only code that
 * re-sends a request: a transient failure of a read or idempotent write, and any kind once after a first 401 and one
 * forced token refresh. Each class's action is `GOVERNOR_CLASS_POLICY`.
 */
export class Governor extends GovernorState implements GovernorPort {
  private readonly tokens?: TokenSource;
  private readonly random: () => number;
  /** One token refresh at a time per account (D21), and a count of refreshes so concurrent 401s share one. */
  private readonly refreshing = new Map<AccountId, Promise<string>>();
  private readonly tokenGen = new Map<AccountId, number>();

  constructor(options: GovernorOptions) {
    super(options);
    this.tokens = options.tokens;
    this.random = options.random ?? Math.random;
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
    return batchNow(m, this.clock.now());
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

  /**
   * Seeds state after a restart from the snapshots the actor persisted in `governor_state`. The window's charges are
   * not persisted; the reserved `windowSpent` is charged again instead, which can only make the governor wait longer.
   */
  restore(account: AccountId | ProjectScope, snapshots: GovernorSnapshot[]): void {
    const now = this.clock.now();
    for (const snap of snapshots) {
      if (!this.specFor(account, snap.budget)) continue;
      const m = this.meter(account, snap.budget);
      restoreMeterState(m, snap, now);
      this.restoreBlocks(account, snap);
      restoreWindow(m, snap, now);
      m.pauseActive = false;
      m.lastKey = changeKey(this.describe(m, now));
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
        // Extra budgets are accounted and checked for blocks, but not waited on for room: no caller sets `costs` yet.
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
      ).then(result => {
        this.tokenGen.set(account, (this.tokenGen.get(account) ?? 0) + 1);
        return result.token;
      });
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
      const other = this.blockFor(
        this.meter(m.account, budget),
        req.kind,
        now,
        mode.ignoreAuth === true,
      );
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
    const target = effectiveTarget(m, now);
    const limit = inFlightLimit(m, now);
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
    if (wakeAt !== Infinity) wakeAt = Math.min(wakeAt, nextTargetChange(m, now));
    else if (m.inFlight >= limit && m.queued().length) wakeAt = nextTargetChange(m, now);
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
    if (
      used <= m.reservedSpent &&
      m.reservedAt !== undefined &&
      now - m.reservedAt < RESERVE_REFRESH_MS
    ) {
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
    if (ticket.signal.aborted && abortable(req.kind))
      return { error: ticket.signal.reason ?? error };
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
    m.retryPass = false;
    switch (error.class) {
      case 'throttle':
        this.refuseThrottle(m, error, now, fresh);
        return;
      case 'daily':
      case 'anti_abuse':
        this.refuseStop(m, error, error.class, scope, now);
        return;
      case 'send_limit':
        this.refuseSendLimit(m, error, now);
        return;
      case 'auth':
        if (m.account === PROJECT) return;
        m.lastRefusalAt = now;
        this.blockAccount(m.account, error.reason, now, error.status);
        return;
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

  private refuseThrottle(m: Meter, error: ClassifiedError, now: number, fresh: boolean): void {
    const before = this.blockFor(m, undefined, now, false);
    const limitNow = inFlightLimit(m, now);
    let until: number;
    if (m.cooldownUntil !== undefined && m.cooldownUntil > now && !fresh) {
      // Sent before the pause began: it may lengthen the pause but does not escalate or halve again. The target
      // may not rise above what was in force when it was refused.
      until = Math.max(m.cooldownUntil, after(now, error.retryAfterMs ?? 0));
      m.aimdTarget = effectiveTarget(m, now);
    } else {
      const step = COOLDOWN_STEPS_MS[Math.min(m.cooldownStep, COOLDOWN_STEPS_MS.length - 1)];
      until = after(now, Math.max(error.retryAfterMs ?? 0, step));
      m.cooldownStep++;
      m.aimdTarget = Math.max(m.spec.floor, Math.floor(effectiveTarget(m, now) / 2));
      if (m.spec.batch) m.batchBase = Math.max(m.spec.batch.min, Math.floor(batchNow(m, now) / 2));
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
  }

  /** A daily or anti-abuse stop. */
  private refuseStop(
    m: Meter,
    error: ClassifiedError,
    cls: 'daily' | 'anti_abuse',
    scope: 'account' | 'project',
    now: number,
  ): void {
    // Gmail's per-project `dailyLimitExceeded` blocks the budget on PROJECT, so every account stops.
    const target =
      cls === 'daily' && scope === 'project' ? this.meter(PROJECT, m.spec.id, m.spec) : m;
    const fallback = cls === 'daily' ? nextPacificMidnight(now) : after(now, ANTI_ABUSE_MS);
    const until = futureTime(now, error.resumeAt) ?? fallback;
    const before = this.blockFor(target, undefined, now, false);
    if (until >= (target.blockUntil ?? 0)) {
      target.blockUntil = until;
      target.blockCls = cls;
      target.blockReason = error.reason;
    }
    target.lastRefusalAt = now;
    if (target.account === PROJECT) this.projectChanged(target, error.status);
    else this.afterChange(target, before, error.status);
    if (cls === 'daily')
      this.catalog('governor.daily_stopped', target, { reason: error.reason, until });
  }

  private refuseSendLimit(m: Meter, error: ClassifiedError, now: number): void {
    const stated =
      futureTime(now, error.resumeAt) ??
      (error.retryAfterMs !== undefined && error.retryAfterMs > 0
        ? after(now, error.retryAfterMs)
        : undefined);
    const until = stated ?? after(now, SEND_LIMIT_MS);
    if (until >= (m.sendBlockedUntil ?? 0)) {
      m.sendBlockedUntil = until;
      m.sendReason = error.reason;
    }
    m.lastRefusalAt = now;
    this.emitIfChanged(m);
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
}
