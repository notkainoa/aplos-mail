import type { Account, AccountStatus } from '@aplos/contract';
import type { AccountRuntime } from '../ports';
import type { StorePort } from '../store/port';

// What `Account/get` and `Account/set` show of an account: the stored row plus the actor's live status. The contract
// `Account` never carries a credential reference, a vault key or a token; only the columns named here are read.

type AccountRow = {
  id: string;
  provider: string;
  address: string;
  display_name: string | null;
  capabilities: string;
  granted_scopes: string | null;
  status: string;
  status_reason: string | null;
  status_reason_code: string | null;
  status_detail: string | null;
  resume_at: number | null;
  baseline_done_at: number | null;
  calendar_listed_at: number | null;
  refresh_expires_at: number | null;
  remote_subject: string | null;
  ai_allowed: number;
  settings: string;
  created_at: number;
};

/** Owner choices kept in `accounts.settings` (a JSON document). Read only until the store exposes a write for it. */
interface AccountSettings {
  colorTag?: string;
  notifications?: boolean;
  preset?: Account['preset'];
  server?: Account['server'];
}

const ROW_COLUMNS =
  'id, provider, address, display_name, capabilities, granted_scopes, status, status_reason, status_reason_code, status_detail, resume_at, baseline_done_at, calendar_listed_at, refresh_expires_at, remote_subject, ai_allowed, settings, created_at';

const CAPABILITY_FLAGS = [
  'labels',
  'folders',
  'drafts',
  'serverSearch',
  'calendar',
  'filters',
  'push',
  'sendAs',
  'unsubscribeHeaders',
] as const;

/** The ids of every stored account, oldest first; accounts made in one commit keep the order they were written in. */
export function accountIds(store: StorePort): string[] {
  return store.read(q =>
    q.all<{ id: string }>('SELECT id FROM accounts ORDER BY created_at, rowid').map(r => r.id),
  );
}

export function accountExists(store: StorePort, id: string): boolean {
  return store.read(q => q.get('SELECT 1 FROM accounts WHERE id = ?', id) !== undefined);
}

/** The stored identity facts a reconnect compares against. */
export function storedIdentity(
  store: StorePort,
  id: string,
): { provider: string; address: string; subject?: string } | undefined {
  const row = store.read(q =>
    q.get<{ provider: string; address: string; remote_subject: string | null }>(
      'SELECT provider, address, remote_subject FROM accounts WHERE id = ?',
      id,
    ),
  );
  if (!row) return undefined;
  return {
    provider: row.provider,
    address: row.address,
    ...(row.remote_subject ? { subject: row.remote_subject } : {}),
  };
}

/**
 * The account of this provider that already has the address or the provider's own subject, with its stored status.
 * `exceptId` leaves one account out (a retry asking whether any OTHER account holds the identity).
 */
export function accountWithIdentity(
  store: StorePort,
  provider: string,
  address: string,
  subject?: string,
  exceptId?: string,
): { id: string; status: string } | undefined {
  return store.read(q =>
    q.get<{ id: string; status: string }>(
      'SELECT id, status FROM accounts WHERE provider = ? AND id IS NOT ? AND (lower(address) = lower(?) OR (? IS NOT NULL AND remote_subject = ?))',
      provider,
      exceptId ?? null,
      address,
      subject ?? null,
      subject ?? null,
    ),
  );
}

/** The account's current contract rows, in `ids` order (every account when `ids` is absent); unknown ids are listed apart. */
export function readAccounts(
  store: StorePort,
  runtime: (id: string) => AccountRuntime | undefined,
  ids?: readonly string[],
): { list: Account[]; notFound: string[] } {
  const wanted = ids ? [...new Set(ids)] : accountIds(store);
  const list: Account[] = [];
  const notFound: string[] = [];
  for (const id of wanted) {
    const account = readAccount(store, id, runtime(id));
    if (account) list.push(account);
    else notFound.push(id);
  }
  return { list, notFound };
}

export function readAccount(
  store: StorePort,
  id: string,
  runtime: AccountRuntime | undefined,
): Account | undefined {
  const found = store.read(q => ({
    row: q.get<AccountRow>(`SELECT ${ROW_COLUMNS} FROM accounts WHERE id = ?`, id),
    rev: q.get<{ rev: number | null }>(
      "SELECT MAX(seq) AS rev FROM changes WHERE type = 'Account' AND id = ?",
      id,
    )?.rev,
    pending: q.get<{ n: number }>('SELECT COUNT(*) AS n FROM ops WHERE account_id = ?', id)?.n,
  }));
  if (!found.row) return undefined;
  return toAccount(found.row, found.rev ?? 0, found.pending ?? 0, runtime);
}

