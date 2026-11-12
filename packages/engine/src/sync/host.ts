import { ContractError } from '@aplos/contract/contract-error';
import { logCodePattern } from '@aplos/contract/log/events';
import {
  PausedError,
  PROJECT,
  type AccountActorDeps,
  type AccountActorHost,
  type AccountId,
  type AccountRuntime,
  type AdapterAccount,
  type AdapterContext,
  type Admission,
  type AttachmentRef,
  type BoundGovernor,
  type BudgetId,
  type ConnectRequest,
  type ConnectResult,
  type DraftSaveResult,
  type DraftSyncPort,
  type DraftUpload,
  type GovernorPort,
  type KnownLookup,
  type OpenedThread,
  type ProviderAdapter,
  type ProviderFactory,
  type ProviderKind,
  type ScopeId,
  type ServerSearch,
  type SyncState,
  type WorkflowCopy,
} from '../ports';
import { ProviderError } from '../ports/base';
import { contractError } from '../runtime/errors';
import { AccountActor, type Role } from './actor';
import { messageWrite, syncStateWrite } from './facts';
import type { Governor } from './governor';
import {
  clockReading,
  createLeaseController,
  gateNow,
  gateReading,
  measureClock,
  needsMeasure,
  unmeasuredGate,
  type ClockGate,
  type ClockOffset,
  type LeaseChannel,
  type LeaseController,
  type LeaseRecord,
} from './lease';
import { compactMode, ownerClock, settleOwnerLift } from './host-clock';
import { calendarTargetOf, lazyCalendarPort } from '../calendar/write-target';
import { removeRemoteDraft, saveRemoteDraft } from './host-drafts';
import { entryTarget, sendPortOf } from './host-send';
import { storeLookup } from './lookup';
import { hasRequiredScope } from './scopes';
import { nextOpRetry, readFence } from './ops';
import { governorWrite, readAccount, readGovernor, readMemory, readStates } from './persist';

/** The provider reads (`host-read.ts`): loaded on the first thread open, attachment or original, not with the core. */
const Read = () => import('./host-read');

/** What the host needs from a governor beyond `GovernorPort` (F3 has no way to express either; see the port gaps). */
type GovernorExtras = Partial<Pick<Governor, 'bindConnect' | 'setBudgets'>>;

/**
 * What `ActorHostOptions.workflowChannel` returns for one account: the provider's workflow-state channel as the
 * host uses it (prov-gmail's `WorkflowStateChannel`, `google/workflow-state.ts`). `read` is one gated channel
 * round, and the lease controller's round is the account's only channel reader (the actor never runs its planned
 * `workflow` step then): the host feeds the records to `createLeaseController`, hands the merge to
 * `onWorkflowMerged`, and is the one writer of the `workflow` scope's `sync_state` row, committed only when the
 * cursor moved. `write` seals and publishes records (only the lease's claims go through it) and reports this
 * device's clock offset from the server's receive time, bracketed by the insert, for the clock gate
 * (`LeaseDeps.clockGate`; absent: unmeasurable). `compact` trashes a bounded batch of copies the last write
 * supersedes (`ownOnly`: only this device's own copies); the host starts it after a primary's renewal, or after a
 * blocked device's dead-claim write, outside the lease round.
 */
export interface HostWorkflowChannel {
  read(
    state: SyncState,
    ctx: AdapterContext,
  ): Promise<{
    records: readonly LeaseRecord[];
    changed: readonly LeaseRecord[];
    nextState: SyncState;
    costUnits: number;
  }>;
  write(
    entries: readonly { key: string; value: unknown }[],
    ctx: AdapterContext,
  ): Promise<{ clockOffset?: ClockOffset }>;
  compact(ctx: AdapterContext, options?: { ownOnly?: boolean }): Promise<number>;
  /** The clock offset from the last copy written, checked again without a new copy (`LeaseChannel.probe`). */
  probe?(ctx: AdapterContext): Promise<{ clockOffset?: ClockOffset }>;
}

/** How long a quit or disconnect waits for the dead-claim write before the actor stops anyway. */
export const LEASE_STOP_WAIT_MS = 5_000;
/** Distinct failure reasons logged per account (each once); past this, further new reasons are not logged. */
const LOGGED_REASONS_CAP = 64;

type LeaseIntent = 'pin' | 'unpin';

/** A log-safe reason code for a swallowed error: the provider's reason or the error's name, never its message. */
function reasonCode(error: unknown): string {
  let raw = 'unknown';
  if (error instanceof ProviderError) raw = error.error.reason ?? error.error.class;
  else if (error instanceof PausedError) raw = `paused.${error.reason}`;
  else if (error instanceof Error) raw = error.name;
  return logCodePattern.test(raw) ? raw : 'unknown';
}

/** The parts of a `workflow` state the transport resumes on; `generation` and `updatedAt` move every round. */
function sameCursor(a: SyncState, b: SyncState): boolean {
  if (a.cursor !== b.cursor || a.pageToken !== b.pageToken || a.phase !== b.phase) return false;
  if (a.oldestLoaded !== b.oldestLoaded) return false;
  return (a.pending ?? []).join('\n') === (b.pending ?? []).join('\n');
}

