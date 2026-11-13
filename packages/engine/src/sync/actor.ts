import type { ClassifiedError, ReasonCode } from '@aplos/contract';
import {
  NotSentError,
  PausedError,
  PROJECT,
  ProviderError,
  type AccountRuntime,
  type AdapterAccount,
  type AdapterContext,
  type BoundGovernor,
  type BudgetSpec,
  type Clock,
  type CoalescedOp,
  type DeadlineRegistry,
  type GovernorPort,
  type KnownLookup,
  type Logger,
  type OpOutcome,
  type PendingOp,
  type PlanEnv,
  type PlannedStep,
  type PlanTrigger,
  type ProviderAdapter,
  type ScopeId,
  type StepResult,
  type StorePort,
  type StoreWrite,
  type SyncLane,
  type SyncState,
  type WorkflowCopy,
} from '../ports';
import { LANES } from './budgets';
import { stepWrites } from './facts';
import { GOOGLE_CALENDAR_WRITE_SCOPE, hasCalendarWrite } from '../calendar/write-scope';
import { peerClaimLive } from './lease';
import { flushable, parseOpPayload, pendingOp, readOps, settleWrites, type OpRow } from './ops';
import { readFailures, readMemory, readStates } from './persist';
import { sameStatus, statusOfFailure, statusOfRefusal, type StatusView } from './status';

/** Heartbeats every 30 s while idle or waiting on the governor (PV2; the supervisor restarts an actor silent for 2 min). */
export const HEARTBEAT_MS = 30_000;
/** Wake, network and focus hints are coalesced and spread over this window (prov-gov-T36). */
export const WAKE_JITTER_MS = 3_000;
/** A failed step's own backoff: 30 s doubling to 15 min, jittered, and never before the refusal's `retryAfterMs`. */
export const STEP_BACKOFF_MS = 30_000;
export const STEP_BACKOFF_MAX_MS = 900_000;
/** A loop turn that threw (a bug or a store failure) waits this long before the next. */
const LOOP_ERROR_MS = 30_000;

/**
 * The Google calendar scopes the OAuth manifest's round-1 request carries (apps/desktop oauth/scopes.ts):
 * `calendar.calendarlist.readonly` + `calendar.events.readonly` (`calendar.events` is round 2's write scope and is
 * never asked). Used only to name the gap in `missingPermissions` before a refusal has reported one — the engine
 * knows the URLs, not the manifest's feature names. Exported for the parity test that pins it to the manifest.
 */
export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
];

/** The calendar scopes' own failure channel (a `permission` refusal on one is a gap, not an account halt). */
const isCalendarScope = (scope: ScopeId): boolean =>
  scope === 'calendars' || scope.startsWith('cal:');

/** Lanes a secondary device never runs, except the workflow round itself (ARCH 6.5, ports.walk.md lease). */
const PRIMARY_ONLY: ReadonlySet<SyncLane> = new Set<SyncLane>([
  'backfill',
  'prefetch',
  'enrichment',
]);

export type Role = 'primary' | 'secondary';

export interface ActorDeps {
  store: StorePort;
  governor: GovernorPort;
  /** The account's network door; the actor wraps it to count governor waits for the heartbeat. */
  bound: BoundGovernor;
  clock: Pick<Clock, 'now' | 'sleep'>;
  log: Logger;
  deadlines: DeadlineRegistry;
  env: () => PlanEnv;
  adapter: ProviderAdapter;
  account: AdapterAccount;
  /** The account's mail budget (the factory's first): admission, pause status and op flush ask it. */
  budget: BudgetSpec;
  lookup: KnownLookup;
  newId: () => string;
  random: () => number;
  baselineDoneAt?: number;
  reconnectBy?: number;
  role: Role;
  onStatus: (runtime: AccountRuntime) => void;
  /** The copies each workflow round this actor ran delivered (only when `hostReadsWorkflow` is false). */
  onWorkflowCopies?: (copies: WorkflowCopy[]) => void;
  /**
   * The host's lease controller reads this account's workflow channel (`ActorHost`, ARCH 6.5): its round is the one
   * channel reader, so the actor never runs the planned `workflow` step itself.
   */
  hostReadsWorkflow?: boolean;
  /**
   * The lease role as of now (the host's `controller.current().role`), asked on every turn: a primary whose claim ran
   * out while the actor slept is secondary before the lease deadline's report reaches `setLease`. Undefined: the
   * last role `setLease` gave.
   */
  leaseRole?: () => Role | undefined;
}

const laneRank = (lane: SyncLane) => LANES.indexOf(lane);

function classifiedOf(error: unknown): ClassifiedError | undefined {
  if (error instanceof ProviderError || error instanceof NotSentError) return error.error;
  return undefined;
}

