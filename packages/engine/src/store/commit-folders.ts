import type { SqlValue } from './sql';
import { StoreError, type AccountWrite, type FolderDeleteWrite, type FolderWrite } from './port';
import type { CommitRun } from './commit';

// ------------------------------------------------------------ accounts and folders

const MAX_COLOR_TAG = 40;
const MAX_SETTINGS_BYTES = 16 * 1024;

function colorTag(value: string | null | undefined) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !value || value.length > MAX_COLOR_TAG || /[\r\n]/.test(value))
    throw new StoreError(
      'invalid',
      `colorTag is a one-line name of 1 to ${MAX_COLOR_TAG} characters`,
    );
  return value;
}

/** `accounts.settings` holds a plain JSON object of at most 16 KB, so a window cannot be handed anything else. */
function settingsJson(value: Record<string, unknown> | undefined) {
  if (value === undefined) return undefined;
  if (!isPlain(value))
    throw new StoreError('invalid', 'Account settings must be a plain JSON object');
  const json = serialize(value);
  // What JSON silently drops or rewrites (undefined, NaN, functions, toJSON, Map) would read back as something else.
  if (!sameJson(value, JSON.parse(json)))
    throw new StoreError('invalid', 'Account settings must survive a JSON round trip unchanged');
  if (new TextEncoder().encode(json).length > MAX_SETTINGS_BYTES)
    throw new StoreError('invalid', 'Account settings are limited to 16 KB');
  return json;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === null || typeof a !== 'object') return a === b;
  if (Array.isArray(a))
    return (
      Array.isArray(b) && a.length === b.length && Array.from(a).every((v, i) => sameJson(v, b[i]))
    );
  if (!isPlain(a) || !isPlain(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => sameJson(a[k], b[k]));
}

function notificationsFlag(value: boolean | undefined) {
  if (value !== undefined && typeof value !== 'boolean')
    throw new StoreError('invalid', 'notifications is true or false');
  return value;
}

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    throw new StoreError('invalid', 'Account settings must be JSON');
  }
}

/** Writes the account row: upsert by id, status fields split into their columns. */
export function account(run: CommitRun, w: AccountWrite) {
  const now = run.now();
  const cols: Record<string, SqlValue> = {};
  const set = (col: string, value: SqlValue | boolean | undefined) => {
    if (value !== undefined) cols[col] = typeof value === 'boolean' ? Number(value) : value;
  };
  set('provider', w.provider);
  set('address', w.address);
  set('display_name', w.displayName);
  if (w.capabilities !== undefined) set('capabilities', JSON.stringify(w.capabilities));
  if (w.grantedScopes !== undefined)
    set('granted_scopes', w.grantedScopes === null ? null : JSON.stringify(w.grantedScopes));
  if (w.status) {
    const { state, ...rest } = w.status as { state: string; reason?: string; until?: number };
    const { reason, until, ...detail } = rest;
    set('status', state);
    set('status_reason', reason ?? null);
    set('resume_at', state === 'paused' ? (until ?? null) : null);
    set('status_detail', Object.keys(detail).length ? JSON.stringify(detail) : null);
  }
  set('status_reason_code', w.reasonCode);
  set('baseline_done_at', w.baselineDoneAt);
  set('token_granted_at', w.tokenGrantedAt);
  set('refresh_expires_at', w.refreshExpiresAt);
  set('remote_subject', w.remoteSubject);
  set('oauth_client', w.oauthClient);
  set('ai_allowed', w.aiAllowed);
  set('primary_lease_until', w.primaryLeaseUntil);
  set('primary_lease_device', w.primaryLeaseDevice);
  set('color_tag', colorTag(w.colorTag));
  set('notifications', notificationsFlag(w.notifications));
  set('settings', settingsJson(w.settings));
  const exists = run.q('SELECT 1 FROM accounts WHERE id = ?').get(w.id);
  if (exists) {
    const keys = Object.keys(cols);
    // First list wins: a repeat stamp (nothing else to write) is a no-op, no updated_at bump and no change row.
    const first =
      w.calendarListedAt !== undefined &&
      run
        .q('UPDATE accounts SET calendar_listed_at = ? WHERE id = ? AND calendar_listed_at IS NULL')
        .run(w.calendarListedAt, w.id).changes > 0;
    if (!keys.length && w.calendarListedAt !== undefined && !first) return;
    run
      .q(
        `UPDATE accounts SET ${keys.map(k => `${k} = ?`).join(', ')}${keys.length ? ', ' : ''}updated_at = ? WHERE id = ?`,
      )
      .run(...keys.map(k => cols[k]), now, w.id);
  } else {
    if (!w.provider || !w.address || !w.capabilities)
      throw new StoreError('invalid', 'A new account needs provider, address and capabilities');
    cols.status ??= 'starting';
    if (w.calendarListedAt !== undefined) cols.calendar_listed_at = w.calendarListedAt;
    const keys = Object.keys(cols);
    run
      .q(
        `INSERT INTO accounts(id, ${keys.join(', ')}, created_at, updated_at) VALUES(?, ${keys.map(() => '?').join(', ')}, ?, ?)`,
      )
      .run(w.id, ...keys.map(k => cols[k]), now, now);
  }
  run.mark('Account', w.id, null, 'u');
}