export interface ActorHostOptions {
  /** `eng-store`'s `KnownLookup`; until one exists the host reads the store itself (`storeLookup`). */
  lookup?: (account: AccountId) => KnownLookup;
  /** Commit idempotency keys; Web Crypto by default. */
  newId?: () => string;
  /** Jitter source (wake spread, step backoff). */
  random?: () => number;
  /**
   * The account's workflow-state channel, built over `adapter.workflow` (called only when the adapter exposes
   * one). When it returns a channel, `claimLease`/`releaseLease` and every role report go through
   * `createLeaseController` on it: claims publish as `lease:<deviceId>` records, `tick()` runs on the
   * `lease:<account>` deadline, and `stop` publishes an expired claim on quit or disconnect. When the option or
   * its result is absent, an adapter with `workflow` keeps the local claim/release behaviour.
   */
  workflowChannel?: (
    account: AdapterAccount,
    adapter: ProviderAdapter,
  ) => HostWorkflowChannel | undefined;
  /**
   * The copies an actor workflow round delivered, as soon as the round returns. Only accounts without a channel run
   * that round; with one, the lease's read merges the copies itself and reports them through `onWorkflowMerged`.
   */
  onWorkflowCopies?: (account: AccountId, copies: WorkflowCopy[]) => void;
  /**
   * After every successful channel read: the records the merge moved (possibly none) and the whole merged view, the
   * source of truth a subscriber re-reads to retry records it had to defer. Input for the workflow-facts commit.
   */
  onWorkflowMerged?: (
    account: AccountId,
    changed: readonly LeaseRecord[],
    view: readonly LeaseRecord[],
  ) => void;
}

interface Entry {
  actor: AccountActor;
  adapter: ProviderAdapter;
  /** The account's mail budget: what `Sync/request` and the pause status ask. */
  budget: BudgetId;
  unregister: () => void;
}

interface LeaseEntry {
  controller: LeaseController;
  /** Unregisters the `lease:<account>` deadline source. */
  unregister: () => void;
  /** The `workflow` scope state the channel reads resume on; the host is that row's only writer. */
  state: SyncState;
  /** The clock gate's input: what the writes showed of this device's clock (`measureClock`). */
  gate: ClockGate;
  /**
   * The gate as it stood before an owner's "Use this Mac" lifted its block (`ownerGate`), until a write measures the
   * clock again: a pin whose read or write then fails puts it back (`settleOwnerLift`), so the lift never outlives it.
   */
  ownerLift?: ClockGate;
  /**
   * A compaction in flight: one at a time, never inside the lease round, and aborted (between trash calls and in the
   * governor's queue) when a quit begins, so it never holds the lane the dead claim needs.
   */
  compacting?: AbortController;
  /** Quit or disconnect has begun: no new compaction starts. */
  retiring?: boolean;
  /**
   * Dropped by a 'restart': a round or owner's claim still in flight finishes against a channel that refuses it, and
   * its reports are ignored, so only the restarted actor's controller (with the gate as it stood before any lift)
   * reads, writes or sets the role.
   */
  stale?: boolean;
}

/**
 * F3 `AccountActorHost`: one actor per account, started and stopped here, plus the account-addressed provider reads.
 * It persists every governor snapshot to `governor_state` as `onChange` reports it (so the state is written before the
 * refusal reaches the caller) and restores it before an account's first request.
 */
export class ActorHost implements AccountActorHost, DraftSyncPort {
  private readonly actors = new Map<AccountId, Entry>();
  /** Lease input per account, kept across restarts of its actor. */
  private readonly leases = new Map<AccountId, NonNullable<AccountRuntime['lease']>>();
  /** The lease controller per channel-backed account, dropped on 'restart', stopped on quit or disconnect. */
  private readonly leaseCtl = new Map<AccountId, LeaseEntry>();
  /** The lease a 'restart' left published, snapshotted before the drop: the next controller's `initial`, used once. */
  private readonly leaseSeed = new Map<AccountId, NonNullable<AccountRuntime['lease']>>();
  /** The clock gate a 'restart' left, for the next controller (an ok reading still counts only while fresh). */
  private readonly leaseClock = new Map<AccountId, ClockGate>();
  /** "Use this Mac" or its release, asked before the controller could run it: applied at its first round. */
  private readonly leaseIntent = new Map<AccountId, LeaseIntent>();
  /** Accounts whose lease round waits for the baseline sync; poked when it is done. */
  private readonly leaseHeld = new Set<AccountId>();
  /** The failure reasons already logged, per account. */
  private readonly loggedReasons = new Map<AccountId, Set<string>>();
  private readonly listeners = new Set<(account: AccountId, status: AccountRuntime) => void>();
  private readonly unsubscribe: () => void;
  private readonly unregister: (() => void)[] = [];
  private readonly newId: () => string;
  private readonly random: () => number;
  private projectRestored = false;

