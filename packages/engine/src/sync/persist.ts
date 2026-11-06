import type { ErrorClass } from '@aplos/contract';
import type {
  AccountId,
  AdapterAccount,
  BudgetId,
  Capabilities,
  GovernorSnapshot,
  ProjectScope,
  ProviderKind,
  ScopeId,
  StorePort,
  SyncState,
} from '../ports';
import type { GovernorWrite } from '../store/port';

// The actor's reads of committed state and the governor_state mapping. Reads go through `store.read` only; every write
// is a `store.commit` built by the caller.

interface GovernorRow {
  budget: string;
  target: number | null;
  cooldown_until: number | null;
  reason: string | null;
  daily_block_until: number | null;
  cooldown_step: number;
  last_refusal_at: number | null;
  cls: string | null;
  in_flight_limit: number | null;
  batch_size: number | null;
  window_spent: number | null;
  window_at: number | null;
  send_blocked_until: number | null;
  blocked_cls: string | null;
  blocked_since: number | null;
  [key: string]: string | number | null;
}

/** One snapshot as a `governor` write: every field, so the row always equals the snapshot (prov-gov-T21). */
export function governorWrite(
  account: AccountId | ProjectScope,
  snap: GovernorSnapshot,
): GovernorWrite {
  return {
    kind: 'governor',
    accountId: account,
    budget: snap.budget,
    patch: {
      target: snap.target,
      cooldownUntil: snap.cooldownUntil ?? null,
      reason: snap.reason ?? null,
      dailyBlockUntil: snap.dailyBlockUntil ?? null,
      cooldownStep: snap.cooldownStep,
      lastRefusalAt: snap.lastRefusalAt ?? null,
      cls: snap.cls ?? null,
      inFlightLimit: snap.inFlightLimit,
      batchSize: snap.batchSize,
      windowSpent: snap.windowSpent,
      windowAt: snap.windowAt,
      sendBlockedUntil: snap.sendBlockedUntil ?? null,
      blockedCls: snap.blocked?.cls ?? null,
      blockedSince: snap.blocked?.since ?? null,
    },
  };
}

/** The persisted snapshots of one account (or `'*'`), as `GovernorPort.restore` takes them. */
export function readGovernor(
  store: StorePort,
  account: AccountId | ProjectScope,
): GovernorSnapshot[] {
  const rows = store.read(q =>
    q.all<GovernorRow>(
      'SELECT * FROM governor_state WHERE account_id = ? ORDER BY budget',
      account,
    ),
  );
  return rows.map(row => {
    const snap: GovernorSnapshot = {
      budget: row.budget as BudgetId,
      target: row.target ?? 0,
      inFlightLimit: row.in_flight_limit ?? Number.MAX_SAFE_INTEGER,
      batchSize: row.batch_size ?? 1,
      windowSpent: row.window_spent ?? 0,
      windowAt: row.window_at ?? 0,
      cooldownStep: row.cooldown_step,
    };
    if (row.cooldown_until !== null) snap.cooldownUntil = row.cooldown_until;
    if (row.daily_block_until !== null) snap.dailyBlockUntil = row.daily_block_until;
    if (row.send_blocked_until !== null) snap.sendBlockedUntil = row.send_blocked_until;
    if (row.blocked_cls === 'auth' || row.blocked_cls === 'config') {
      snap.blocked = { cls: row.blocked_cls, since: row.blocked_since ?? 0 };
    }
    if (row.cls !== null) snap.cls = row.cls as ErrorClass;
    if (row.reason !== null) snap.reason = row.reason;
    if (row.last_refusal_at !== null) snap.lastRefusalAt = row.last_refusal_at;
    // A row with no target was never written by a governor snapshot: let the governor use its own.
    if (row.target === null) snap.target = Number.MAX_SAFE_INTEGER;
    return snap;
  });
}

export interface AccountRow {
  account: AdapterAccount;
  baselineDoneAt?: number;
  refreshExpiresAt?: number;
  status: string;
}

export function readAccount(store: StorePort, id: AccountId): AccountRow | undefined {
  const row = store.read(q =>
    q.get<{
      provider: string;
      address: string;
      capabilities: string;
      granted_scopes: string | null;
      baseline_done_at: number | null;
      refresh_expires_at: number | null;
      status: string;
    }>(
      'SELECT provider, address, capabilities, granted_scopes, baseline_done_at, refresh_expires_at, status FROM accounts WHERE id = ?',
      id,
    ),
  );
  if (!row) return undefined;
  const caps = JSON.parse(row.capabilities) as Partial<Capabilities>;
  return {
    account: {
      id,
      provider: row.provider as ProviderKind,
      address: row.address,
      grantedScopes: parseScopes(row.granted_scopes),
      capabilities: { threading: 'native', ...caps } as Capabilities,
    },
    baselineDoneAt: row.baseline_done_at ?? undefined,
    refreshExpiresAt: row.refresh_expires_at ?? undefined,
    status: row.status,
  };
}

export function readStates(store: StorePort, account: AccountId): SyncState[] {
  const rows = store.read(q =>
    q.all<{
      scope: string;
      cursor: string | null;
      page_token: string | null;
      phase: string | null;
      oldest_loaded: number | null;
      generation: number;
      pending: string | null;
      updated_at: number;
    }>('SELECT * FROM sync_state WHERE account_id = ? ORDER BY scope', account),
  );
  return rows.map(row => {
    const state: SyncState = {
      scope: row.scope as ScopeId,
      generation: row.generation,
      updatedAt: row.updated_at,
    };
    if (row.cursor !== null) state.cursor = row.cursor;
    if (row.page_token !== null) state.pageToken = row.page_token;
    if (row.phase !== null) state.phase = row.phase;
    if (row.oldest_loaded !== null) state.oldestLoaded = row.oldest_loaded;
    if (row.pending !== null) state.pending = JSON.parse(row.pending) as string[];
    return state;
  });
}

export function readMemory(store: StorePort, account: AccountId): Map<string, string> {
  const rows = store.read(q =>
    q.all<{ key: string; value: string }>(
      'SELECT key, value FROM provider_memory WHERE account_id = ?',
      account,
    ),
  );
  return new Map(rows.map(r => [r.key, r.value]));
}

/** Attempts so far for quarantined items, so a poison item backs off further each time. */
export function readFailures(
  store: StorePort,
  account: AccountId,
  items: string[],
): Map<string, number> {
  if (!items.length) return new Map();
  const rows = store.read(q =>
    q.all<{ item: string; attempts: number }>(
      'SELECT item, attempts FROM sync_failures WHERE account_id = ? AND item IN (SELECT value FROM json_each(?))',
      account,
      JSON.stringify(items),
    ),
  );
  return new Map(rows.map(r => [r.item, r.attempts]));
}

/** A `granted_scopes` column: its string array, or [] for anything else — a corrupt row narrows, it never crashes. */
function parseScopes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}
