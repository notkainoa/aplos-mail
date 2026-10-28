import { LANES, PRIORITY_LANES, defaultBudgets } from './budgets';
import { nextPacificMidnight } from './pacific';
import {
  PausedError,
  ProviderError,
  type AccountId,
  type Admission,
  type BoundGovernor,
  type BudgetId,
  type BudgetSpec,
  type ClassifiedError,
  type Clock,
  type DeviceRole,
  type ErrorClass,
  type GovernedRequest,
  type GovernorPort,
  type GovernorSnapshot,
  type Lane,
  type RequestKind,
} from './types';
import { SlidingWindow, type Charge } from './window';

/** Throttle cooldowns: 60 s, then 5 min, then 15 min, then 1 h at most (ARCH 6.3). */
export const COOLDOWN_STEPS_MS: readonly number[] = [60_000, 300_000, 900_000, 3_600_000];
/** Quiet time that resets the escalation, lifts a concurrency cap and starts AIMD regrowth. */
export const QUIET_MS = 600_000;
/** AIMD regrows once per minute after the quiet period. */
export const REGROW_INTERVAL_MS = 60_000;
/** Transient failures of reads and idempotent writes: three tries in total, waiting 1 s then 2 s (jittered). */
export const TRANSIENT_TRIES = 3;
export const TRANSIENT_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];
/** Google Calendar's anti-abuse `quotaExceeded` when the provider gives no time (plan 20). */
export const ANTI_ABUSE_MS = 3 * 3600_000;
/**
 * A send limit with no stated end blocks sends for an hour (proto-google 2.5: "can persist for
 * hours"). A design choice: the submission fails "until HH:MM" and the user may try again then.
 */
export const SEND_LIMIT_MS = 3600_000;
/**
 * The persisted window spend (`windowSpent`) is reserved in steps of this share of the primary
 * target and refreshed at least this often while units are spent, so `onChange` fires a few times a
 * minute under load, not on every request.
 */
export const RESERVE_STEP_SHARE = 0.1;
export const RESERVE_REFRESH_MS = 15_000;
/** The latest instant a Date can hold; longer waits are clamped to it. */
const MAX_TIME = 8.64e15;

export type GovernorLogEvent = 'governor.admitted' | 'governor.paused' | 'governor.resumed' | 'governor.refused';
/** The only fields the governor logs: no content, tokens or addresses. */
export interface GovernorLogFields {
  account: AccountId;
  budget: BudgetId;
  lane?: Lane;
  method?: string;
  units?: number;
  waitMs?: number;
  cls?: ErrorClass;
  reason?: string;
  status?: number;
}
export type GovernorLogger = (event: GovernorLogEvent, fields: GovernorLogFields) => void;

export interface GovernorOptions {
  clock: Clock;
  budgets?: readonly BudgetSpec[];
  /** The classifier registry. Falls back to a thrown `ProviderError`'s record; anything else is `transient`. */
  classify?: (error: unknown) => ClassifiedError | undefined;
  logger?: GovernorLogger;
  /** Role before the lease says otherwise. Defaults to the conservative 'secondary'. */
  role?: DeviceRole;
  /** Source of retry jitter, for reproducible tests. */
  random?: () => number;
}

/**
 * Classes that change the budget's state (port proposal 4, action per class). `permission` is not
 * here: it changes nothing on the budget; the actor records the missing capability.
 */
const REFUSING: ReadonlySet<ErrorClass> = new Set(['throttle', 'daily', 'anti_abuse', 'send_limit', 'auth', 'config']);
const PROVIDER_OF: Record<BudgetId, ClassifiedError['provider']> = {
  gmail: 'google', gcal: 'gcal', graph: 'microsoft', imap: 'imap', jmap: 'jmap', caldav: 'caldav',
};

interface Pause { until: number; cls: ErrorClass; reason: string }

/** What an admitted request holds: the signal `fn` receives and the units it was charged. */
interface Ticket { signal: AbortSignal; charge?: Charge }

