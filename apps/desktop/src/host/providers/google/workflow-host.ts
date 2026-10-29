import type {
  AccountId,
  AdapterAccount,
  DeviceId,
  KeyProvider,
  KnownLookup,
  Logger,
  ProviderAdapter,
} from '@aplos/engine/ports';
import type { StorePort } from '@aplos/engine/store';
import { GmailAdapter } from './adapter';
import { THREAD_PREFIX, type JsonValue, type Stamp, type WorkflowRecord } from './workflow-merge';
import { workflowCommit, workflowFacts } from './workflow-facts';
import { createWorkflowStateChannel, type WorkflowStateChannel } from './workflow-state';

/**
 * The host-side wiring of the Gmail workflow channel (plan 20 PV3, ARCH 6.5): the two `ActorHostOptions` callbacks
 * that make a real account use it.
 *
 * - `googleWorkflowChannel` is `ActorHostOptions.workflowChannel`: it builds the `WorkflowStateChannel`
 *   (`workflow-state.ts`) over the adapter's paced `GmailWorkflowTransport`, so `ActorHost.claimLease/releaseLease`,
 *   every role report and the lease's own rounds go through `createLeaseController` on the sealed-copy channel.
 *   The lease's round is then the account's one channel reader (the actor skips its planned `workflow` step); the
 *   account starts as secondary until that round decides, and the host commits the `workflow` scope row when a
 *   read moved the cursor.
 * - `googleWorkflowMerged` is `ActorHostOptions.onWorkflowMerged`: after every channel read it turns the `thread:`
 *   records the merge moved into `WorkflowWrite`s (`workflow-facts.ts`) and commits them. `StepResult` has no field
 *   for workflow facts (a port gap: `ports/provider.ts`), so they cannot ride the round's own commit; this handler
 *   commits them in a following transaction, keyed by their content op id (`workflowOpId`), which makes a replayed
 *   merge a store no-op. A record whose thread is not stored yet (a fresh device's first read sees Done and Later for
 *   threads the backfill has not reached) is kept by key in a bounded per-account pending set and offered again on
 *   every later read once the store has moved, with its value taken from the read's merged view (the source of
 *   truth), until it applies or leaves the view. The set lives in memory; after a restart the first read is a full
 *   one and reports the whole view as changed, which rebuilds it.
 *
 * The account opts in through `GoogleProviderOptions.workflow` (`adapter.ts`); both halves are inert until then.
 */

export interface GoogleWorkflowDeps {
  /** The engine's data key, from the host — never read from the environment (`workflow-seal.ts`). */
  keys: KeyProvider;
  /** This device's stable id: the lease's claims and this device's record stamps name it. */
  device: DeviceId;
}

/** A merged record as `ActorHostOptions.onWorkflowMerged` reports it (the engine's `LeaseRecord` shape). */
export interface MergedWorkflowRecord {
  key: string;
  stamp: Stamp;
  value: unknown;
}

/**
 * `ActorHostOptions.workflowChannel` for Gmail accounts: the `WorkflowStateChannel` on the account's transport.
 * Returns undefined for any other adapter — and for a Gmail adapter built without `workflow` — so the host keeps
 * its local lease behaviour there.
 */
export function googleWorkflowChannel(
  deps: GoogleWorkflowDeps,
): (account: AdapterAccount, adapter: ProviderAdapter) => WorkflowStateChannel | undefined {
  return (account, adapter) => {
    const transport = adapter instanceof GmailAdapter ? adapter.workflowTransport() : undefined;
    if (!transport) return undefined;
    return createWorkflowStateChannel({
      transport,
      keys: deps.keys,
      device: deps.device,
      address: account.address,
    });
  };
}

export interface GoogleWorkflowFactsDeps {
  store: StorePort;
  /** The store's `KnownLookup` per account (the host's `lookup` option works). */
  lookup: (account: AccountId) => KnownLookup;
  log?: Logger;
}

/** Thread keys one account keeps waiting for their thread; past this the newest deferrals are dropped (logged). */
export const MAX_PENDING_FACTS = 5_000;

/** Per account: the deferred `thread:` keys, the store seq they were last tried at, and the commit queue. */
interface PendingFacts {
  keys: Set<string>;
  triedAt: number;
  /** The set overflowed once (logged once). */
  full: boolean;
  queue: Promise<void>;
}

/**
 * `ActorHostOptions.onWorkflowMerged` for Gmail accounts: commits the changed `thread:` records as `WorkflowWrite`s,
 * and retries the deferred ones (see the header). The lookup is async, so the commit lands in a following
 * transaction — the port gap in the header means it can never join the round's own commit; the content-derived op id
 * keeps a re-delivered merge idempotent. Calls run one at a time per account.
 */
