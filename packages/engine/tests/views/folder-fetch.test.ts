import test from 'node:test';
import assert from 'node:assert/strict';
import type { ViewSpec } from '@aplos/contract';
import type { AccountId } from '../../src/ports';
import type { EngineServices } from '../../src/runtime/services';
import type { FolderRole, FolderWrite, StorePort } from '../../src/store';
import { openStore } from '../../src/store';
import { COLD_OPEN_MS, ensureFolders, folderTargets } from '../../src/views/folder-fetch';
import { FakeClock } from '../../../emulators/src/kit/clock';
import { ACCOUNT, accountWrite, folderWrites, msg, tempDb, withStore } from '../store/helpers';

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
  const clock = new FakeClock({ auto: false });
  const services = {
    store,
    clock,
    accounts: {
      listFolder: async (account: AccountId, remoteId: string) => {
        calls.push([account, remoteId]);
      },
    },
  } as unknown as EngineServices;
  return { calls, clock, services };
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
      const expect = (remoteId: string) => [{ accountId: ACCOUNT, remoteId, warm: false }];
      assert.deepEqual(
        targets,
        role === 'spam'
          ? expect('SPAM')
          : role === 'trash'
            ? expect('TRASH')
            : role === 'starred'
              ? expect('STARRED')
              : role === 'sent'
                ? expect('SENT')
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
      { accountId: ACCOUNT, remoteId: 'Label_1', warm: false },
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

test('a folder whose sync scope is not lazy is never a target', () => {
  withStore(store => {
    base(store, [
      { ...FOLDER('TRASH', 'Trash', 'trash'), syncScope: 'live' as const },
      FOLDER('SPAM', 'Spam', 'spam'),
    ]);
    // `live` scope means the sync plan owns it — the open must not double-list (Opus mutation check).
    assert.deepEqual(folderTargets({ store }, { kind: 'mailbox', role: 'trash' }), []);
    assert.deepEqual(folderTargets({ store }, { kind: 'label', folderId: `${ACCOUNT}:TRASH` }), []);
  });
});

test('a folder with stored rows opens without waiting; an empty one waits for the fetch', async () => {
  const file = tempDb();
  const store = openStore(file.open());
  try {
    // TRASH already holds a message; SPAM is stored but empty.
    base(store, [
      msg('tr-1', 't-1', 0, { folders: [{ folder: 'TRASH' }] }),
      FOLDER('SPAM', 'Spam', 'spam'),
    ]);
    const calls: [AccountId, string][] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const clock = new FakeClock({ auto: false });
    const services = {
      store,
      clock,
      accounts: {
        listFolder: async (account: AccountId, remoteId: string) => {
          calls.push([account, remoteId]);
          return gate;
        },
      },
    } as unknown as EngineServices;

    // Stored rows: the open returns while the fetch is still in flight.
    const warm = ensureFolders(services, { kind: 'mailbox', role: 'trash' });
    await Promise.race([warm, gate.then(() => 'late')]);
    assert.deepEqual(calls, [[ACCOUNT, 'TRASH']]);
    let settled = false;
    void warm.then(() => (settled = true));
    await Promise.resolve();
    assert.ok(settled, 'a warm folder opens without waiting for the fetch');

    // No stored rows: the open waits until the fetch settles, so it cannot flash "empty" first.
    settled = false;
    const cold = ensureFolders(services, { kind: 'mailbox', role: 'spam' }).then(
      () => (settled = true),
    );
    await new Promise(r => setTimeout(r, 10));
    assert.equal(settled, false, 'a cold folder waits for the fetch');
    release();
    await cold;
    assert.deepEqual(calls, [
      [ACCOUNT, 'TRASH'],
      [ACCOUNT, 'SPAM'],
    ]);
  } finally {
    store.close();
    file.cleanup();
  }
});

test('a stalled cold fetch releases the open at COLD_OPEN_MS on the engine clock', async () => {
  const file = tempDb();
  const store = openStore(file.open());
  try {
    base(store, [FOLDER('SPAM', 'Spam', 'spam')]);
    const clock = new FakeClock({ auto: false });
    const services = {
      store,
      clock,
      accounts: {
        // A fetch that never settles: half-open socket, captive portal, a governor hold — the open cannot wait on it.
        listFolder: () => new Promise<void>(() => {}),
      },
    } as unknown as EngineServices;
    let settled = false;
    const open = ensureFolders(services, { kind: 'mailbox', role: 'spam' }).then(
      () => (settled = true),
    );
    await clock.advance(COLD_OPEN_MS - 1);
    assert.equal(settled, false, 'still waiting one tick under the bound');
    await clock.advance(1);
    assert.ok(settled, 'the bound released the open while the fetch still runs');
    await open;
  } finally {
    store.close();
    file.cleanup();
  }
});

test('a folder fetched before opens warm on the next open, even with zero rows (Starred, an empty Spam)', async () => {
  const file = tempDb();
  const store = openStore(file.open());
  try {
    base(store, [FOLDER('STARRED', 'Starred', 'starred')]);
    // The first fetch stamped the throttle row; STARRED is a flag label, so message_folders never gets rows for it.
    store.commit({
      opId: 'walked',
      origin: 'sync',
      writes: [{ kind: 'syncState', accountId: ACCOUNT, scope: 'folder:STARRED', generation: 0 }],
    });
    assert.equal(
      folderTargets({ store } as EngineServices, { kind: 'mailbox', role: 'starred' })[0]?.warm,
      true,
      'a stamped folder counts as warm without stored rows',
    );
    const clock = new FakeClock({ auto: false });
    const services = {
      store,
      clock,
      accounts: { listFolder: () => new Promise<void>(() => {}) },
    } as unknown as EngineServices;
    let settled = false;
    const open = ensureFolders(services, { kind: 'mailbox', role: 'starred' }).then(
      () => (settled = true),
    );
    await Promise.resolve();
    assert.ok(settled, 'the second open does not wait on a hanging fetch');
    await open;
  } finally {
    store.close();
    file.cleanup();
  }
});
