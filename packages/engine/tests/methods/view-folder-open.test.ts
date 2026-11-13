import test from 'node:test';
import assert from 'node:assert/strict';
import type { AccountId } from '../../src/ports';
import { handlers } from '../../src/methods/view';
import type { MethodContext } from '../../src/methods/types';
import { ACCOUNT, accountWrite, folderWrites, tempDb } from '../store/helpers';
import { openStore } from '../../src/store';

/*
 * The wiring Opus flagged as untested: `View/watch` (and `View/query`) on a `label`/`mailbox` spec must run
 * `ensureFolders` before the window opens, so a `lazy` folder's first open fetches it. Removing that call is a
 * silent regression — this guards the dispatch, not the fetch itself (sync-folder-open.test.ts).
 */

const ctx = (services: Record<string, unknown>, calls: [AccountId, string][]): MethodContext =>
  ({
    caller: { scopes: ['read'] },
    signal: new AbortController().signal,
    connectionId: 'test',
    services: {
      store: services.store,
      clock: { now: () => 0, sleep: () => new Promise<void>(() => {}) },
      accounts: {
        listFolder: async (a: AccountId, f: string) => void calls.push([a, f]),
      },
      views: {
        watch: () => ({ windowId: 'w1', ids: [], status: 'live' }),
        query: () => ({ ids: [], total: 0 }),
      },
    },
    redispatch: async () => {
      throw new Error('unused');
    },
  }) as unknown as MethodContext;

test("View/watch on a mailbox spec fetches the spec's lazy folders before opening", async () => {
  const file = tempDb();
  const store = openStore(file.open());
  try {
    store.commit({ opId: 'setup', origin: 'sync', writes: [accountWrite, ...folderWrites] });
    const calls: [AccountId, string][] = [];
    const c = ctx({ store }, calls);
    await handlers['View/watch']({ spec: { kind: 'mailbox', role: 'trash' } }, c);
    assert.deepEqual(calls, [[ACCOUNT, 'TRASH']], 'the open fetched the Trash folder');
    // A spec with no folder semantics pays nothing.
    calls.length = 0;
    await handlers['View/query']({ spec: { kind: 'drafts' } } as never, c);
    assert.deepEqual(calls, []);
  } finally {
    store.close();
    file.cleanup();
  }
});