export function folder(run: CommitRun, w: FolderWrite) {
  const before = run
    .q('SELECT id, role, uidvalidity FROM folders WHERE account_id = ? AND remote_id = ?')
    .get<{ id: number; role: string | null; uidvalidity: number | null }>(w.accountId, w.remoteId);
  // A new UIDVALIDITY voids every UID stored for the folder (FR-31): the resync re-stamps them, and an old UID left in
  // place would collide with a relisted message's new one on `mf_uid` and fail every page of the reset. An absent
  // `uidValidity` keeps the stored value (R2G-1): a LIST without STATUS must not reset the guard to "first validity".
  // An explicit null clears it, and the UIDs go with it: they belong to a validity nobody knows any more, so they could
  // not be voided when the next real one arrives (freeze round 3).
  if (
    before?.uidvalidity != null &&
    w.uidValidity !== undefined &&
    before.uidvalidity !== w.uidValidity
  )
    run.q('UPDATE message_folders SET uid = NULL WHERE folder_id = ?').run(before.id);
  run
    .q(
      `INSERT INTO folders(account_id, remote_id, name, role, kind, sync_scope, uidvalidity, hidden) VALUES(?, ?, ?, ?, ?, COALESCE(?, 'lazy'), ?, ?)
    ON CONFLICT(account_id, remote_id) DO UPDATE SET name = excluded.name, role = excluded.role, kind = excluded.kind,
      sync_scope = COALESCE(?, sync_scope), uidvalidity = IIF(?, excluded.uidvalidity, uidvalidity), hidden = excluded.hidden`,
    )
    .run(
      w.accountId,
      w.remoteId,
      w.name,
      w.role ?? null,
      w.folderKind,
      w.syncScope ?? null,
      w.uidValidity ?? null,
      Number(w.hidden ?? false),
      w.syncScope ?? null,
      Number(w.uidValidity !== undefined),
    );
  // A role change (a label becoming Trash) changes which threads the folder lists.
  if (before && before.role !== (w.role ?? null)) touchFolderThreads(run, before.id);
  run.mark('Folder', w.accountId, w.remoteId, 'u');
}

export function folderDelete(run: CommitRun, w: FolderDeleteWrite) {
  const row = run.q('SELECT id FROM folders WHERE account_id = ? AND remote_id = ?').get<{
    id: number;
  }>(w.accountId, w.remoteId);
  if (!row) return;
  touchFolderThreads(run, row.id);
  // The cascade drops the placements, which changes each placed message's labels (FR-15).
  for (const m of run
    .q(
      'SELECT m.id, m.remote_id FROM message_folders mf JOIN messages m ON m.id = mf.message_id WHERE mf.folder_id = ?',
    )
    .all<{ id: number; remote_id: string }>(row.id)) {
    run.q('UPDATE messages SET rev = ? WHERE id = ?').run(run.seq, m.id);
    run.mark('Message', w.accountId, m.remote_id, 'u');
  }
  run.q('DELETE FROM folders WHERE id = ?').run(row.id);
  run.mark('Folder', w.accountId, w.remoteId, 'd');
}

export function touchFolderThreads(run: CommitRun, folderId: number) {
  for (const r of run
    .q(
      'SELECT DISTINCT m.thread_id AS t FROM message_folders mf JOIN messages m ON m.id = mf.message_id WHERE mf.folder_id = ?',
    )
    .all<{ t: number }>(folderId))
    run.touched.add(r.t);
}

/** A folder named in a message before the folder list arrived gets a placeholder row the next list fills in. */
export function folderId(run: CommitRun, accountId: string, remoteId: string): number {
  const row = run.q('SELECT id FROM folders WHERE account_id = ? AND remote_id = ?').get<{
    id: number;
  }>(accountId, remoteId);
  if (row) return row.id;
  const id = run
    .q(
      "INSERT INTO folders(account_id, remote_id, name, kind) VALUES(?, ?, ?, 'unknown') RETURNING id",
    )
    .get<{ id: number }>(accountId, remoteId, remoteId)!.id;
  run.mark('Folder', accountId, remoteId, 'u');
  return id;
}