function toAccount(
  row: AccountRow,
  rev: number,
  pendingChanges: number,
  runtime: AccountRuntime | undefined,
): Account {
  const settings = parseJson<AccountSettings>(row.settings, {});
  const baselineDoneAt = runtime?.baselineDoneAt ?? row.baseline_done_at ?? undefined;
  const account: Account = {
    id: row.id,
    rev,
    provider: row.provider,
    address: row.address,
    name: row.display_name || row.address,
    demo: row.provider === 'demo',
    health: healthOf(row, runtime),
    capabilities: capabilitiesOf(row, runtime),
    grantedScopes: runtime?.grantedScopes ?? parseJson<string[]>(row.granted_scopes, []),
    aiAllowed: row.ai_allowed === 1,
    notifications: settings.notifications ?? true,
    // TODO(eng-store/eng-send): send-as identities have no store table yet; the account address is the one identity.
    identities: [
      {
        address: row.address,
        ...(row.display_name ? { name: row.display_name } : {}),
        default: true,
      },
    ],
    pendingChanges,
    createdAt: row.created_at,
  };
  if (settings.colorTag) account.colorTag = settings.colorTag;
  if (settings.preset) account.preset = settings.preset;
  if (settings.server) account.server = settings.server;
  if (baselineDoneAt !== undefined) account.baselineDoneAt = baselineDoneAt;
  if (row.calendar_listed_at !== null) account.calendarListedAt = row.calendar_listed_at;
  if (runtime?.sendBlockedUntil !== undefined) account.sendBlockedUntil = runtime.sendBlockedUntil;
  const missing = missingPermissionsOf(runtime);
  if (missing) account.missingPermissions = missing;
  const lease = leaseOf(runtime);
  if (lease) account.lease = lease;
  return account;
}

function healthOf(row: AccountRow, runtime: AccountRuntime | undefined): Account['health'] {
  if (runtime) {
    return {
      status: runtime.status,
      ...(runtime.reasonCode ? { reasonCode: runtime.reasonCode } : {}),
      ...(runtime.reconnectBy !== undefined ? { reconnectBy: runtime.reconnectBy } : {}),
      ...(runtime.lastSyncAt !== undefined ? { lastSyncAt: runtime.lastSyncAt } : {}),
    };
  }
  return {
    status: statusOfRow(row),
    ...(row.status_reason_code ? { reasonCode: row.status_reason_code } : {}),
    ...(row.refresh_expires_at !== null ? { reconnectBy: row.refresh_expires_at } : {}),
  };
}

const STATUS_DETAIL_KEYS = ['class', 'missingScopes', 'since', 'done', 'of'] as const;

/** The inverse of the store's status split. Only the status vocabulary's own fields come back from the detail JSON. */
function statusOfRow(row: AccountRow): AccountStatus {
  const detail = parseJson<Record<string, unknown>>(row.status_detail, {});
  const known = Object.fromEntries(
    STATUS_DETAIL_KEYS.filter(key => key in detail).map(key => [key, detail[key]]),
  );
  return {
    ...known,
    state: row.status,
    ...(row.status_reason !== null ? { reason: row.status_reason } : {}),
    ...(row.resume_at !== null ? { until: row.resume_at } : {}),
  } as AccountStatus;
}

function capabilitiesOf(
  row: AccountRow,
  runtime: AccountRuntime | undefined,
): Account['capabilities'] {
  const source: Record<string, unknown> = runtime
    ? { ...runtime.capabilities }
    : parseJson<Record<string, unknown>>(row.capabilities, {});
  const flags = Object.fromEntries(CAPABILITY_FLAGS.map(key => [key, source[key] === true]));
  const capabilities = flags as unknown as Account['capabilities'];
  if (typeof source.importance === 'boolean') capabilities.importance = source.importance;
  if (typeof source.partialView === 'boolean') capabilities.partialView = source.partialView;
  if (source.threading === 'native' || source.threading === 'headers')
    capabilities.threading = source.threading;
  return capabilities;
}

function missingPermissionsOf(runtime: AccountRuntime | undefined): Account['missingPermissions'] {
  if (!runtime?.missingPermissions?.length) return undefined;
  return runtime.missingPermissions.map(m => ({
    capability: String(m.capability),
    reasonCode: m.reasonCode,
    missingScopes: m.missingScopes,
  }));
}

function leaseOf(runtime: AccountRuntime | undefined): Account['lease'] {
  return runtime?.lease ? leaseView(runtime.lease) : undefined;
}

/** The wire `Lease` of an actor's lease facts. */
export function leaseView(
  lease: NonNullable<AccountRuntime['lease']>,
): NonNullable<Account['lease']> {
  return {
    role: lease.role,
    ...(lease.holder ? { holderDeviceId: lease.holder } : {}),
    ...(lease.until !== undefined ? { until: lease.until } : {}),
    ...(lease.pinned !== undefined ? { pinned: lease.pinned } : {}),
  };
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