  constructor(
    private readonly deps: AccountActorDeps,
    private readonly options: ActorHostOptions = {},
  ) {
    this.newId = options.newId ?? (() => globalThis.crypto.randomUUID());
    this.random = options.random ?? Math.random;
    this.unsubscribe = deps.governor.onChange((account, snapshot) => {
      try {
        deps.store.commit({
          opId: this.newId(),
          origin: 'system',
          writes: [governorWrite(account, snapshot)],
        });
      } catch {
        // The store is gone (shutdown); the next start restores from what was written.
      }
    });
    this.unregister.push(
      deps.deadlines.register({
        id: 'governor',
        next: async () => this.nextPauseEnd(),
        fire: async () => {
          // Only actors that show a pause, and whose pause is now over, plan again with `resume`.
          for (const [account, entry] of this.actors) {
            if (
              entry.actor.runtime.status.state === 'paused' &&
              this.pauseEnd(account) === undefined
            ) {
              entry.actor.resumed();
            }
          }
        },
      }),
      deps.deadlines.register({
        id: 'ops',
        next: async () => nextOpRetry(deps.store),
        fire: async () => {
          for (const entry of this.actors.values()) entry.actor.opsChanged();
        },
      }),
    );
  }

  private get governor(): GovernorPort & GovernorExtras {
    return this.deps.governor as GovernorPort & GovernorExtras;
  }

  // ---------------------------------------------------------------- lifecycle