/**
 * One account's actor (ARCH 4.1, plan 20 PV2): plans from committed state, runs one bounded step at a time in lane
 * priority, and commits each step's facts with its resume tokens, the mutation fence and the sweep in one store
 * transaction. Op flush runs before sync. A pause or block makes no I/O until it ends; status follows the governor.
 * All waiting is `clock.sleep`, interrupted by `wake`, `request`, `opsChanged` and `reconnected`.
 */
export class AccountActor {
  readonly runtime: AccountRuntime;
  private readonly stopper = new AbortController();
  private sleeper?: AbortController;
  private loopDone?: Promise<void>;
  private trigger: PlanTrigger = 'first';
  /** Scopes still to run once under the current non-poll trigger, so a manual sync runs every due scope. */
  private pass?: Set<ScopeId>;
  private wakeAt?: number;
  /** `retryNow` granted one call: the next step runs through the cooldown. */
  forced = false;
  private opsDirty = true;
  /** A pause on a budget other than this account's mail budget holds op flushes until it ends. */
  private opsHoldUntil = 0;
  /** Ops whose write may have landed wait for the next incremental pass (F3 `OpOutcome`). */
  private heldUncertain = true;
  readonly backoff = new Map<ScopeId, { failures: number; until: number }>();
  /** A failure the governor does not hold (missing mail permission): no sync until reconnect or a manual request. */
  private halted?: StatusView;
  /** The missing scopes a `permission` refusal on a calendar call named; unset until one does. */
  calendarScopeGap?: string[];
  /** Set when an event write was refused for lack of the write scope; cleared by a reconnect or a grant that has it. */
  private calendarWriteGap?: string[];
  private failure?: StatusView;
  private view?: StatusView;
  private heartbeat: number;
  /** Requests inside the governor but not inside their `fn` (waiting for budget, or between retries). */
  private waiting = 0;
  private nextAt?: number;
  private role: Role;
  private backfillRead = 0;
  private readonly bound: BoundGovernor;
  readonly log: Logger;

  constructor(readonly deps: ActorDeps) {
    this.role = deps.role;
    this.heartbeat = deps.clock.now();
    this.log = deps.log.with({ account: deps.account.id });
    this.bound = this.countWaits(deps.bound);
    this.runtime = {
      status: { state: 'starting' },
      grantedScopes: deps.account.grantedScopes,
      capabilities: deps.account.capabilities,
      firstWindow: { read: 0, total: 0 },
      ...(deps.baselineDoneAt !== undefined ? { baselineDoneAt: deps.baselineDoneAt } : {}),
      ...(deps.reconnectBy !== undefined ? { reconnectBy: deps.reconnectBy } : {}),
      lease: { role: deps.role },
    };
    // The first emit has not been wired yet: set the row directly, no subscriber call.
    const missing = this.missingPermissionsNow();
    if (missing) this.runtime.missingPermissions = missing;
  }

  get id() {
    return this.deps.account.id;
  }

  get stopped() {
    return this.stopper.signal.aborted;
  }

  start(): void {
    this.trigger = readStates(this.deps.store, this.id).length ? 'resume' : 'first';
    this.loopDone = this.loop();
  }

  /**
   * Stops at once: the adapter's signal aborts, sleeps end, and anything that still resolves later (a zombie reply)
   * is discarded, never committed. Does not wait for a stalled adapter promise.
   */
  stop(): void {
    this.stopper.abort(new Error('actor stopped'));
    this.sleeper?.abort();
  }

  /** Resolves when the loop has exited (tests). */
  done(): Promise<void> {
    return this.loopDone ?? Promise.resolve();
  }

  lastHeartbeat(): number {
    return this.heartbeat;
  }

  /** When the actor next plans to run (`sync:<account>` deadline), or undefined while blocked. */
  next(): number | undefined {
    return this.nextAt;
  }

  // ---------------------------------------------------------------- inputs

  /** Wake, network, focus and push hints: one jittered pass, and none through a pause (prov-gov-T36). */
  wake(trigger: 'wake' | 'push' | 'poll'): void {
    if (trigger !== 'poll') {
      this.setTrigger(trigger);
      this.wakeAt ??= this.deps.clock.now() + Math.floor(this.deps.random() * WAKE_JITTER_MS);
    }
    this.interrupt();
  }

  /** `Sync/request` once admitted (the host asked the governor first). `forced`: `retryNow` granted one call. */
  request(forced: boolean): void {
    this.setTrigger('manual');
    this.wakeAt = undefined;
    this.halted = undefined;
    this.backoff.clear();
    this.opsHoldUntil = 0;
    if (forced) this.forced = true;
    this.interrupt();
  }

  opsChanged(): void {
    this.opsDirty = true;
    this.interrupt();
  }

  /** The governor's pause on this account ended (`governor` deadline): plan with `resume`. */
  resumed(): void {
    this.setTrigger('resume');
    this.interrupt();
  }

