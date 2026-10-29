import {
  PROJECT,
  type AccountActorDeps,
  type AccountActorHost,
  type AccountId,
  type AccountRuntime,
  type Admission,
  type AttachmentRef,
  type BoundGovernor,
  type BudgetId,
  type ConnectRequest,
  type ConnectResult,
  type GovernorPort,
  type KnownLookup,
  type OpenedThread,
  type ProviderAdapter,
  type ProviderFactory,
  type ProviderKind,
  type ScopeId,
  type ServerSearch,
  type WorkflowCopy,
} from '../ports';
import { ProviderError } from '../ports/base';
import { contractError } from '../runtime/errors';
import { AccountActor, type Role } from './actor';
import { openedWrites, messageWrite } from './facts';
import type { Governor } from './governor';
import { storeLookup } from './lookup';
import { hasRequiredScope } from './scopes';
import { nextOpRetry, readFence } from './ops';
import { governorWrite, readAccount, readGovernor, readMemory } from './persist';

/** What the host needs from a governor beyond `GovernorPort` (F3 has no way to express either; see the port gaps). */
type GovernorExtras = Partial<Pick<Governor, 'bindConnect' | 'setBudgets'>>;

export interface ActorHostOptions {
  /** `eng-store`'s `KnownLookup`; until one exists the host reads the store itself (`storeLookup`). */
  lookup?: (account: AccountId) => KnownLookup;
  /** Commit idempotency keys; Web Crypto by default. */
  newId?: () => string;
  /** Jitter source (wake spread, step backoff). */
  random?: () => number;
  /** The lease module's input from each workflow round (`sync/lease.ts`, a later package). */
  onWorkflowCopies?: (account: AccountId, copies: WorkflowCopy[]) => void;
}

interface Entry {
  actor: AccountActor;
  adapter: ProviderAdapter;
  /** The account's mail budget: what `Sync/request` and the pause status ask. */
  budget: BudgetId;
  unregister: () => void;
}

/**
 * F3 `AccountActorHost`: one actor per account, started and stopped here, plus the account-addressed provider reads.
 * It persists every governor snapshot to `governor_state` as `onChange` reports it (so the state is written before the
 * refusal reaches the caller) and restores it before an account's first request.
 */
export class ActorHost implements AccountActorHost {
  private readonly actors = new Map<AccountId, Entry>();
  /** Lease input per account, kept across restarts of its actor. */
  private readonly leases = new Map<AccountId, NonNullable<AccountRuntime['lease']>>();
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
    const role: Role =
      this.leases.get(account)?.role ?? (adapter.workflow ? 'secondary' : 'primary');
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
      onWorkflowCopies: this.options.onWorkflowCopies
        ? copies => this.options.onWorkflowCopies!(account, copies)
        : undefined,
    });
    const lease = this.leases.get(account);
    if (lease) actor.runtime.lease = { ...lease };
    const unregister = deadlines.register({
      id: `sync:${account}`,
      next: async () => actor.next(),
      fire: async () => actor.wake('poll'),
    });
    this.actors.set(account, { actor, adapter, budget: budgets[0].id, unregister });
    actor.start();
  }

  async stop(account: AccountId, _why: 'disconnect' | 'quit' | 'restart'): Promise<void> {
    const entry = this.actors.get(account);
    if (!entry) return;
    this.actors.delete(account);
    entry.unregister();
    entry.actor.stop();
    await entry.adapter.close().catch(() => {});
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

  /** The lease module's input (`sync/lease.ts`): the role, holder and pin for one account. */
  leaseChanged(account: AccountId, lease: NonNullable<AccountRuntime['lease']>): void {
    this.leases.set(account, { ...lease });
    const entry = this.actors.get(account);
    if (entry) entry.actor.setLease(lease);
    else this.deps.governor.setRole(account, lease.role);
  }

  /**
   * "Use this Mac". The pinned copy on the workflow channel is the lease module's (`sync/lease.ts`); until it lands,
   * the pin takes effect on this device only and is recorded on the account row.
   */
  async claimLease(account: AccountId): Promise<void> {
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
    this.leaseChanged(account, {
      role: 'primary',
      holder: this.deps.deviceId,
      until,
      pinned: true,
    });
  }

  async releaseLease(account: AccountId): Promise<void> {
    const lease = this.leases.get(account);
    if (!lease?.pinned) return;
    this.leaseChanged(account, { ...lease, pinned: false });
  }

  status(account: AccountId): AccountRuntime | undefined {
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
    const entry = this.entry(account);
    const ctx = entry.actor.context();
    const fence = readFence(this.deps.store, account, ctx.generation);
    const opened = await entry.adapter.openThread(
      { remoteThreadId, ...(opts.knownCount !== undefined ? { knownCount: opts.knownCount } : {}) },
      opts.lane ?? 'interactive',
      ctx,
    );
    this.deps.store.commit({
      opId: this.newId(),
      origin: 'sync',
      fenceSeq: fence,
      writes: openedWrites(ctx.account, remoteThreadId, opened),
    });
    return opened;
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
    const entry = this.entry(account);
    return entry.adapter.fetchAttachment(ref, entry.actor.context());
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
    for (const listener of this.listeners) {
      try {
        listener(account, runtime);
      } catch {
        // A failing subscriber never stops the host.
      }
    }
  }
}