export function googleWorkflowMerged(
  deps: GoogleWorkflowFactsDeps,
): (
  account: AccountId,
  changed: readonly MergedWorkflowRecord[],
  view: readonly MergedWorkflowRecord[],
) => void {
  const pending = new Map<AccountId, PendingFacts>();
  return (account, changed, view) => {
    const state = pending.get(account) ?? {
      keys: new Set(),
      triedAt: -1,
      full: false,
      queue: Promise.resolve(),
    };
    pending.set(account, state);
    state.queue = state.queue
      .then(() => commitFacts(deps, account, state, { changed, view }))
      .catch(() => {
        // Retried at the next read, whether or not the store moved.
        state.triedAt = -1;
        // No catalog event names this path and the catalog is not this lane's to extend: log the closest fit.
        deps.log?.event('rpc.failed', { method: 'gmail.workflowFacts', reason: 'commit' });
      });
  };
}

/** The thread records to try now: every changed one, plus the deferred ones (from the view) once the store moved. */
function candidates(
  state: PendingFacts,
  merge: { changed: readonly MergedWorkflowRecord[]; view: readonly MergedWorkflowRecord[] },
  seq: number,
): Map<string, WorkflowRecord> {
  const out = new Map<string, WorkflowRecord>();
  const add = (r: MergedWorkflowRecord) =>
    out.set(r.key, { key: r.key, stamp: r.stamp, value: r.value as JsonValue });
  if (state.keys.size && seq !== state.triedAt) {
    const current = new Map(merge.view.map(r => [r.key, r]));
    for (const key of state.keys) {
      const record = current.get(key);
      // Gone from the view (retention): nothing will ever apply it.
      if (record) add(record);
      else state.keys.delete(key);
    }
  }
  for (const r of merge.changed) if (r.key.startsWith(THREAD_PREFIX)) add(r);
  return out;
}

async function commitFacts(
  deps: GoogleWorkflowFactsDeps,
  account: AccountId,
  state: PendingFacts,
  merge: { changed: readonly MergedWorkflowRecord[]; view: readonly MergedWorkflowRecord[] },
): Promise<void> {
  const seq = deps.store.seq();
  const records = [...candidates(state, merge, seq).values()];
  if (!records.length) return;
  // Held until the commit lands: a failed lookup or commit leaves them to the next read.
  hold(deps, state, records);
  const ids = records.map(r => r.key.slice(THREAD_PREFIX.length));
  const known = await deps.lookup(account).knownThreads(ids);
  const facts = workflowFacts({
    accountId: account,
    records,
    known,
    local: localStamps(deps.store, account, ids),
  });
  const commit = workflowCommit(account, facts);
  if (commit) deps.store.commit(commit);
  state.triedAt = deps.store.seq();
  // Applied (or refused) for a stored thread: done. The rest wait for their thread.
  for (const r of records)
    if (known.has(r.key.slice(THREAD_PREFIX.length))) state.keys.delete(r.key);
}

/** Adds the records' keys to the pending set, up to `MAX_PENDING_FACTS`; an overflow is logged once. */
function hold(
  deps: GoogleWorkflowFactsDeps,
  state: PendingFacts,
  records: readonly WorkflowRecord[],
): void {
  let dropped = false;
  for (const r of records) {
    if (state.keys.has(r.key) || state.keys.size < MAX_PENDING_FACTS) state.keys.add(r.key);
    else dropped = true;
  }
  if (!dropped || state.full) return;
  state.full = true;
  deps.log?.event('rpc.failed', { method: 'gmail.workflowFacts', reason: 'pendingFull' });
}

/** The stored edit stamp (`edited_at`, `edit_gen`, `edit_device`) per remote thread id, for `FactsInput.local`. */
function localStamps(
  store: StorePort,
  accountId: string,
  remoteThreadIds: readonly string[],
): Map<string, Stamp> {
  const out = new Map<string, Stamp>();
  if (!remoteThreadIds.length) return out;
  const marks = remoteThreadIds.map(() => '?').join(',');
  const rows = store.read(q =>
    q.all<{ id: string; at: number | null; gen: number | null; device: string | null }>(
      `SELECT t.remote_id AS id, w.edited_at AS at, w.edit_gen AS gen, w.edit_device AS device
       FROM threads t JOIN thread_workflow w ON w.thread_id = t.id
       WHERE t.account_id = ? AND t.remote_id IN (${marks})`,
      accountId,
      ...remoteThreadIds,
    ),
  );
  for (const r of rows) {
    if (r.at === null || r.gen === null || r.device === null) continue;
    out.set(r.id, { at: r.at, gen: r.gen, device: r.device });
  }
  return out;
}