  /** After `clear(auth)`: resume from the stored cursors with no resync, and flush queued ops first. */
  reconnected(facts: {
    grantedScopes?: string[];
    capabilities?: AdapterAccount['capabilities'];
    reconnectBy?: number;
  }): void {
    this.halted = undefined;
    this.failure = undefined;
    this.backoff.clear();
    this.opsHoldUntil = 0;
    if (facts.grantedScopes) this.runtime.grantedScopes = facts.grantedScopes;
    if (facts.capabilities) this.runtime.capabilities = facts.capabilities;
    // The adapter holds the same `AdapterAccount` object: mutate it in place so `plan` and `context()`
    // see the new grant at once — a re-consent that added the calendar scopes must not wait for a restart.
    if (facts.grantedScopes) this.deps.account.grantedScopes = facts.grantedScopes;
    if (facts.capabilities) this.deps.account.capabilities = facts.capabilities;
    this.calendarScopeGap = undefined;
    this.calendarWriteGap = undefined;
    this.refreshMissingPermissions();
    if (facts.reconnectBy !== undefined) {
      this.runtime.reconnectBy = facts.reconnectBy;
      this.deps.reconnectBy = facts.reconnectBy;
    }
    this.setTrigger('resume');
    this.opsDirty = true;
    this.interrupt();
  }

  /** The lease's role (ARCH 6.5): a secondary runs under the secondary target and drops background lanes. */
  setLease(lease: NonNullable<AccountRuntime['lease']>): void {
    this.role = lease.role;
    this.runtime.lease = { ...lease };
    this.deps.governor.setRole(this.id, lease.role);
    this.emit();
    this.interrupt();
  }

  /** An `AdapterContext` for this account, for the host's interactive calls (open, search, attachments). */
  context(): AdapterContext {
    return {
      account: this.deps.account,
      governor: this.bound,
      clock: this.deps.clock as Clock,
      log: this.log,
      signal: this.stopper.signal,
      lookup: this.deps.lookup,
      memory: readMemory(this.deps.store, this.id),
      generation: this.deps.store.seq(),
    };
  }

  // ---------------------------------------------------------------- the loop

  private async loop(): Promise<void> {
    while (!this.stopped) {
      this.beat();
      try {
        await this.turn();
      } catch (error) {
        if (this.stopped) break;
        this.log.event('sync.status_changed', {
          from: this.runtime.status.state,
          to: 'error',
          reason: error instanceof Error ? error.name : 'unknown',
        });
        await this.idle(this.deps.clock.now() + LOOP_ERROR_MS);
      }
    }
  }

  private async turn(): Promise<void> {
    const { governor, clock, store, adapter } = this.deps;
    const now = clock.now();
    if (this.wakeAt !== undefined && this.wakeAt > now && !this.forced) {
      await this.idle(this.wakeAt);
      return;
    }
    this.wakeAt = undefined;
    // A pause or block: zero requests until it ends (or until reconnect or a config fix).
    const admission = governor.admission(this.id, this.deps.budget.id, 'incremental');
    if (!admission.ok && !this.forced) {
      this.setStatus(this.refusalStatus(admission));
      await this.idle(admission.until ?? Infinity);
      if (!this.stopped && governor.admission(this.id, this.deps.budget.id, 'incremental').ok) {
        this.setTrigger('resume');
      }
      return;
    }
    if (this.halted && !this.forced) {
      this.setStatus(this.halted);
      await this.idle(Infinity);
      return;
    }
    // opFlush outranks every sync lane (ARCH 4.1).
    const opsHeld = this.opsHoldUntil > now;
    if (this.opsDirty && !this.forced && !opsHeld && (await this.flushOps())) return;
    if (this.stopped) return;
    const states = readStates(store, this.id);
    const memory = readMemory(store, this.id);
    const env = { ...this.deps.env(), now };
    const planned = adapter.plan({
      account: this.deps.account,
      states,
      trigger: this.trigger,
      env,
      memory,
    });
    const role = this.currentRole();
    const steps = planned.filter(step => this.allowed(step, role));
    const due = steps
      .filter(step => this.dueAt(step, now) <= now)
      .sort((a, b) => laneRank(a.lane) - laneRank(b.lane));
    if (!due.length) {
      this.setTrigger('poll');
      this.forced = false;
      this.setStatus(this.idleStatus());
      await this.idle(this.nextWake(steps, now));
      return;
    }
    if (this.trigger !== 'poll' && !this.pass) this.pass = new Set(due.map(step => step.scope));
    // Inside a pass, a scope that already ran is not picked again: a non-poll trigger makes a cadence scope (Gmail
    // history) due at once on every plan, and it outranks the rest, so it would starve the lower lanes forever.
    const pick = this.pass ? due.filter(step => this.pass!.has(step.scope)) : due;
    if (!pick.length) {
      this.setTrigger('poll');
      return;
    }
    const step = pick[0];
    await this.runStep(
      step,
      states.find(s => s.scope === step.scope) ?? {
        scope: step.scope,
        generation: 0,
        updatedAt: 0,
      },
    );
    this.pass?.delete(step.scope);
    if (this.pass && !this.pass.size) this.setTrigger('poll');
  }

