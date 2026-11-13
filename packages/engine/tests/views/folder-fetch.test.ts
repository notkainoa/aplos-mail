import test from 'node:test';
import assert from 'node:assert/strict';
import type { ViewSpec } from '@aplos/contract';
import type { AccountId } from '../../src/ports';
import type { EngineServices } from '../../src/runtime/services';
import type { FolderRole, FolderWrite, StorePort } from '../../src/store';
import { openStore } from '../../src/store';
import { ensureFolders, folderTargets } from '../../src/views/folder-fetch';
import { ACCOUNT, accountWrite, folderWrites, tempDb, withStore } from '../store/helpers';

/*
 * `View/watch` and `View/query` on a `label` or `mailbox` spec fetch the folders the spec lists before the view
 * opens (`sync_scope = 'lazy'`, F3). The targets are resolved from `folders`: Spam, Trash, Sent, Starred and
 * Important role folders, plus any stored folder a label view names — never Inbox, which live sync owns, and
 * never a spec kind with no folder.
 */

const FOLDER = (
  remoteId: string,
  name: string,
  role?: FolderRole,
  kind: FolderWrite['folderKind'] = 'system',
): FolderWrite => ({
  kind: 'folder',
  accountId: ACCOUNT,
  remoteId,
  name,
  ...(role ? { role } : {}),
  folderKind: kind,
});

const base = (store: StorePort, extra: Parameters<StorePort['commit']>[0]['writes'] = []) =>
  store.commit({
    opId: 'setup',
    origin: 'sync',
    writes: [accountWrite, ...folderWrites, ...extra],
  });

function rig(store: StorePort) {
  const calls: [AccountId, string][] = [];
  const services = {
    store,
    accounts: {
      listFolder: async (account: AccountId, remoteId: string) => {
        calls.push([account, remoteId]);
      },
    },
  } as unknown as EngineServices;
  return { calls, services };
}

test('mailbox specs resolve their role folders; inbox, all and archive resolve none', () => {
  withStore(store => {
    // The helper's folderWrites already store INBOX (role inbox) and TRASH (role trash).
    base(store, [
      FOLDER('SPAM', 'Spam', 'spam'),
      FOLDER('STARRED', 'Starred', 'starred'),
      FOLDER('SENT', 'Sent', 'sent'),
    ]);
    for (const role of ['spam', 'trash', 'starred', 'sent', 'important'] as const) {
      const targets = folderTargets({ store }, { kind: 'mailbox', role });
      assert.deepEqual(
        targets,
        role === 'spam'
          ? [{ accountId: ACCOUNT, remoteId: 'SPAM' }]
          : role === 'trash'
            ? [{ accountId: ACCOUNT, remoteId: 'TRASH' }]
            : role === 'starred'
              ? [{ accountId: ACCOUNT, remoteId: 'STARRED' }]
              : role === 'sent'
                ? [{ accountId: ACCOUNT, remoteId: 'SENT' }]
                : [],
        role,
      );
    }
    for (const role of ['inbox', 'all', 'archive'] as const)
      assert.deepEqual(folderTargets({ store }, { kind: 'mailbox', role }), [], role);
  });
});

test('label specs resolve their stored folder, never the Inbox row or a missing folder', () => {
  withStore(store => {
    base(store);
    assert.deepEqual(folderTargets({ store }, { kind: 'label', folderId: `${ACCOUNT}:Label_1` }), [
      { accountId: ACCOUNT, remoteId: 'Label_1' },
    ]);
    assert.deepEqual(folderTargets({ store }, { kind: 'label', folderId: `${ACCOUNT}:INBOX` }), []);
    assert.deepEqual(
      folderTargets({ store }, { kind: 'label', folderId: `${ACCOUNT}:MISSING` }),
      [],
    );
    assert.deepEqual(folderTargets({ store }, { kind: 'label', folderId: 'other:Label_1' }), []);
  });
});

test('ensureFolders calls listFolder once per resolved folder and swallows a provider failure', async () => {
  // `withStore` is sync-only, so this async test opens its own.
  const file = tempDb();
  const store = openStore(file.open());
  try {
    base(store, [FOLDER('SPAM', 'Spam', 'spam')]);
    const { calls, services } = rig(store);
    await ensureFolders(services, { kind: 'mailbox', role: 'spam' });
    assert.deepEqual(calls, [[ACCOUNT, 'SPAM']]);
    // A spec kind with no folder resolves nothing.
    await ensureFolders(services, { kind: 'drafts' } as ViewSpec);
    assert.equal(calls.length, 1);
    // A provider that throws does not keep the view from opening.
    services.accounts.listFolder = async () => {
      throw new Error('offline');
    };
    await ensureFolders(services, { kind: 'mailbox', role: 'trash' });
  } finally {
    store.close();
    file.cleanup();
  }
});
