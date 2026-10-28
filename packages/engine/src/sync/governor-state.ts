import type { ClassifiedError, ErrorClass } from '@aplos/contract';
import {
  PROJECT,
  PausedError,
  ProviderError,
  type AccountId,
  type BudgetId,
  type BudgetSpec,
  type Clock,
  type GovernorSnapshot,
  type Logger,
  type ProjectScope,
  type RequestKind,
  type SyncLane,
  type TokenSource,
} from '../ports';
import { defaultBudgets } from './budgets';
import {
  KNOWN_CLASSES,
  QUIET_MS,
  Meter,
  dropUndefined,
  keyOf,
  type Block,
  type DeviceRole,
  type MeterView,
  type Scope,
} from './governor-meter';
import { aimdValue, effectiveTarget, inFlightLimit, ownPause } from './governor-math';
import { changeKey, describeMeter } from './governor-snapshot';

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

/**
 * The state half of the governor: its meters, specs, roles and auth blocks, what blocks a request, the lazy time
 * effects of `refresh`, and snapshot change events and logs. `Governor` adds the request flow on top.
 */
export abstract class GovernorState {
  protected readonly clock: Pick<Clock, 'now' | 'sleep'>;
  protected readonly defaults = new Map<BudgetId, BudgetSpec>();
  protected readonly accountSpecs = new Map<AccountId, Map<BudgetId, BudgetSpec>>();
  protected readonly classifier?: (error: unknown) => ClassifiedError | undefined;
  protected readonly logger?: GovernorLogger;
  protected readonly log?: Logger;
  protected readonly defaultRole: DeviceRole;
  protected readonly roles = new Map<AccountId, DeviceRole>();
  protected readonly meters = new Map<string, Meter>();
  /** Auth blocks are the account's, over every budget (F3 `GovernorSnapshot`). */
  protected readonly authBlocks = new Map<AccountId, { reason: string; since: number }>();
  protected readonly listeners = new Set<(account: Scope, snapshot: GovernorSnapshot) => void>();

  constructor(options: GovernorOptions) {
    this.clock = options.clock;
    for (const spec of options.budgets ?? defaultBudgets) this.defaults.set(spec.id, spec);
    this.classifier = options.classify;
    this.logger = options.logger;
    this.log = options.log;
    this.defaultRole = options.role ?? 'secondary';
  }

  snapshot(account: AccountId | ProjectScope): GovernorSnapshot[] {
    const now = this.clock.now();
    return this.budgetMeters(account).map(m => {
      this.refresh(m);
      return this.describe(m, now);
    });
  }

  /** The account's auth block and the project's config block a snapshot carries. */
  protected restoreBlocks(account: AccountId | ProjectScope, snap: GovernorSnapshot): void {
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
  }