  /** When the loop next has work: the earliest due step, or the end of a hold on queued ops. */
  private nextWake(steps: PlannedStep[], now: number): number {
    const opsWake = this.opsDirty && this.opsHoldUntil > now ? this.opsHoldUntil : Infinity;
    return Math.min(opsWake, ...steps.map(step => this.dueAt(step, now)));
  }

  /** The role this turn plans with: the lease's live answer when the host has one. */
  private currentRole(): Role {
    return this.deps.leaseRole?.() ?? this.role;
  }

  private allowed(step: PlannedStep, role: Role): boolean {
    if (step.scope === 'workflow') return this.workflowAllowed(role);
    return role !== 'secondary' || !PRIMARY_ONLY.has(step.lane);
  }

  /**
   * The workflow round: never when the host's lease round reads the channel (one reader per account). Otherwise it is
   * not a background lane, but on a secondary that sees a live holder it is the primary's job (ARCH 6.5).
   */
  private workflowAllowed(role: Role): boolean {
    if (this.deps.hostReadsWorkflow) return false;
    return role !== 'secondary' || this.leaseFree();
  }

  /** No live lease holder that this device knows of: `holder` absent, or its claim gone by the lease's own rule. */
  private leaseFree(): boolean {
    const holder = this.runtime.lease?.holder;
    if (holder === undefined) return true;
    const until = this.runtime.lease?.until;
    return until !== undefined && !peerClaimLive(until, this.deps.clock.now());
  }

  private dueAt(step: PlannedStep, now: number): number {
    return Math.max(step.notBefore ?? now, this.backoff.get(step.scope)?.until ?? 0);
  }

  setTrigger(trigger: PlanTrigger): void {
    this.trigger = trigger;
    this.pass = undefined;
  }

  // ---------------------------------------------------------------- one step

  private async runStep(step: PlannedStep, state: SyncState): Promise<void> {
    if (step.scope === 'calendars' || step.scope.startsWith('cal:')) {
      return this.runCalendarStep(step, state);
    }
    const { store, clock, adapter } = this.deps;
    // The mutation fence and the round generation: the store's seq before the page request goes out (ARCH 4.3).
    const fence = store.seq();
    const ctx = { ...this.context(), generation: fence };
    this.forced = false;
    if (!this.runtime.baselineDoneAt) this.setStatus({ status: { state: 'syncing' } });
    else if (step.lane === 'backfill') this.setStatus(this.backfillStatus());
    const ticker = this.tick();
    let result: StepResult;
    try {
      result =
        step.scope === 'workflow' && adapter.workflow
          ? await this.workflowRound(state, ctx)
          : await adapter.syncStep(step, state, ctx);
    } catch (error) {
      ticker.abort();
      if (!this.stopped) this.stepFailed(step, error);
      return;
    }
    ticker.abort();
    // A reply after stop (a zombie) is discarded, never committed.
    if (this.stopped) return;
    const now = clock.now();
    const failures = readFailures(
      store,
      this.id,
      (result.quarantine ?? []).map(q => q.item),
    );
    const writes = stepWrites(result, {
      account: this.deps.account,
      step,
      state,
      now,
      failures,
      baselineDone: this.runtime.baselineDoneAt !== undefined,
    });
    this.countProgress(step, result);
    const baselineDoneAt =
      this.runtime.baselineDoneAt ?? (result.baselineReached ? now : undefined);
    this.failure = undefined;
    this.backoff.delete(step.scope);
    const after = this.afterStepStatus(step, baselineDoneAt);
    const statusWrites = this.statusWrites(after);
    store.commit({
      opId: this.deps.newId(),
      origin: 'sync',
      step: step.origin,
      fenceSeq: fence,
      changes: step.origin === 'backfill' ? 'coarse' : 'fine',
      // The account touch marks `Account` so `lastSyncAt` below reaches the UI even when the status itself did not
      // change (sync_state rows alone mark nothing the renderer reads). Once a display minute, the precision the
      // Settings row shows — a finer rate would wake the UI every poll for a timestamp it cannot render.
      writes: [
        ...writes,
        ...statusWrites,
        ...(this.runtime.lastSyncAt === undefined ||
        Math.floor(now / 60_000) > Math.floor(this.runtime.lastSyncAt / 60_000)
          ? [{ kind: 'account' as const, id: this.id }]
          : []),
      ],
    });
    const firstBaseline = this.runtime.baselineDoneAt === undefined && baselineDoneAt !== undefined;
    if (baselineDoneAt !== undefined) this.runtime.baselineDoneAt = baselineDoneAt;
    this.runtime.lastSyncAt = now;
    // Subscribers hear of the baseline even when the status stays the same (the host's lease round waits for it).
    if (!this.applyStatus(after) && firstBaseline) this.emit();
    if (result.reset) {
      this.log.event(`sync.${this.family()}.cursor_reset`, { reset: result.reset });
      this.setTrigger('reset');
    }
    if (step.origin === 'incremental' && this.heldUncertain) {
      // The incremental pass that shows whether an uncertain op landed: try it once more.
      this.heldUncertain = false;
      this.opsDirty = true;
    }
  }