interface Waiter {
  req: GovernedRequest;
  cost: number;
  slots: number;
  queuedAt: number;
  resolve: (ticket: Ticket) => void;
  reject: (error: unknown) => void;
  detach: () => void;
}

/** A signal that never aborts, for a send or write that has no caller signal. */
const NEVER = new AbortController().signal;

/** State of one account's budget. */
class Meter {
  window: SlidingWindow;
  /** AIMD target after a refusal, before regrowth and the role's cap; undefined when not in force. */
  aimdTarget?: number;
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
  /** auth or config: stopped until `resume`. */
  stop?: { cls: 'auth' | 'config'; reason: string; since: number };
  lastRefusalAt?: number;
  quietSince?: number;
  concurrencyCapped = false;
  inFlight = 0;
  /** The persisted upper bound on window spend and when it was set (see `reserve`). */
  reservedSpent = 0;
  reservedAt?: number;
  /** Aborted when a pause starts; every admitted read and idempotent write's signal follows it. */
  epoch = new AbortController();
  readonly queues = new Map<Lane, Waiter[]>(LANES.map(lane => [lane, []]));
  timer?: { at: number; controller: AbortController };
  pauseActive = false;
  lastKey = '';

  constructor(readonly account: AccountId, readonly spec: BudgetSpec, public role: DeviceRole) {
    this.window = new SlidingWindow(spec.windowMs);
  }

  queued(): Waiter[] {
    return [...this.queues.values()].flat();
  }
}

/** Whether a pause may abort the request in flight: never a send or write whose bytes may have left. */
function abortable(kind: RequestKind): boolean {
  return kind === 'read' || kind === 'idempotentWrite';
}

/**
 * The budget keeper (ARCH 6, plan 20 PV2). Every provider request goes through `run`, which waits
 * on the injected clock until the request fits its lane's share of the target in the sliding window
 * and an in-flight slot is free, charges it, and only then calls `fn`. It is the only code that
 * re-sends a request, and only a transient failure of a read or idempotent write.
 */
export class Governor implements GovernorPort {
  private readonly clock: Clock;
  private readonly specs = new Map<BudgetId, BudgetSpec>();
  private readonly classifier?: (error: unknown) => ClassifiedError | undefined;
  private readonly logger?: GovernorLogger;
  private readonly random: () => number;
  private readonly defaultRole: DeviceRole;
  private readonly roles = new Map<AccountId, DeviceRole>();
  private readonly meters = new Map<string, Meter>();
  private readonly listeners = new Set<(account: AccountId, snap: GovernorSnapshot) => void>();

  constructor(options: GovernorOptions) {
    this.clock = options.clock;
    for (const spec of options.budgets ?? defaultBudgets) this.specs.set(spec.id, spec);
    this.classifier = options.classify;
    this.logger = options.logger;
    this.random = options.random ?? Math.random;
    this.defaultRole = options.role ?? 'secondary';
  }

  async run<T>(account: AccountId, req: GovernedRequest, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const m = this.meter(account, req.budget);
    const cost = Math.max(0, req.cost);
    const slots = Math.max(1, req.slots ?? 1);
    for (let attempt = 1; ; attempt++) {
      const { signal, charge } = await this.admit(m, req, cost, slots);
      // A pause may have started between admission and this turn: nothing has left yet.
      const refused = this.beforeCall(m, req, signal);
      if (refused !== undefined) {
        m.inFlight -= slots;
        this.pump(m);
        throw refused;
      }
      let failure: { retryIn: number } | { error: unknown };
      try {
        // If time moved between admission and now, the provider counts the request from now.
        if (charge) {
          m.window.restamp(charge, this.clock.now());
          this.reserve(m);
        }
        return await fn(signal);
      } catch (error) {
        failure = this.settleFailure(m, req, cost, error, signal, attempt);
      } finally {
        m.inFlight -= slots;
        this.pump(m);
      }
      if ('error' in failure) throw failure.error;
      await this.clock.sleep(failure.retryIn, this.waitSignal(m, req));
    }
  }