  onChange(listener: (account: Scope, snapshot: GovernorSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Live numbers for tests and diagnostics. */
  inspect(account: AccountId, budget: BudgetId): MeterView {
    const m = this.meter(account, budget);
    const now = this.clock.now();
    return {
      used: m.window.used(now),
      inFlight: m.inFlight,
      inFlightLimit: inFlightLimit(m, now),
      target: effectiveTarget(m, now),
      queued: m.queued().length,
    };
  }

  // ---------------------------------------------------------------- state

  /** What stops every request on this budget: a project config block, then the later of its own and the project's pause. */
  protected budgetPause(m: Meter, now: number): Block | undefined {
    const project = m.account === PROJECT ? m : this.peek(PROJECT, m.spec.id);
    if (project?.stop) {
      return { account: PROJECT, budget: m.spec.id, cls: 'config', reason: project.stop.reason };
    }
    const own = ownPause(m, now);
    const shared = project && project !== m ? ownPause(project, now) : undefined;
    if (!shared) return own;
    if (!own) return shared;
    return shared.until! > own.until! ? shared : own;
  }

  /** What refuses a request of `kind` now: the account's auth block, a pause, or for a send a send limit. */
  protected blockFor(
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
  protected refresh(m: Meter): void {
    const now = this.clock.now();
    if (m.blockUntil !== undefined && m.blockUntil <= now) m.blockUntil = undefined;
    if (m.sendBlockedUntil !== undefined && m.sendBlockedUntil <= now)
      m.sendBlockedUntil = undefined;
    if (!(m.cooldownUntil !== undefined && m.cooldownUntil > now)) m.retryPass = false;
    // AIMD ends only once it has regrown past every role's target, so a role flip cannot skip it.
    const aimd = aimdValue(m, now);
    const roleMax = Math.max(m.spec.target.primary, m.spec.target.secondary);
    if (aimd !== undefined && aimd >= roleMax) m.aimdTarget = undefined;
    if (m.capBase !== undefined && inFlightLimit(m, now) >= m.spec.inFlight) m.capBase = undefined;
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

  protected describe(m: Meter, now: number): GovernorSnapshot {
    const auth = m.account === PROJECT ? undefined : this.authBlocks.get(m.account);
    return describeMeter(m, now, auth);
  }

  protected emitIfChanged(m: Meter): void {
    const snap = this.describe(m, this.clock.now());
    const key = changeKey(snap);
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

  protected specFor(account: Scope, budget: BudgetId): BudgetSpec | undefined {
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

  protected meter(account: Scope, budget: BudgetId, like?: BudgetSpec): Meter {
    const key = keyOf(account, budget);
    let m = this.meters.get(key);
    if (!m) {
      const spec = this.specFor(account, budget) ?? like;
      if (!spec) throw new Error(`unknown budget ${budget}`);
      const role =
        account === PROJECT ? this.defaultRole : (this.roles.get(account) ?? this.defaultRole);
      m = new Meter(account, spec, role, this.clock.now());
      m.lastKey = changeKey(this.describe(m, this.clock.now()));
      this.meters.set(key, m);
    }
    return m;
  }

  protected peek(account: Scope, budget: BudgetId): Meter | undefined {
    return this.meters.get(keyOf(account, budget));
  }

  protected scopeMeters(account: Scope): Meter[] {
    return [...this.meters.values()].filter(m => m.account === account);
  }

  protected accountMeters(account: AccountId): Meter[] {
    return this.scopeMeters(account);
  }

  /** Every account's meter of one budget (not the project's). */
  protected budgetPeers(budget: BudgetId): Meter[] {
    return [...this.meters.values()].filter(m => m.account !== PROJECT && m.spec.id === budget);
  }

  /**
   * Every budget of an account: its own specs (or the defaults), the token endpoint, and any budget it has used. For
   * `PROJECT`, the budgets that have project state.
   */
  protected budgetMeters(account: Scope): Meter[] {
    if (account === PROJECT) return this.scopeMeters(PROJECT);
    const ids = new Set<BudgetId>([
      ...(this.accountSpecs.get(account)?.keys() ?? this.defaults.keys()),
      ...this.scopeMeters(account).map(m => m.spec.id),
    ]);
    if (this.specFor(account, 'oauth')) ids.add('oauth');
    return [...ids].filter(id => this.specFor(account, id)).map(id => this.meter(account, id));
  }

  // ---------------------------------------------------------------- helpers

  protected classified(error: unknown): ClassifiedError | undefined {
    return this.classifier?.(error) ?? (error instanceof ProviderError ? error.error : undefined);
  }

  /** The F1 enum is open: a class this engine does not know is treated as `transient`. */
  protected normalize(cls: string): ErrorClass {
    return KNOWN_CLASSES.has(cls) ? (cls as ErrorClass) : 'transient';
  }

  protected paused(block: Block): PausedError {
    return new PausedError(block.account, block.budget, block.cls, block.reason, block.until);
  }

  protected trace(event: GovernorLogEvent, fields: GovernorLogFields): void {
    try {
      this.logger?.(event, dropUndefined(fields));
    } catch {
      // Logging never breaks pacing.
    }
  }

  protected catalog(
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

  protected catalogResumed(
    m: Meter,
    why: 'timer' | 'reconnect' | 'wake' | 'manual',
    now: number,
  ): void {
    const since = m.pausedAt;
    m.pausedAt = undefined;
    if (!this.log || since === undefined) return;
    const logger = m.account === PROJECT ? this.log : this.log.with({ account: m.account });
    logger.event('governor.resumed', {
      budget: m.spec.id,
      pausedMs: Math.max(0, now - since),
      why,
    });
  }
}