  /** A step's progress: the first window's count (baseline) and the backfill's. */
  private countProgress(step: PlannedStep, result: StepResult): void {
    if (step.origin === 'baseline' && result.progress) {
      this.runtime.firstWindow = {
        read: this.runtime.firstWindow.read + result.progress.read,
        total: result.progress.total ?? this.runtime.firstWindow.total,
        ...(result.progress.found !== undefined ? { found: result.progress.found } : {}),
      };
    }
    if (step.lane === 'backfill') this.backfillRead += result.progress?.read ?? 0;
  }

  private async workflowRound(state: SyncState, ctx: AdapterContext): Promise<StepResult> {
    const round = await this.deps.adapter.workflow!.round(state, ctx);
    if (!this.stopped) this.deps.onWorkflowCopies?.(round.copies);
    return { nextStates: [round.nextState], done: true, costUnits: round.costUnits };
  }

  /** A `calendars` or `cal:<id>` step on the adapter's calendar half (D12; the body lives in actor-calendar.ts). */
  private calSteps: Promise<typeof import('./actor-calendar')> | undefined;
  private runCalendarStep(step: PlannedStep, state: SyncState): Promise<void> {
    // Dynamic edge keeps the calendar half out of the startup bundle (portability budget); it loads
    // only on accounts whose adapter actually has a `.calendar` slot.
    const mod = (this.calSteps ??= import('./actor-calendar'));
    return mod.then(m => m.runCalendarStep(this, step, state));
  }

  /** One `cal:<id>` entry in `runtime.calendars` (the D12 per-calendar state), emitted on change. */
  markCalendar(
    remoteId: string,
    entry: {
      state: 'ok' | 'paused' | 'error';
      until?: number;
      reason?: string;
      reasonCode?: ReasonCode;
    },
  ): void {
    const list = (this.runtime.calendars ??= []);
    const at = list.findIndex(c => c.remoteId === remoteId);
    const next = { remoteId, ...entry };
    const same =
      at >= 0 &&
      list[at]!.state === next.state &&
      list[at]!.until === next.until &&
      list[at]!.reasonCode === next.reasonCode;
    if (same) return;
    if (at >= 0) list[at] = next;
    else list.push(next);
    this.emit();
  }

  /**
   * Every listed calendar reads ok — but a delta list names only the changed ones, so anything not
   * listed keeps its entry. Paused or errored calendars keep their state until their own step runs.
   */
  calendarsOk(remoteIds: string[]): void {
    const listed = new Set(remoteIds);
    const byId = new Map((this.runtime.calendars ?? []).map(c => [c.remoteId, c]));
    this.runtime.calendars = [
      ...remoteIds.map(remoteId => {
        const old = byId.get(remoteId);
        return old && old.state !== 'ok' ? old : { remoteId, state: 'ok' as const };
      }),
      ...(this.runtime.calendars ?? []).filter(c => !listed.has(c.remoteId)),
    ];
    this.emit();
  }

  /** A step that threw: the governor already holds pauses and blocks; everything else backs this scope off. */
  private stepFailed(step: PlannedStep, error: unknown): void {
    const now = this.deps.clock.now();
    if (error instanceof PausedError) return this.holdScope(step, error.until);
    const classified = classifiedOf(error);
    const cls = classified?.class;
    if (
      cls === 'throttle' ||
      cls === 'daily' ||
      cls === 'auth' ||
      cls === 'config' ||
      cls === 'anti_abuse'
    ) {
      const retryAt = classified?.retryAfterMs ? now + classified.retryAfterMs : undefined;
      return this.holdScope(step, retryAt);
    }
    if (cls === 'cancelled') return;
    const view = statusOfFailure(classified, now);
    if (cls === 'permission') {
      if (isCalendarScope(step.scope)) return this.calendarScopeRefused(step, classified, now);
      this.halted = view;
      this.setStatus(view!);
      return;
    }
    const prior = this.backoff.get(step.scope)?.failures ?? 0;
    const failures = prior + 1;
    const base = Math.min(STEP_BACKOFF_MAX_MS, STEP_BACKOFF_MS * 2 ** (failures - 1));
    const delay = Math.max(
      Math.round(base * (1 + 0.25 * this.deps.random())),
      classified?.retryAfterMs ?? 0,
    );
    this.backoff.set(step.scope, { failures, until: now + delay });
    if (view && !(view.status.state === 'offline' && this.view?.status.state === 'offline')) {
      this.failure = view;
      this.setStatus(view);
    }
  }

