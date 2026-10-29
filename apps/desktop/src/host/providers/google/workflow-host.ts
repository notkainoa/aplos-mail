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
 *   The account starts as secondary until the lease's first read decides, and the host commits each read's
 *   `nextState` as the `workflow` scope row.
 * - `googleWorkflowMerged` is `ActorHostOptions.onWorkflowMerged`: it turns the `thread:` records a merge moved —
 *   the actor's workflow round `ingest`, or the lease's read — into `WorkflowWrite`s (`workflow-facts.ts`) and
 *   commits them. `StepResult` has no field for workflow facts (a port gap: `ports/provider.ts`), so they cannot
 *   ride the round's own commit; this handler commits them in a following transaction, keyed by their content op id
 *   (`workflowOpId`), which makes a replayed merge a store no-op.
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

/**
 * `ActorHostOptions.onWorkflowMerged` for Gmail accounts: commits the changed `thread:` records as `WorkflowWrite`s.
 * The lookup is async, so the commit lands in a following transaction — the port gap in the header means it can
 * never join the round's own commit; the content-derived op id keeps a re-delivered merge idempotent.
 */
export function googleWorkflowMerged(
  deps: GoogleWorkflowFactsDeps,
): (account: AccountId, changed: readonly MergedWorkflowRecord[]) => void {
  return (account, changed) => {
    void commitFacts(deps, account, changed).catch(() => {
      // No catalog event names this path and the catalog is not this lane's to extend: log the closest fit.
      deps.log?.event('rpc.failed', { method: 'gmail.workflowFacts', reason: 'commit' });
    });
  };
}

async function commitFacts(
  deps: GoogleWorkflowFactsDeps,
  account: AccountId,
  changed: readonly MergedWorkflowRecord[],
): Promise<void> {
  const records: WorkflowRecord[] = changed
    .filter(r => r.key.startsWith(THREAD_PREFIX))
    .map(r => ({ key: r.key, stamp: r.stamp, value: r.value as JsonValue }));
  if (!records.length) return;
  const ids = records.map(r => r.key.slice(THREAD_PREFIX.length));
  const facts = workflowFacts({
    accountId: account,
    records,
    known: await deps.lookup(account).knownThreads(ids),
    local: localStamps(deps.store, account, ids),
  });
  const commit = workflowCommit(account, facts);
  if (commit) deps.store.commit(commit);
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