  observe(account: AccountId, budget: BudgetId, error: ClassifiedError): void {
    const m = this.meter(account, budget);
    this.refresh(m);
    if (error.class !== 'cancelled') {
      this.log('governor.refused', { account, budget, method: error.method, cls: error.class, reason: error.reason, status: error.status });
    }
    if (REFUSING.has(error.class)) this.applyRefusal(m, error);
  }

  admission(account: AccountId, budget: BudgetId, _lane: Lane, kind?: RequestKind): Admission {
    const m = this.meter(account, budget);
    this.refresh(m);
    const block = this.blockFor(m, kind, this.clock.now());
    return block ? { ok: false, ...block } : { ok: true };
  }

  setRole(account: AccountId, role: DeviceRole): void {
    this.roles.set(account, role);
    for (const m of this.accountMeters(account)) {
      m.role = role;
      this.refresh(m);
      this.pump(m);
    }
  }

  snapshot(account: AccountId): GovernorSnapshot[] {
    return [...this.specs.keys()].map(budget => {
      const m = this.meter(account, budget);
      this.refresh(m);
      return this.describe(m, this.clock.now());
    });
  }

  onChange(listener: (account: AccountId, snap: GovernorSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Seeds state after a restart from snapshots the actor persisted in `governor_state`. The window's
   * charges are not persisted; the reserved `windowSpent` is charged again instead, which can only
   * make the governor wait longer, never send sooner.
   */
  restore(account: AccountId, snapshots: readonly GovernorSnapshot[]): void {
    const now = this.clock.now();
    for (const snap of snapshots) {
      if (!this.specs.has(snap.budget)) continue;
      const m = this.meter(account, snap.budget);
      m.quietSince = snap.quietSince;
      m.aimdTarget = snap.aimdTarget ?? this.legacyAimd(m, snap.target, now);
      m.cooldownUntil = snap.cooldownUntil;
      m.cooldownStep = snap.cooldownStep ?? 0;
      m.cooldownReason = snap.cls === 'throttle' ? snap.reason : undefined;
      const blockCls = snap.cls === 'daily' || snap.cls === 'anti_abuse' ? snap.cls : undefined;
      m.blockUntil = snap.dailyBlockUntil;
      m.blockCls = blockCls ?? 'daily';
      m.blockReason = blockCls ? snap.reason : undefined;
      m.sendBlockedUntil = snap.sendBlockedUntil;
      m.sendReason = snap.cls === 'send_limit' ? snap.reason : undefined;
      // Older snapshots carry an auth or config stop only as `cls`.
      const stopCls = snap.blocked?.cls ?? (snap.cls === 'auth' || snap.cls === 'config' ? snap.cls : undefined);
      m.stop = stopCls
        ? { cls: stopCls, reason: snap.cls === stopCls ? snap.reason ?? '' : '', since: snap.blocked?.since ?? snap.lastRefusalAt ?? now }
        : undefined;
      m.lastRefusalAt = snap.lastRefusalAt;
      m.concurrencyCapped = snap.inFlightCap === 1;
      m.window = new SlidingWindow(m.spec.windowMs);
      if (snap.windowSpent !== undefined && snap.windowAt !== undefined) {
        // Every unit the old process spent left by windowAt + RESERVE_REFRESH_MS (and by now), so a
        // charge at the earlier of the two outlives all of them.
        m.window.charge(Math.min(now, snap.windowAt + RESERVE_REFRESH_MS), snap.windowSpent);
        m.reservedSpent = snap.windowSpent;
        m.reservedAt = snap.windowAt;
      } else {
        m.window.charge(now, snap.usedInWindow);
        m.reservedSpent = 0;
        m.reservedAt = undefined;
        this.reserve(m);
      }
      m.pauseActive = false;
      m.lastKey = this.changeKey(this.describe(m, now));
      this.refresh(m);
      const pause = this.pauseOf(m, now);
      if (pause) this.startPause(m, pause);
      this.pump(m);
    }
  }

  /** Clears an auth or config stop, after a reconnect or a fixed configuration. */
  resume(account: AccountId, budget: BudgetId): void {
    const m = this.meter(account, budget);
    if (!m.stop) return;
    const { cls } = m.stop;
    m.stop = undefined;
    this.log('governor.resumed', { account, budget, cls });
    // A daily stop or cooldown underneath stays in force with its own class and reason.
    m.pauseActive = this.pauseOf(m, this.clock.now()) !== undefined;
    this.refresh(m);
    this.pump(m);
  }

  /** `governor.run` bound to one account, for `AdapterContext.governor`. */
  bind(account: AccountId): BoundGovernor {
    return {
      run: (req, fn) => this.run(account, req, fn),
      observe: (budget, error) => this.observe(account, budget, error),
    };
  }

  // ---- admission ----

  private admit(m: Meter, req: GovernedRequest, cost: number, slots: number): Promise<Ticket> {
    this.refresh(m);
    const block = this.blockFor(m, req.kind, this.clock.now());
    if (block) return Promise.reject(new PausedError(m.spec.id, block.until, block.cls, block.reason));
    if (req.signal?.aborted) return Promise.reject(req.signal.reason);
    return new Promise<Ticket>((resolve, reject) => {
      const queue = m.queues.get(req.lane);
      if (!queue) { reject(new Error(`unknown lane ${req.lane}`)); return; }
      const waiter: Waiter = { req, cost, slots, queuedAt: this.clock.now(), resolve, reject, detach: () => {} };
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
  private beforeCall(m: Meter, req: GovernedRequest, signal: AbortSignal): unknown {
    this.refresh(m);
    const block = this.blockFor(m, req.kind, this.clock.now());
    if (block) return new PausedError(m.spec.id, block.until, block.cls, block.reason);
    if (signal.aborted) return signal.reason;
    return undefined;
  }

  /**
   * Admits queued requests in lane order, FIFO within a lane. Each lane has two limits: its own
   * spend may not pass its share of the target (prefetch: at most 20%), and the window's total may
   * not pass the largest share of this lane and every lane below it, so a lane never gets less
   * headroom than a lane it outranks (ARCH 4.1, 6.2). A request blocked by the total or by every
   * slot holds every lane below it. A request blocked only by its own lane's share or its lane's
   * slots holds its lane but lets lower lanes with room go. A request larger than its lane's share
   * waits for an empty window and holds the lanes below it so the window drains.
   */
  private pump(m: Meter): void {
    this.refresh(m);
    const now = this.clock.now();
    if (this.pauseOf(m, now)) { this.disarm(m); return; }
    const target = this.effectiveTarget(m, now);
    const cap = m.concurrencyCapped ? 1 : m.spec.inFlight;
    const reserved = Math.max(0, Math.min(m.spec.reservedInteractive, cap - 1));
    let wakeAt = Infinity;
    scan: for (const [index, lane] of LANES.entries()) {
      const queue = m.queues.get(lane)!;
      const share = m.spec.laneShare[lane] ?? 1;
      const ownLimit = Math.floor(target * share);
      const totalLimit = Math.floor(target * Math.max(share, ...LANES.slice(index + 1).map(l => m.spec.laneShare[l] ?? 1)));
      const laneCap = PRIORITY_LANES.has(lane) ? cap : cap - reserved;
      while (queue.length) {
        const w = queue[0];
        const bigCost = w.cost > ownLimit;
        const bigSlots = w.slots > laneCap;
        const fits = (total: number, own: number) =>
          w.cost === 0 || (bigCost ? total === 0 : total + w.cost <= totalLimit && own + w.cost <= ownLimit);
        const used = m.window.used(now);
        const budgetOk = fits(used, m.window.used(now, lane));
        const slotsOk = bigSlots ? m.inFlight === 0 : m.inFlight + w.slots <= laneCap;
        if (budgetOk && slotsOk) {
          queue.shift();
          this.grant(m, w, now, bigCost);
          continue;
        }
        if (!budgetOk) wakeAt = Math.min(wakeAt, m.window.fitsAt(now, fits, lane));
        const holdsLower = bigCost || bigSlots || used + w.cost > totalLimit || m.inFlight + w.slots > cap;
        if (holdsLower) break scan;
        break;
      }
    }
    if (wakeAt !== Infinity) wakeAt = Math.min(wakeAt, this.nextTargetChange(m, now));
    this.arm(m, wakeAt);
  }

  private grant(m: Meter, w: Waiter, now: number, oversize: boolean): void {
    w.detach();
    const charge = m.window.charge(now, w.cost, w.req.lane);
    m.inFlight += w.slots;
    this.log('governor.admitted', {
      account: m.account, budget: m.spec.id, lane: w.req.lane, method: w.req.method, units: w.cost,
      waitMs: now - w.queuedAt, reason: oversize ? 'oversize' : undefined,
    });
    this.reserve(m);
    w.resolve({ signal: this.ioSignal(m, w.req), charge });
  }

  /** The signal `fn` gets: a pause aborts reads and idempotent writes, never a send or write (principle 4). */
  private ioSignal(m: Meter, req: GovernedRequest): AbortSignal {
    return abortable(req.kind) ? this.waitSignal(m, req) : req.signal ?? NEVER;
  }

  /** What a wait between tries follows: a pause or the caller's cancel. */
  private waitSignal(m: Meter, req: GovernedRequest): AbortSignal {
    return req.signal ? AbortSignal.any([m.epoch.signal, req.signal]) : m.epoch.signal;
  }

  /**
   * Keeps `reservedSpent` (persisted as `windowSpent`) at or above the window's spend, refreshed at
   * least every RESERVE_REFRESH_MS while units are spent. Then every unit spent before a crash
   * left by `reservedAt + RESERVE_REFRESH_MS`, and the units still counting at any later moment are
   * at most `reservedSpent`, so `restore` can charge them again without re-spending the minute.
   */
  private reserve(m: Meter): void {
    const now = this.clock.now();
    const used = m.window.used(now);
    if (used === 0) return;
    if (used <= m.reservedSpent && m.reservedAt !== undefined && now - m.reservedAt < RESERVE_REFRESH_MS) return;
    const step = Math.max(1, Math.ceil(m.spec.targets.primary * RESERVE_STEP_SHARE));
    m.reservedSpent = Math.ceil(used / step) * step;
    m.reservedAt = now;
    this.emitIfChanged(m);
  }

  private arm(m: Meter, at: number): void {
    const now = this.clock.now();
    if (at === Infinity || at <= now) { this.disarm(m); return; }
    if (m.timer?.at === at) return;
    this.disarm(m);
    const controller = new AbortController();
    m.timer = { at, controller };
    this.clock.sleep(at - now, controller.signal).then(() => {
      if (m.timer?.controller !== controller) return;
      m.timer = undefined;
      this.pump(m);
    }, () => {});
  }

  private disarm(m: Meter): void {
    m.timer?.controller.abort();
    m.timer = undefined;
  }

  // ---- failures ----

  private settleFailure(
    m: Meter, req: GovernedRequest, cost: number, error: unknown, signal: AbortSignal, attempt: number,
  ): { retryIn: number } | { error: unknown } {
    const classified = this.classifier?.(error) ?? (error instanceof ProviderError ? error.error : undefined);
    const cls: ErrorClass = classified?.class ?? 'transient';
    const log = () => this.log('governor.refused', {
      account: m.account, budget: m.spec.id, lane: req.lane, method: req.method, units: cost,
      cls, reason: classified?.reason ?? 'unclassified', status: classified?.status,
    });
    // The provider answered with a refusal: apply it even if a cancel or a sibling's pause raced it.
    if (classified && REFUSING.has(cls)) {
      log();
      this.applyRefusal(m, classified);
      return { error };
    }
    // A read cut short by our own abort (a sibling's pause) or the caller's: nothing to learn.
    if (signal.aborted && abortable(req.kind)) return { error: signal.reason ?? error };
    if (cls === 'cancelled') return { error };
    log();
    if (cls !== 'transient') return { error };
    if (abortable(req.kind)) {
      if (attempt >= TRANSIENT_TRIES) return { error };
      const base = TRANSIENT_DELAYS_MS[Math.min(attempt - 1, TRANSIENT_DELAYS_MS.length - 1)];
      return { retryIn: Math.round(base * (1 + 0.5 * this.random())) };
    }
    // A write or send that failed in transit (a cancel included) may have been applied: never
    // re-sent, marked uncertain.
    if (classified?.uncertain === false) return { error };
    if (error instanceof ProviderError && error.error.uncertain) return { error };
    const record: ClassifiedError = classified
      ? { ...classified, uncertain: true }
      : { class: 'transient', provider: PROVIDER_OF[m.spec.id], method: req.method, reason: 'unclassified', uncertain: true };
    return { error: new ProviderError(record, { cause: error }) };
  }

  private applyRefusal(m: Meter, error: ClassifiedError): void {
    const now = this.clock.now();
    this.refresh(m);
    const before = this.pauseOf(m, now);
    const after = (ms: number) => Math.min(MAX_TIME, now + ms);
    const at = (time: number | undefined) => (time !== undefined && time > now ? Math.min(MAX_TIME, time) : undefined);
    switch (error.class) {
      case 'throttle': {
        let until: number;
        if (m.cooldownUntil !== undefined && m.cooldownUntil > now) {
          // Sent before the pause began: it may lengthen the pause but does not escalate or halve
          // again. The target may not rise above what was in force when it was refused.
          until = Math.max(m.cooldownUntil, after(error.retryAfterMs ?? 0));
          // No regrowth happens during a cooldown, so this only applies the role's cap.
          m.aimdTarget = this.effectiveTarget(m, now);
        } else {
          const step = COOLDOWN_STEPS_MS[Math.min(m.cooldownStep, COOLDOWN_STEPS_MS.length - 1)];
          until = after(Math.max(error.retryAfterMs ?? 0, step));
          m.cooldownStep++;
          m.aimdTarget = Math.max(m.spec.floor, Math.floor(this.effectiveTarget(m, now) / 2));
        }
        m.cooldownUntil = until;
        m.cooldownReason = error.reason;
        m.quietSince = until;
        if (error.concurrency) m.concurrencyCapped = true;
        break;
      }
      case 'daily':
      case 'anti_abuse': {
        const fallback = error.class === 'daily' ? nextPacificMidnight(now) : after(ANTI_ABUSE_MS);
        const until = at(error.resumeAt) ?? fallback;
        if (until >= (m.blockUntil ?? 0)) {
          m.blockUntil = until;
          m.blockCls = error.class;
          m.blockReason = error.reason;
        }
        break;
      }
      case 'send_limit': {
        const stated = at(error.resumeAt) ?? (error.retryAfterMs !== undefined && error.retryAfterMs > 0 ? after(error.retryAfterMs) : undefined);
        const until = stated ?? after(SEND_LIMIT_MS);
        if (until >= (m.sendBlockedUntil ?? 0)) {
          m.sendBlockedUntil = until;
          m.sendReason = error.reason;
        }
        break;
      }
      case 'auth':
      case 'config':
        if (!m.stop) m.stop = { cls: error.class, reason: error.reason, since: now };
        break;
      default:
        return;
    }
    m.lastRefusalAt = now;
    const pause = this.pauseOf(m, now);
    if (pause && (!before || pause.until !== before.until || pause.cls !== before.cls)) this.startPause(m, pause, error.status);
    this.emitIfChanged(m);
  }

  /** Rejects every queued request and aborts every in-flight read of this account and budget. */
  private startPause(m: Meter, pause: Pause, status?: number): void {
    const now = this.clock.now();
    const paused = new PausedError(m.spec.id, pause.until, pause.cls, pause.reason);
    m.pauseActive = true;
    m.epoch.abort(paused);
    m.epoch = new AbortController();
    for (const waiter of m.queued()) {
      waiter.detach();
      waiter.reject(paused);
    }
    for (const queue of m.queues.values()) queue.length = 0;
    this.disarm(m);
    this.log('governor.paused', {
      account: m.account, budget: m.spec.id, cls: pause.cls, reason: pause.reason, status,
      waitMs: pause.until === Infinity ? undefined : pause.until - now,
    });
  }

  // ---- state ----

  /** The pause in force on the whole budget: a stop, else the later of the cooldown and the daily stop. */
  private pauseOf(m: Meter, now: number): Pause | undefined {
    if (m.stop) return { until: Infinity, cls: m.stop.cls, reason: m.stop.reason };
    const cooling = m.cooldownUntil !== undefined && m.cooldownUntil > now ? m.cooldownUntil : 0;
    const blocked = m.blockUntil !== undefined && m.blockUntil > now ? m.blockUntil : 0;
    if (!cooling && !blocked) return undefined;
    return blocked >= cooling
      ? { until: blocked, cls: m.blockCls ?? 'daily', reason: m.blockReason ?? '' }
      : { until: cooling, cls: 'throttle', reason: m.cooldownReason ?? '' };
  }

  /** What refuses a request of `kind` now: a pause, or for a send also a send limit. */
  private blockFor(m: Meter, kind: RequestKind | undefined, now: number): Pause | undefined {
    const pause = this.pauseOf(m, now);
    if (pause) return pause;
    if (kind === 'send' && m.sendBlockedUntil !== undefined && m.sendBlockedUntil > now) {
      return { until: m.sendBlockedUntil, cls: 'send_limit', reason: m.sendReason ?? '' };
    }
    return undefined;
  }

  /** Lazily applies everything time does: pause ends, the quiet reset and AIMD regrowth. */
  private refresh(m: Meter): void {
    const now = this.clock.now();
    if (m.cooldownUntil !== undefined && m.cooldownUntil <= now) m.cooldownUntil = undefined;
    if (m.blockUntil !== undefined && m.blockUntil <= now) m.blockUntil = undefined;
    if (m.sendBlockedUntil !== undefined && m.sendBlockedUntil <= now) m.sendBlockedUntil = undefined;
    if (m.quietSince !== undefined && now - m.quietSince >= QUIET_MS) {
      m.cooldownStep = 0;
      m.concurrencyCapped = false;
    }
    // AIMD ends only once it has regrown past every role's target, so a role flip cannot skip it.
    const aimd = this.aimdValue(m, now);
    if (aimd !== undefined && aimd >= Math.max(m.spec.targets.primary, m.spec.targets.secondary)) m.aimdTarget = undefined;
    if (m.pauseActive && !this.pauseOf(m, now)) {
      m.pauseActive = false;
      this.log('governor.resumed', { account: m.account, budget: m.spec.id });
    }
    this.emitIfChanged(m);
  }

  /** The AIMD target with its regrowth so far, before the role's cap. */
  private aimdValue(m: Meter, now: number): number | undefined {
    if (m.aimdTarget === undefined) return undefined;
    return m.aimdTarget + this.regrowSteps(m, now) * this.regrowStep(m.spec);
  }

  private regrowSteps(m: Meter, now: number): number {
    if (m.quietSince === undefined || now < m.quietSince + QUIET_MS) return 0;
    return Math.floor((now - m.quietSince - QUIET_MS) / REGROW_INTERVAL_MS) + 1;
  }

  private effectiveTarget(m: Meter, now: number): number {
    return Math.min(m.spec.targets[m.role], this.aimdValue(m, now) ?? Infinity);
  }

  private regrowStep(spec: BudgetSpec): number {
    return spec.regrowPerMinute ?? Math.max(1, Math.round(spec.targets.primary / 18));
  }

  /**
   * A snapshot without `aimdTarget` carries only the effective target. Back out the regrowth so far,
   * so the restored target is the same now and keeps growing from there.
   */
  private legacyAimd(m: Meter, target: number, now: number): number | undefined {
    if (target >= m.spec.targets[m.role]) return undefined;
    return target - this.regrowSteps(m, now) * this.regrowStep(m.spec);
  }

  /** When the target or the in-flight cap next changes on its own, while something waits. */
  private nextTargetChange(m: Meter, now: number): number {
    if (m.quietSince === undefined || (m.aimdTarget === undefined && !m.concurrencyCapped)) return Infinity;
    const start = m.quietSince + QUIET_MS;
    if (now < start) return start;
    return start + (Math.floor((now - start) / REGROW_INTERVAL_MS) + 1) * REGROW_INTERVAL_MS;
  }

  private describe(m: Meter, now: number): GovernorSnapshot {
    const shown = this.blockFor(m, 'send', now);
    const snap: GovernorSnapshot = {
      budget: m.spec.id,
      target: this.effectiveTarget(m, now),
      usedInWindow: m.window.used(now),
      windowSpent: m.reservedAt !== undefined ? m.reservedSpent : undefined,
      windowAt: m.reservedAt,
      inFlight: m.inFlight,
      cooldownUntil: m.cooldownUntil !== undefined && m.cooldownUntil > now ? m.cooldownUntil : undefined,
      cooldownStep: m.cooldownStep,
      dailyBlockUntil: m.blockUntil !== undefined && m.blockUntil > now ? m.blockUntil : undefined,
      sendBlockedUntil: m.sendBlockedUntil !== undefined && m.sendBlockedUntil > now ? m.sendBlockedUntil : undefined,
      blocked: m.stop ? { cls: m.stop.cls, since: m.stop.since } : undefined,
      reason: shown?.reason,
      cls: shown?.cls,
      lastRefusalAt: m.lastRefusalAt,
      quietSince: m.quietSince,
      inFlightCap: m.concurrencyCapped ? 1 : undefined,
      aimdTarget: m.aimdTarget,
    };
    return dropUndefined(snap);
  }

  /** Persistable state only: the live window and in-flight counts change on every request. */
  private changeKey(snap: GovernorSnapshot): string {
    const { usedInWindow: _used, inFlight: _inFlight, ...rest } = snap;
    return JSON.stringify(rest);
  }

  private emitIfChanged(m: Meter): void {
    const snap = this.describe(m, this.clock.now());
    const key = this.changeKey(snap);
    if (key === m.lastKey) return;
    m.lastKey = key;
    for (const listener of this.listeners) {
      try { listener(m.account, snap); } catch { /* a failing listener must not break pacing */ }
    }
  }

  private meter(account: AccountId, budget: BudgetId): Meter {
    const key = `${account}\u0000${budget}`;
    let m = this.meters.get(key);
    if (!m) {
      const spec = this.specs.get(budget);
      if (!spec) throw new Error(`unknown budget ${budget}`);
      m = new Meter(account, spec, this.roles.get(account) ?? this.defaultRole);
      m.lastKey = this.changeKey(this.describe(m, this.clock.now()));
      this.meters.set(key, m);
    }
    return m;
  }

  private accountMeters(account: AccountId): Meter[] {
    return [...this.meters.values()].filter(m => m.account === account);
  }

  private log(event: GovernorLogEvent, fields: GovernorLogFields): void {
    try { this.logger?.(event, dropUndefined(fields)); } catch { /* logging never breaks pacing */ }
  }
}

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