  /**
   * A `permission` refusal on a calendar scope is a feature-level gap (D12), never an account halt: the scope backs
   * off on the usual escalation while `missingPermissions` names the scopes a re-consent must add. Mail is untouched.
   */
  calendarScopeRefused(
    step: PlannedStep,
    classified: ClassifiedError | undefined,
    now: number,
  ): void {
    if (classified?.missingScopes?.length) this.calendarScopeGap = classified.missingScopes;
    this.refreshMissingPermissions();
    const failures = (this.backoff.get(step.scope)?.failures ?? 0) + 1;
    const until = now + Math.min(STEP_BACKOFF_MAX_MS, STEP_BACKOFF_MS * 2 ** (failures - 1));
    this.backoff.set(step.scope, { failures, until });
  }

  /**
   * The governor holds a pause and the loop's admission check sleeps through it, but only for this account's mail budget.
   * A pause on another budget (calendar, OAuth) passes that check, so the step would run, be refused without I/O and
   * run again at once. Back the scope off until the pause ends.
   */
  holdScope(step: PlannedStep, until: number | undefined): void {
    const now = this.deps.clock.now();
    if (!this.deps.governor.admission(this.id, this.deps.budget.id, 'incremental').ok) return;
    const failures = this.backoff.get(step.scope)?.failures ?? 0;
    this.backoff.set(step.scope, { failures, until: until ?? now + STEP_BACKOFF_MS });
  }

  /** Same for op flushes: a refusal from a budget the mail admission check does not cover holds the flush. */
  private holdOps(until: number | undefined): void {
    const now = this.deps.clock.now();
    if (!this.deps.governor.admission(this.id, this.deps.budget.id, 'opFlush').ok) return;
    this.opsHoldUntil = until ?? now + STEP_BACKOFF_MS;
  }

  // ---------------------------------------------------------------- op flush (ARCH 4.3)

  /** Flushes what it can; true when it did work (the loop then looks again before syncing). */
  private async flushOps(): Promise<boolean> {
    const { store, clock, adapter, governor } = this.deps;
    this.opsDirty = false;
    const now = clock.now();
    const { ops } = flushable(readOps(store, this.id), now, this.heldUncertain);
    if (!ops.length) return false;
    if (!governor.admission(this.id, this.deps.budget.id, 'opFlush').ok) {
      this.opsDirty = true;
      return false;
    }
    const pending: PendingOp[] = [];
    const rows = new Map<string, OpRow>();
    for (const row of ops) {
      const payload = parseOpPayload(row.payload);
      if (!payload) {
        if (!pending.length) {
          this.commit([
            { kind: 'opSettle', opId: row.opId, state: 'failed', lastError: 'invalidPayload' },
          ]);
          return true;
        }
        break;
      }
      pending.push(pendingOp(row, payload));
      rows.set(row.opId, row);
    }
    this.commit(
      pending.map(op => ({ kind: 'opSettle', opId: op.opId, state: 'inflight' }) as StoreWrite),
    );
    const requeue = (opIds: string[]) =>
      this.commit(opIds.map(opId => ({ kind: 'opSettle', opId, state: 'queued' }) as StoreWrite));
    let calls: CoalescedOp[];
    try {
      calls = adapter.coalesce(pending);
    } catch {
      requeue(pending.map(op => op.opId));
      this.opsDirty = false;
      return false;
    }
    const ctx = this.context();
    for (const [index, call] of calls.entries()) {
      let outcomes: OpOutcome[];
      try {
        outcomes = await adapter.apply(call, ctx);
      } catch (error) {
        if (this.stopped) return false;
        if (error instanceof PausedError) {
          requeue(calls.slice(index).flatMap(c => c.opIds));
          this.opsDirty = true;
          this.holdOps(error.until);
          return true;
        }
        const failed = classifiedOf(error) ?? {
          class: 'transient',
          provider: this.deps.budget.id,
          method: call.method,
          reason: 'unclassified',
        };
        outcomes = call.opIds.map(opId => ({ opId, result: 'failed', error: failed }));
      }
      if (this.stopped) return false;
      const writes: StoreWrite[] = [];
      let holds = false;
      let paused = false;
      for (const opId of call.opIds) {
        const outcome = outcomes.find(o => o.opId === opId) ?? {
          opId,
          result: 'failed' as const,
          error: {
            class: 'transient',
            provider: this.deps.budget.id,
            method: call.method,
            reason: 'noOutcome',
          },
        };
        const settled = settleWrites(this.id, rows.get(opId)!, outcome, clock.now());
        writes.push(...settled.writes);
        holds ||= settled.holds;
        paused ||= settled.paused === true;
        if (outcome.result === 'failed' && outcome.error?.uncertain) this.heldUncertain = true;
      }
      this.commit(writes, 'sync');
      if (holds) {
        requeue(calls.slice(index + 1).flatMap(c => c.opIds));
        // A refusal the governor holds: the loop's admission check sleeps through the pause, then flushes again.
        if (paused) {
          this.opsDirty = true;
          this.holdOps(undefined);
        }
        return true;
      }
    }
    this.opsDirty = true;
    return true;
  }

