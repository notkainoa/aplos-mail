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

/** The remote folder ids the spec's listing reads, per account. */
export function folderTargets(
  services: Pick<EngineServices, 'store'>,
  spec: ViewSpec,
): { accountId: AccountId; remoteId: string }[] {
  return services.store.read(q => {
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
      return [parts];
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
      return rows.map(r => ({ accountId: r.account_id, remoteId: r.remote_id }));
    }
    return [];
  });
}

/**
 * The most a view's open waits on a folder fetch; the fetch still lands afterwards and the live window picks it
 * up, so a slow provider shows a quiet loading line instead of holding the open hostage.
 */
export const FOLDER_OPEN_WAIT_MS = 2_500;

/** Lists each folder the spec needs that the provider can list; an account without the port method is skipped. */
export async function ensureFolders(services: EngineServices, spec: ViewSpec): Promise<void> {
  if (spec.kind !== 'label' && spec.kind !== 'mailbox') return;
  const listFolder = services.accounts.listFolder;
  if (!listFolder) return;
  const wait = new Promise<void>(done => setTimeout(done, FOLDER_OPEN_WAIT_MS));
  await Promise.all(
    folderTargets(services, spec).map(target =>
      Promise.race([
        listFolder.call(services.accounts, target.accountId, target.remoteId),
        wait,
      ]).catch(() => {}),
    ),
  );
}