  async connect(
    account: AccountId,
    kind: ProviderKind,
    req: ConnectRequest,
  ): Promise<ConnectResult> {
    const factory = this.factory(kind);
    const controller = new AbortController();
    const abort = () => controller.abort(req.signal?.reason);
    if (req.signal?.aborted) abort();
    else req.signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await factory.connect(req, {
        accountId: account,
        governor: this.connectGovernor(account),
        clock: this.deps.clock,
        log: this.deps.log.with({ account }),
        signal: controller.signal,
      });
      if (req.signal?.aborted)
        await this.discardLate(account, kind, result.credentialRef, req.signal.reason);
      return result;
    } finally {
      req.signal?.removeEventListener('abort', abort);
    }
  }

  async discardCredential(account: AccountId, kind: ProviderKind, ref: string): Promise<void> {
    // The store keeps no credential ref, so an account with a committed row may own `ref` (Google reconnects reuse it).
    if (readAccount(this.deps.store, account)) {
      this.logDiscard(kind, 'kept');
      return;
    }
    const factory = this.factory(kind);
    if (!factory.discardCredential) {
      this.logDiscard(kind, 'unsupported');
      throw contractError({
        type: 'unavailable',
        message: 'This account type cannot remove a saved credential.',
      });
    }
    // Every caller (the engine's refusal paths and the late-answer path) swallows the rejection, so it is logged here once.
    await factory.discardCredential(ref).catch((error: unknown) => {
      this.logDiscard(kind, 'failed');
      throw error;
    });
  }

  /** Only the provider kind and the outcome: no ref, no secret. */
  private logDiscard(kind: ProviderKind, outcome: 'unsupported' | 'failed' | 'kept'): void {
    this.deps.log.event('rpc.failed', {
      method: 'Account/discardCredential',
      reason: `${kind}.${outcome}`,
    });
  }

  /** A result that arrived after the abort: its credential goes (a failure is logged only), the abort reason surfaces. */
  private async discardLate(
    account: AccountId,
    kind: ProviderKind,
    ref: string | undefined,
    reason: unknown,
  ): Promise<never> {
    if (ref !== undefined)
      await this.discardCredential(account, kind, ref).catch(() => {
        // Already logged by discardCredential; the abort reason is what surfaces.
      });
    throw reason;
  }

  async start(account: AccountId): Promise<void> {
    if (this.actors.has(account)) return;
    const { store, governor, clock, log, env, deadlines } = this.deps;
    const row = readAccount(store, account);
    if (!row) throw new Error(`unknown account ${account}`);
    const factory = this.factory(row.account.provider);
    const memory = readMemory(store, account);
    const budgets = factory.budgets(row.account, memory);
    if (!budgets.length) throw new Error(`${factory.kind} supplies no budget`);
    this.governor.setBudgets?.(account, budgets);
    if (!this.projectRestored) {
      governor.restore(PROJECT, readGovernor(store, PROJECT));
      this.projectRestored = true;
    }
    // Before any request: a restart neither re-spends the minute nor lifts a cooldown (prov-gov-T21).
    governor.restore(account, readGovernor(store, account));
    const adapter = factory.open(row.account);
    // A provider with a workflow channel runs as secondary until the lease says otherwise; one without is primary.
    const channel =
      adapter.workflow === undefined
        ? undefined
        : this.options.workflowChannel?.(row.account, adapter);
    if (!channel) this.applyLocalIntent(account);
    const role: Role =
      this.leaseCtl.get(account)?.controller.current().role ??
      this.leases.get(account)?.role ??
      (adapter.workflow ? 'secondary' : 'primary');
    governor.setRole(account, role);
    const actor = new AccountActor({
      store,
      governor,
      bound: this.bind(account),
      clock,
      log,
      deadlines,
      env,
      adapter,
      account: row.account,
      budget: budgets[0],
      lookup: this.options.lookup?.(account) ?? storeLookup(store, account),
      newId: this.newId,
      random: this.random,
      baselineDoneAt: row.baselineDoneAt,
      reconnectBy: row.refreshExpiresAt,
      role,
      onStatus: runtime => this.notify(account, runtime),
      onWorkflowCopies: copies => this.options.onWorkflowCopies?.(account, copies),
      hostReadsWorkflow: channel !== undefined,
      leaseRole: () => this.leaseCtl.get(account)?.controller.current().role,
    });
    const lease = this.leases.get(account);
    if (lease) actor.runtime.lease = { ...lease };
    const unregister = deadlines.register({
      id: `sync:${account}`,
      next: async () => actor.next(),
      fire: async () => actor.wake('poll'),
    });
    this.actors.set(account, { actor, adapter, budget: budgets[0].id, unregister });
    if (channel && !this.leaseCtl.has(account)) this.startLease(account, channel);
    actor.start();
  }

  async stop(account: AccountId, why: 'disconnect' | 'quit' | 'restart'): Promise<void> {
    const entry = this.actors.get(account);
    if (!entry) return;
    const lease = this.leaseCtl.get(account);
    if (lease) {
      lease.unregister();
      this.leaseCtl.delete(account);
      this.leaseHeld.delete(account);
      if (why === 'restart') {
        // A 'restart' drops only the deadline: the published claim keeps living until the restarted actor's new
        // controller picks it up. Its seed is the lease as it stood now — a tick still pending on the dropped
        // controller may demote `leases` once the actor is gone.
        const seed = this.leases.get(account);
        if (seed) this.leaseSeed.set(account, seed);
        lease.stale = true;
        this.keepClock(account, lease);
      } else {
        await this.retireLease(account, lease);
      }
    }
    if (why !== 'restart') {
      this.leaseSeed.delete(account);
      this.leaseClock.delete(account);
      this.leaseIntent.delete(account);
    }
    this.actors.delete(account);
    entry.unregister();
    entry.actor.stop();
    await entry.adapter.close().catch(error => this.logOnce(account, 'adapter.close', error));
  }

  /**
   * Quit and disconnect publish an expired claim, so the lease passes on at the next round — written before the actor
   * stops, while its context still reaches the network. The write goes through the governor like every request, so
   * a paused account refuses it (zero requests while paused) and peers take over once the claim runs out
   * (`until + LEASE_SKEW_MS`); a write stuck behind the budget is waited for `LEASE_STOP_WAIT_MS` at most.
   */
  private async retireLease(account: AccountId, lease: LeaseEntry): Promise<void> {
    lease.retiring = true;
    lease.compacting?.abort();
    const timer = new AbortController();
    const timeout = this.deps.clock
      .sleep(LEASE_STOP_WAIT_MS, timer.signal)
      .then(() => 'timeout' as const)
      .catch(() => 'done' as const);
    const stopped = lease.controller.stop().then(
      () => 'done' as const,
      (error: unknown) => {
        this.logOnce(account, 'lease.stop', error);
        return 'done' as const;
      },
    );
    const outcome = await Promise.race([stopped, timeout]);
    timer.abort();
    if (outcome === 'timeout') this.logReason(account, 'lease.stop', 'timeout');
  }

  /** Stops every actor and lets go of the governor and the deadline registry (engine quit). */
  async dispose(): Promise<void> {
    await Promise.all([...this.actors.keys()].map(account => this.stop(account, 'quit')));
    this.unsubscribe();
    for (const off of this.unregister.splice(0)) off();
  }

  async reconnected(account: AccountId, result: ConnectResult): Promise<void> {
    const { store, governor } = this.deps;
    // Nothing is stored and the auth block stays when the grant lacks the mail scope (D5): the engine checks first too.
    if (!hasRequiredScope(result))
      throw new ProviderError({
        class: 'permission',
        provider: 'oauth',
        method: 'oauth.reconnect',
        reason: 'missingRequiredScope',
      });
    store.commit({
      opId: this.newId(),
      origin: 'system',
      writes: [
        {
          kind: 'account',
          id: account,
          grantedScopes: result.grantedScopes,
          capabilities: { ...result.capabilities },
          remoteSubject: result.identity.subject,
          ...(result.grant
            ? {
                tokenGrantedAt: result.grant.grantedAt,
                refreshExpiresAt: result.grant.refreshExpiresAt ?? null,
                ...(result.grant.client !== undefined ? { oauthClient: result.grant.client } : {}),
              }
            : {}),
        },
        ...(result.memory && Object.keys(result.memory).length
          ? [{ kind: 'providerMemory' as const, accountId: account, values: result.memory }]
          : []),
      ],
    });
    // The only way out of an auth block. Stored cursors stay: no resync, and queued ops flush first.
    governor.clear(account, 'auth');
    this.actors.get(account)?.actor.reconnected({
      grantedScopes: result.grantedScopes,
      capabilities: result.capabilities,
      reconnectBy: result.grant?.refreshExpiresAt,
    });
  }

  // ---------------------------------------------------------------- requests and hints

  request(
    account: AccountId,
    req: { scope?: ScopeId; manual: boolean; force?: boolean },
  ): Admission {
    const entry = this.actors.get(account);
    if (!entry) return { ok: false, cls: 'permanent', reason: 'notStarted' };
    const budget = entry.budget;
    // No I/O: the governor's answer decides, so a manual sync during a pause makes zero requests (X1).
    let admission = this.deps.governor.admission(account, budget, 'incremental');
    let forced = false;
    if (!admission.ok && req.force) {
      admission = this.deps.governor.retryNow(account, budget);
      forced = admission.ok;
    }
    if (admission.ok) entry.actor.request(forced);
    return admission;
  }

  requestAll(req: { manual: boolean }): Record<AccountId, Admission> {
    return Object.fromEntries(
      [...this.actors.keys()].map(account => [account, this.request(account, req)]),
    );
  }

  wake(reason: 'wake' | 'network' | 'focus' | 'push', account?: AccountId): void {
    const trigger = reason === 'push' ? 'push' : 'wake';
    for (const [id, entry] of this.actors)
      if (account === undefined || id === account) entry.actor.wake(trigger);
  }

  opsChanged(account: AccountId): void {
    this.actors.get(account)?.actor.opsChanged();
  }

  /**
   * The lease module's input (`sync/lease.ts`): the role, holder and pin for one account. Ignored for an account whose
   * lease controller runs here: only the controller's own reports move it (`applyLease`).
   */
  leaseChanged(account: AccountId, lease: NonNullable<AccountRuntime['lease']>): void {
    if (this.leaseCtl.has(account)) return;
    this.applyLease(account, lease);
  }

  private applyLease(account: AccountId, lease: NonNullable<AccountRuntime['lease']>): void {
    this.leases.set(account, { ...lease });
    const entry = this.actors.get(account);
    if (entry) entry.actor.setLease(lease);
    else this.deps.governor.setRole(account, lease.role);
  }

  /**
   * "Use this Mac". On an account with a workflow channel the pinned claim is a `lease:<deviceId>` record the
   * lease controller publishes and keeps claiming while awake; without a channel the pin is local only, recorded
   * on the account row as before.
   */
  async claimLease(account: AccountId): Promise<void> {
    if (await this.channelIntent(account, 'pin')) return;
    this.localClaim(account);
  }

  async releaseLease(account: AccountId): Promise<void> {
    if (await this.channelIntent(account, 'unpin')) return;
    this.localRelease(account);
  }

  /**
   * A claim or release through the lease controller: run now when its rounds may run, queued for its first round
   * while it waits (account not started yet, or its baseline sync not done), so the role stays what the channel
   * says until this device's own claim reads back. False when the account has no channel: the local path applies.
   */
  private async channelIntent(account: AccountId, intent: LeaseIntent): Promise<boolean> {
    const entry = this.leaseCtl.get(account);
    if (entry && this.leaseReady(account)) {
      this.leaseIntent.delete(account);
      await this.runIntent(entry, intent);
      this.deps.deadlines.changed(`lease:${account}`);
      return true;
    }
    // Started without a channel, or no channel can exist: the pin is local. Not started yet: `start` decides.
    if (!entry && (this.actors.has(account) || !this.options.workflowChannel)) return false;
    this.leaseIntent.set(account, intent);
    if (entry) this.deps.deadlines.changed(`lease:${account}`);
    return true;
  }

  private async runIntent(entry: LeaseEntry, intent: LeaseIntent): Promise<void> {
    if (intent === 'unpin') return entry.controller.release();
    try {
      await entry.controller.claim();
    } finally {
      settleOwnerLift(entry);
    }
  }

  /** At `start`, for an account that turned out to have no channel: the intent queued before it, applied locally. */
  private applyLocalIntent(account: AccountId): void {
    const intent = this.leaseIntent.get(account);
    if (!intent) return;
    this.leaseIntent.delete(account);
    if (intent === 'pin') this.localClaim(account);
    else this.localRelease(account);
  }

  private localClaim(account: AccountId): void {
    const until = this.deps.clock.now() + 30 * 60_000;
    this.deps.store.commit({
      opId: this.newId(),
      origin: 'system',
      writes: [
        {
          kind: 'account',
          id: account,
          primaryLeaseDevice: this.deps.deviceId,
          primaryLeaseUntil: until,
        },
      ],
    });
    this.applyLease(account, {
      role: 'primary',
      holder: this.deps.deviceId,
      until,
      pinned: true,
    });
  }

  private localRelease(account: AccountId): void {
    const lease = this.leases.get(account);
    if (!lease?.pinned) return;
    this.applyLease(account, { ...lease, pinned: false });
  }

  /** The runtime, with the lease as of now: a primary whose claim ran out reads secondary before the next tick. */
  status(account: AccountId): AccountRuntime | undefined {
    this.leaseCtl.get(account)?.controller.current();
    return this.actors.get(account)?.actor.runtime;
  }

  lastHeartbeat(account: AccountId): number | undefined {
    return this.actors.get(account)?.actor.lastHeartbeat();
  }

  subscribe(listener: (account: AccountId, status: AccountRuntime) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---------------------------------------------------------------- ProviderPort

  async openThread(
    account: AccountId,
    remoteThreadId: string,
    opts: { knownCount?: number; lane?: 'interactive' | 'prefetch' } = {},
  ): Promise<OpenedThread> {
    const { sharedOpen } = await Read();
    const entry = this.entry(account);
    return sharedOpen(entry, this.deps.store, () => this.newId(), account, remoteThreadId, opts);
  }

  async search(
    account: AccountId,
    query: ServerSearch,
  ): Promise<{ remoteThreadIds: string[]; nextPageToken?: string; partial?: boolean }> {
    const entry = this.entry(account);
    if (!entry.adapter.search) return { remoteThreadIds: [] };
    const ctx = entry.actor.context();
    const fence = readFence(this.deps.store, account, ctx.generation);
    const result = await entry.adapter.search(query, ctx);
    this.deps.store.commit({
      opId: this.newId(),
      origin: 'sync',
      step: 'search',
      fenceSeq: fence,
      writes: result.upserts.map(m => messageWrite(account, ctx.account.address, m)),
    });
    return {
      remoteThreadIds: result.remoteThreadIds,
      ...(result.nextPageToken !== undefined ? { nextPageToken: result.nextPageToken } : {}),
      ...(result.partial !== undefined ? { partial: result.partial } : {}),
    };
  }

  async attachment(account: AccountId, ref: AttachmentRef): Promise<AsyncIterable<Uint8Array>> {
    return (await Read()).attachmentBytes(this.entry(account), ref);
  }

  async original(
    account: AccountId,
    remoteMessageId: string,
    options?: { signal?: AbortSignal },
  ): Promise<AsyncIterable<Uint8Array>> {
    return (await Read()).originalRemote(this.entry(account), remoteMessageId, options);
  }

  // ---------------------------------------------------------------- DraftSyncPort

  /** Remote draft copies, routed to the named account's adapter (`host-drafts.ts`); nothing else addresses a draft. */
  save(account: AccountId, draft: DraftUpload): Promise<DraftSaveResult> {
    return saveRemoteDraft(account, this.draftTarget(account), draft);
  }

  remove(account: AccountId, remoteDraftId: string, expectedMessageId?: string): Promise<void> {
    return removeRemoteDraft(account, this.draftTarget(account), remoteDraftId, expectedMessageId);
  }

  /** Event writes, routed to the named account's calendar. A separate object: `remove` is taken by drafts. */
  readonly calendarPort = lazyCalendarPort(account => calendarTargetOf(this.actors.get(account)));

  readonly sendPort = sendPortOf(() => this.governor, this.actors);

  private draftTarget(account: AccountId) {
    return entryTarget(this.actors.get(account));
  }

  // ---------------------------------------------------------------- helpers

  private entry(account: AccountId): Entry {
    const entry = this.actors.get(account);
    if (!entry) throw new Error(`account ${account} is not started`);
    return entry;
  }

  private factory(kind: ProviderKind): ProviderFactory {
    const factory = this.deps.providers.find(p => p.kind === kind);
    if (!factory) throw new Error(`no provider for ${kind}`);
    return factory;
  }

  // ---------------------------------------------------------------- the lease (ARCH 6.5)

  /**
   * The lease controller on this account's workflow channel: `tick()` runs as the `lease:<account>` deadline
   * source and is the account's one channel reader, its reports arrive through `leaseChanged` like any other, and
   * each read's `nextState` is committed as the `workflow` scope row when the cursor moved. The rounds wait for the
   * baseline sync (a fresh device's first read downloads every copy), and a queued claim or release runs as the
   * first round.
   */
  private startLease(account: AccountId, channel: HostWorkflowChannel): void {
    const entry: LeaseEntry = {
      controller: undefined as unknown as LeaseController,
      unregister: () => {},
      state: this.workflowState(account),
      gate: this.leaseClock.get(account) ?? unmeasuredGate(),
    };
    this.leaseClock.delete(account);
    // The seed is used once: after a later quit or disconnect, the current `leases` is what counts.
    const initial = this.leaseSeed.get(account) ?? this.leases.get(account);
    this.leaseSeed.delete(account);
    entry.controller = createLeaseController({
      account,
      device: this.deps.deviceId,
      clock: this.deps.clock,
      channel: this.leaseChannel(account, entry, channel),
      // A controller a 'restart' replaced sets no role.
      report: (acc, lease) => entry.stale || this.applyLease(acc, lease),
      // While the actor is down (a 'restart' gap) the device acts as secondary: a tick demotes, never renews.
      active: () => this.actors.has(account),
      // The claim this device's previous controller published is still live; a quit must retire it too.
      ...(initial ? { initial } : {}),
      clockGate: () => gateReading(gateNow(entry, this.deps.clock.now()), this.deps.clock.now()),
      remeasure: () => needsMeasure(gateNow(entry, this.deps.clock.now()), this.deps.clock.now()),
      ownerClock: () => ownerClock(entry, this.deps.clock.now()),
      stale: () => entry.stale === true,
    });
    entry.unregister = this.deps.deadlines.register({
      id: `lease:${account}`,
      next: async () => this.leaseNext(account, entry),
      fire: () => this.leaseFire(account, entry),
    });
    this.leaseCtl.set(account, entry);
  }

  /** The actor runs and its baseline sync is done: the lease's rounds may read the channel. */
  private leaseReady(account: AccountId): boolean {
    const actor = this.actors.get(account)?.actor;
    return actor !== undefined && actor.runtime.baselineDoneAt !== undefined;
  }

  private leaseNext(account: AccountId, entry: LeaseEntry): number | undefined {
    if (this.leaseReady(account)) return entry.controller.next();
    this.leaseHeld.add(account);
    return undefined;
  }

  /** One lease round: the queued claim or release when there is one (kept for the next round if it fails). */
  private async leaseFire(account: AccountId, entry: LeaseEntry): Promise<void> {
    if (!this.leaseReady(account)) return;
    const intent = this.leaseIntent.get(account);
    if (!intent) return entry.controller.tick();
    this.leaseIntent.delete(account);
    try {
      await this.runIntent(entry, intent);
    } catch (error) {
      this.logOnce(account, 'lease.intent', error);
      // Refused (the clock gate): the owner's queued pin is dropped, never applied hours later on its own.
      if (error instanceof ContractError && !entry.stale) return;
      if (!this.leaseIntent.has(account)) this.leaseIntent.set(account, intent);
    }
  }

  /** `LeaseChannel` over the state channel: `read` is one gated round that also stores the cursor it ended on. */
  private leaseChannel(
    account: AccountId,
    entry: LeaseEntry,
    channel: HostWorkflowChannel,
  ): LeaseChannel {
    const ctx = (signal?: AbortSignal): AdapterContext => {
      // A controller a 'restart' replaced reaches no network, not even on the restarted actor's context.
      if (entry.stale) throw new Error('The lease controller was replaced by a restart');
      const base = this.actors.get(account)?.actor.context() ?? this.noActor(account);
      return signal ? { ...base, signal: AbortSignal.any([base.signal, signal]) } : base;
    };
    return {
      read: async () => {
        const read = await this.logFailure(account, 'lease.read', () =>
          channel.read(entry.state, ctx()),
        );
        // Replaced while reading: the cursor and the merge are the new controller's to commit.
        if (entry.stale) return read.records;
        this.adoptWorkflowState(account, entry, read.nextState);
        this.merged(account, read.changed, read.records);
        return read.records;
      },
      write: async entries => {
        const written = await this.logFailure(account, 'lease.write', () =>
          channel.write(entries, ctx()),
        );
        this.checkClock(account, entry, written?.clockOffset);
        const mode = compactMode(
          entry,
          entry.controller.current().role,
          entries,
          this.deps.clock.now(),
        );
        if (mode)
          this.startCompaction(account, entry, async signal => channel.compact(ctx(signal), mode));
        return written;
      },
      ...(channel.probe ? { probe: () => this.probeClock(account, channel, ctx) } : {}),
    };
  }

  /** Whether the receive-time check measures again (ok or off) on the last copy; it never moves the gate itself. */
  private async probeClock(
    account: AccountId,
    channel: HostWorkflowChannel,
    ctx: () => AdapterContext,
  ): Promise<boolean> {
    try {
      const probed = await channel.probe!(ctx());
      return clockReading(probed.clockOffset) !== 'unmeasurable';
    } catch (error) {
      this.logOnce(account, 'lease.probe', error);
      return false;
    }
  }

  /** The clock gate's measurement from one write; a clock off or unmeasurable is logged once per account. */
  private checkClock(account: AccountId, entry: LeaseEntry, offset: ClockOffset | undefined): void {
    const measured = clockReading(offset);
    // The pin's own write landed: a lift stands or falls by its reading, and is undone when it measured nothing.
    if (entry.ownerLift && measured === 'unmeasurable') entry.gate = entry.ownerLift;
    entry.ownerLift = undefined;
    entry.gate = measureClock(entry.gate, offset, this.deps.clock.now());
    if (measured !== 'ok') this.logReason(account, 'lease.clock', measured);
  }

  /**
   * One bounded `compact` (the channel trashes at most a batch per call), started outside the lease round so a quit's
   * dead claim never queues behind it; one at a time, and a failure never fails the lease write.
   */
  private startCompaction(
    account: AccountId,
    entry: LeaseEntry,
    run: (signal: AbortSignal) => Promise<number>,
  ): void {
    if (entry.compacting) return;
    const stop = new AbortController();
    entry.compacting = stop;
    void run(stop.signal)
      .catch((error: unknown) => {
        if (!stop.signal.aborted) this.logOnce(account, 'lease.compact', error);
      })
      .finally(() => {
        if (entry.compacting === stop) entry.compacting = undefined;
      });
  }

  /** A 'restart' keeps the clock gate for the restarted actor's controller (`gateReading` ages an ok reading out). */
  private keepClock(account: AccountId, entry: LeaseEntry): void {
    this.leaseClock.set(account, entry.ownerLift ?? entry.gate);
  }

  /** Runs `fn`; a failure is logged once per reason and rethrown (the lease controller keeps its own handling). */
  private async logFailure<T>(
    account: AccountId,
    method: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      this.logOnce(account, method, error);
      throw error;
    }
  }

  private logOnce(account: AccountId, method: string, error: unknown): void {
    this.logReason(account, method, reasonCode(error));
  }

  /** One `rpc.failed` line per account, method and reason code: no message text, no ids, no secrets. */
  private logReason(account: AccountId, method: string, reason: string): void {
    const seen = this.loggedReasons.get(account) ?? new Set<string>();
    this.loggedReasons.set(account, seen);
    const key = `${method}:${reason}`;
    if (seen.has(key) || seen.size >= LOGGED_REASONS_CAP) return;
    seen.add(key);
    this.deps.log.with({ account }).event('rpc.failed', { method, reason });
  }

  /** A channel call while the account's actor is down (a 'restart' gap) simply fails that round. */
  private noActor(account: AccountId): never {
    throw new Error(`account ${account} is not started`);
  }

  /** The `workflow` scope state the channel reads resume on: the committed row, or the empty state. */
  private workflowState(account: AccountId): SyncState {
    return (
      readStates(this.deps.store, account).find(s => s.scope === 'workflow') ?? {
        scope: 'workflow',
        generation: 0,
        updatedAt: 0,
      }
    );
  }

  /** A read's `nextState` becomes the cursor; the row is written only when the cursor moved (no idle commits). */
  private adoptWorkflowState(account: AccountId, entry: LeaseEntry, next: SyncState): void {
    const before = entry.state;
    entry.state = next;
    if (!sameCursor(before, next)) this.commitWorkflowState(account, next);
  }

  /** The `workflow` scope's `sync_state` row — the same write a step's commit makes. */
  private commitWorkflowState(account: AccountId, next: SyncState): void {
    try {
      this.deps.store.commit({
        opId: this.newId(),
        origin: 'sync',
        step: 'workflow',
        writes: [syncStateWrite(account, next)],
      });
    } catch (error) {
      // The store is gone (shutdown); the next read that moves the cursor commits it.
      this.logOnce(account, 'lease.cursor', error);
    }
  }

  /** A channel read's merge, handed to the facts path; a hook failure never stops the host. */
  private merged(
    account: AccountId,
    changed: readonly LeaseRecord[],
    view: readonly LeaseRecord[],
  ): void {
    if (!this.options.onWorkflowMerged) return;
    try {
      this.options.onWorkflowMerged(account, changed, view);
    } catch (error) {
      this.logOnce(account, 'workflow.merged', error);
    }
  }

  private bind(account: AccountId): BoundGovernor {
    const governor = this.deps.governor;
    return {
      run: (req, fn) => governor.run(account, req, fn),
      observe: (budget, error, scope) => governor.observe(account, budget, error, scope),
      charge: (budget, amount) => governor.charge(account, budget, amount),
      batchSize: budget => governor.batchSize(account, budget),
    };
  }

  /** Connect ignores the auth block it exists to lift; only this package's governor can express that (port gap). */
  private connectGovernor(account: AccountId): BoundGovernor {
    return this.governor.bindConnect ? this.governor.bindConnect(account) : this.bind(account);
  }

  /** When the account's mail pause ends, if it has a timed one. */
  private pauseEnd(account: AccountId): number | undefined {
    const entry = this.actors.get(account);
    if (!entry) return undefined;
    const admission = this.deps.governor.admission(account, entry.budget, 'incremental');
    return admission.ok ? undefined : admission.until;
  }

  private nextPauseEnd(): number | undefined {
    const ends = [...this.actors.keys()]
      .map(a => this.pauseEnd(a))
      .filter((t): t is number => t !== undefined);
    return ends.length ? Math.min(...ends) : undefined;
  }

  private notify(account: AccountId, runtime: AccountRuntime): void {
    // The baseline sync just finished: the held lease round may read now.
    if (runtime.baselineDoneAt !== undefined && this.leaseHeld.delete(account))
      this.deps.deadlines.changed(`lease:${account}`);
    for (const listener of this.listeners) {
      try {
        listener(account, runtime);
      } catch {
        // A failing subscriber never stops the host.
      }
    }
  }
}