  // ---------------------------------------------------------------- status

  private refusalStatus(admission: { cls: string; reason: string; until?: number }): StatusView {
    const { governor, clock } = this.deps;
    const budget = this.deps.budget.id;
    const snap = governor.snapshot(this.id).find(s => s.budget === budget);
    const project = governor.snapshot(PROJECT).find(s => s.budget === budget);
    return statusOfRefusal(admission as Parameters<typeof statusOfRefusal>[0], {
      now: clock.now(),
      reconnectBy: this.deps.reconnectBy,
      concurrency: snap !== undefined && snap.inFlightLimit < this.deps.budget.inFlight,
      project:
        project?.dailyBlockUntil !== undefined && project.dailyBlockUntil === admission.until,
    });
  }

  private backfillStatus(): StatusView {
    return { status: { state: 'backfilling', done: this.backfillRead } };
  }

  private idleStatus(): StatusView {
    if (this.failure) return this.failure;
    if (!this.runtime.baselineDoneAt) return { status: { state: 'syncing' } };
    return { status: { state: 'ok' } };
  }

  private afterStepStatus(step: PlannedStep, baselineDoneAt: number | undefined): StatusView {
    const admission = this.deps.governor.admission(this.id, this.deps.budget.id, 'incremental');
    if (!admission.ok) return this.refusalStatus(admission);
    if (baselineDoneAt === undefined) return { status: { state: 'syncing' } };
    if (step.lane === 'backfill') return this.backfillStatus();
    return { status: { state: 'ok' } };
  }

  private statusWrites(view: StatusView): StoreWrite[] {
    if (sameStatus(this.view, view)) return [];
    return [
      { kind: 'account', id: this.id, status: view.status, reasonCode: view.reasonCode ?? null },
    ];
  }

  /** Commits a changed status (`accounts.status*`) and tells subscribers. */
  private setStatus(view: StatusView): void {
    const writes = this.statusWrites(view);
    if (!writes.length) return;
    this.commit(writes);
    this.applyStatus(view);
  }

  /** True when the status changed (and subscribers were told). */
  private applyStatus(view: StatusView): boolean {
    const before = this.view;
    if (sameStatus(before, view)) return false;
    this.view = view;
    this.runtime.status = view.status;
    if (view.reasonCode) this.runtime.reasonCode = view.reasonCode;
    else delete this.runtime.reasonCode;
    const snap = this.deps.governor.snapshot(this.id).find(s => s.budget === this.deps.budget.id);
    if (snap?.sendBlockedUntil !== undefined) this.runtime.sendBlockedUntil = snap.sendBlockedUntil;
    else delete this.runtime.sendBlockedUntil;
    const status = view.status as { class?: string; reason?: string };
    this.log.event('sync.status_changed', {
      from: before?.status.state ?? 'starting',
      to: view.status.state,
      ...(status.class ? { class: status.class } : {}),
      ...(status.reason ? { reason: status.reason } : {}),
    });
    this.emit();
    return true;
  }

  private emit(): void {
    try {
      this.deps.onStatus(this.runtime);
    } catch {
      // A failing subscriber never stops the actor.
    }
  }

  /**
   * `runtime.missingPermissions`: the feature-level gaps that do not halt the account (D12, governor.ts `permission`).
   * Today the only producer is calendar — a provider that has a calendar half whose grant lacks its scopes gets the
   * Settings row (`Account.missingPermissions` capability 'calendar'), at start, on reconnect and on a `permission`
   * refusal that names the scopes. Never `needsPermission`: that is the core mail scope's alone.
   */
  refreshMissingPermissions(): void {
    const missing = this.missingPermissionsNow() ?? [];
    const before = this.runtime.missingPermissions ?? [];
    if (
      before.length === missing.length &&
      before.every(
        (b, i) =>
          b.capability === missing[i]!.capability &&
          b.reasonCode === missing[i]!.reasonCode &&
          b.missingScopes.join(' ') === missing[i]!.missingScopes.join(' '),
      )
    )
      return;
    this.runtime.missingPermissions = missing.length ? missing : undefined;
    this.emit();
  }

