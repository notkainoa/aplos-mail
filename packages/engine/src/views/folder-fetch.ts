import type { ViewSpec } from '@aplos/contract';
import type { AccountId } from '../ports/base';
import type { EngineServices } from '../runtime/services';
import { splitId } from './compile';

/*
 * `sync_scope = 'lazy'` folders (F3): nothing prefetches them, so `View/watch` and `View/query` on a label or a
 * mailbox role fetch one page through `ProviderPort.listFolder` before the view opens — Spam, Trash and the
 * starred list show real contents instead of claiming empty, and the live window picks up what lands. Reached
 * only through `import()` in `methods/view.ts`, so the folder policy never loads for views that cannot need it.
 */

/** Mailbox roles a lazy open lists. `inbox` is the live window's job, `all`/`archive` have no remote folder. */
const FETCH_ROLES = new Set(['sent', 'trash', 'spam', 'starred', 'important']);

/** A resolved target: the remote folder id per account, and whether the store already holds rows for it. */
export type FolderTarget = { accountId: AccountId; remoteId: string; hasRows: boolean };

/** The remote folder ids the spec's listing reads, per account, with a stored-rows flag for the open policy. */
export function folderTargets(
  services: Pick<EngineServices, 'store'>,
  spec: ViewSpec,
): FolderTarget[] {
  return services.store.read(q => {
    const mark = (rows: { account_id: string; remote_id: string }[]): FolderTarget[] =>
      rows.map(r => ({
        accountId: r.account_id,
        remoteId: r.remote_id,
        hasRows: !!q.get<{ n: number }>(
          `SELECT EXISTS(SELECT 1 FROM message_folders mf JOIN folders f ON f.id = mf.folder_id
             WHERE f.account_id = ? AND f.remote_id = ?) AS n`,
          r.account_id,
          r.remote_id,
        )?.n,
      }));
    if (spec.kind === 'label') {
      const parts = splitId(q, spec.folderId);
      if (!parts) return [];
      const row = q.get<{ role: string | null; sync_scope: string }>(
        'SELECT role, sync_scope FROM folders WHERE account_id = ? AND remote_id = ?',
        parts.accountId,
        parts.remoteId,
      );
      // Only a stored folder can hold the placements, and only `lazy` folders wait for this open; Inbox's own row
      // stays live. `live`/`backfill` folders are the sync plan's job — re-listing them on every open pays a call
      // for placements the plan already owns.
      if (!row || row.sync_scope !== 'lazy' || row.role === 'inbox') return [];
      return mark([{ account_id: parts.accountId, remote_id: parts.remoteId }]);
    }
    if (spec.kind === 'mailbox' && FETCH_ROLES.has(spec.role)) {
      const rows = spec.accountId
        ? q.all<{ account_id: string; remote_id: string }>(
            `SELECT account_id, remote_id FROM folders WHERE account_id = ? AND role = ? AND sync_scope = 'lazy'`,
            spec.accountId,
            spec.role,
          )
        : q.all<{ account_id: string; remote_id: string }>(
            `SELECT account_id, remote_id FROM folders WHERE role = ? AND sync_scope = 'lazy'`,
            spec.role,
          );
      return mark(rows);
    }
    return [];
  });
}

/**
 * Lists each folder the spec needs that the provider can list; an account without the port method is skipped. A
 * folder whose rows are already stored opens immediately and refetches in the background — no open waits on the
 * network for data the screen can already show. A folder with no stored rows waits for the fetch to settle, so a
 * first open can only ever show real contents or a real empty, never the flash of one before the page lands.
 */
export async function ensureFolders(services: EngineServices, spec: ViewSpec): Promise<void> {
  if (spec.kind !== 'label' && spec.kind !== 'mailbox') return;
  const listFolder = services.accounts.listFolder;
  if (!listFolder) return;
  const cold: Promise<unknown>[] = [];
  for (const target of folderTargets(services, spec)) {
    const run = listFolder
      .call(services.accounts, target.accountId, target.remoteId)
      .catch(() => {});
    if (!target.hasRows) cold.push(run);
  }
  await Promise.all(cold);
}