  /**
   * An event write was refused because the grant only reads. Returns whether the grant really lacks the scope
   * (a stale refusal after a re-consent is not a gap). `Account.missingPermissions` then carries a `calendarWrite`
   * row that Settings → Calendar turns into "Enable editing".
   */
  calendarWriteRefused(): boolean {
    if (hasCalendarWrite(this.runtime.grantedScopes)) return false;
    this.calendarWriteGap = [GOOGLE_CALENDAR_WRITE_SCOPE];
    this.refreshMissingPermissions();
    return true;
  }

  /** The gaps right now, or undefined when nothing is missing. */
  private missingPermissionsNow(): NonNullable<AccountRuntime['missingPermissions']> | undefined {
    const read = this.calendarReadGap();
    if (read) return read;
    if (this.calendarWriteGap === undefined) return undefined;
    return [
      {
        capability: 'calendarWrite',
        reasonCode: 'permission.calendarWrite',
        missingScopes: this.calendarWriteGap,
      },
    ];
  }

  /** The read-side gap: the calendar scopes the grant lacks (or that a refusal named), or undefined. */
  private calendarReadGap(): NonNullable<AccountRuntime['missingPermissions']> | undefined {
    if (this.deps.adapter.calendar === undefined) return undefined;
    // A `permission` refusal names the scopes it was refused for — that outranks the stored capability,
    // which can be stale after a revocation (reconnect re-derives it).
    if (this.calendarScopeGap !== undefined) {
      return [
        {
          capability: 'calendar',
          reasonCode: 'permission.calendar',
          missingScopes: this.calendarScopeGap,
        },
      ];
    }
    if (this.runtime.capabilities.calendar === true) return undefined;
    // Before a refusal has run, the gap is whichever calendar scopes the grant lacks.
    return [
      {
        capability: 'calendar',
        reasonCode: 'permission.calendar',
        missingScopes: GOOGLE_CALENDAR_SCOPES.filter(s => !this.runtime.grantedScopes.includes(s)),
      },
    ];
  }

  // ---------------------------------------------------------------- waiting and liveness

  /** Sleeps until `until` (or until interrupted), beating the heartbeat every 30 s. */
  private async idle(until: number): Promise<void> {
    const { clock, deadlines } = this.deps;
    this.nextAt = until === Infinity ? undefined : until;
    deadlines.changed(`sync:${this.id}`);
    const sleeper = new AbortController();
    this.sleeper = sleeper;
    const signal = AbortSignal.any([sleeper.signal, this.stopper.signal]);
    try {
      while (!signal.aborted) {
        const now = clock.now();
        if (until <= now) break;
        await clock.sleep(Math.min(until - now, HEARTBEAT_MS), signal).catch(() => {});
        this.beat();
      }
    } finally {
      if (this.sleeper === sleeper) this.sleeper = undefined;
    }
  }

  private interrupt(): void {
    this.sleeper?.abort();
  }

  private beat(): void {
    this.heartbeat = this.deps.clock.now();
  }

  /** During a step, the heartbeat beats only while a request waits in the governor; a stalled adapter goes silent. */
  tick(): AbortController {
    const ticker = new AbortController();
    const signal = AbortSignal.any([ticker.signal, this.stopper.signal]);
    void (async () => {
      while (!signal.aborted) {
        await this.deps.clock.sleep(HEARTBEAT_MS, signal).catch(() => {});
        if (!signal.aborted && this.waiting > 0) this.beat();
      }
    })();
    return ticker;
  }

  /** Every governed request beats on entry to and exit from `fn`, and counts as waiting while outside it. */
  private countWaits(bound: BoundGovernor): BoundGovernor {
    return {
      ...bound,
      run: (req, fn) => {
        this.waiting++;
        return bound
          .run(req, async io => {
            this.waiting--;
            this.beat();
            try {
              return await fn(io);
            } finally {
              this.waiting++;
              this.beat();
            }
          })
          .finally(() => {
            this.waiting--;
          });
      },
    };
  }

  private commit(writes: StoreWrite[], origin: 'system' | 'sync' = 'system'): void {
    if (!writes.length || this.stopped) return;
    this.deps.store.commit({ opId: this.deps.newId(), origin, writes });
  }

  /** The catalog's provider family for `sync.<family>.*` lines. */
  private family(): 'gmail' | 'gcal' | 'graph' | 'imap' | 'jmap' | 'caldav' {
    const id = this.deps.budget.id;
    return id === 'gcal' || id === 'graph' || id === 'imap' || id === 'jmap' || id === 'caldav'
      ? id
      : 'gmail';
  }
}
