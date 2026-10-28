import test from 'node:test';
import assert from 'node:assert/strict';
import type { StorePort } from '../../src/store';
import { ACCOUNT, accountWrite, msg, withStore } from './helpers';

const imapFolder = (uidValidity: number) =>
  ({
    kind: 'folder',
    accountId: ACCOUNT,
    remoteId: 'INBOX',
    name: 'Inbox',
    role: 'inbox',
    folderKind: 'folder',
    uidValidity,
  }) as const;
const uids = (store: StorePort) =>
  store.read(q =>
    q
      .all(
        `SELECT m.remote_id AS id, mf.uid FROM message_folders mf JOIN messages m ON m.id = mf.message_id ORDER BY m.remote_id`,
      )
      .map(r => ({ ...r })),
  );

test('a UIDVALIDITY change clears the folder UIDs, so the resync can reuse them (FR-31)', () => {
  withStore(store => {
    store.commit({
      opId: 'list',
      origin: 'sync',
      writes: [
        accountWrite,
        imapFolder(1),
        msg('a', 'ta', 0, { folders: [{ folder: 'INBOX', uid: 1 }] }),
        msg('b', 'tb', 1, { folders: [{ folder: 'INBOX', uid: 2 }] }),
      ],
    });
    // Same validity: nothing changes.
    store.commit({ opId: 'relist', origin: 'sync', writes: [imapFolder(1)] });
    assert.deepEqual(uids(store), [
      { id: 'a', uid: 1 },
      { id: 'b', uid: 2 },
    ]);
    // New validity, then the first resync page gives `b` UID 1 while `a` is not relisted yet.
    store.commit({
      opId: 'reset',
      origin: 'sync',
      step: 'resync',
      writes: [
        imapFolder(7),
        {
          kind: 'placements',
          accountId: ACCOUNT,
          target: { remoteId: 'b' },
          add: [{ folder: 'INBOX', uid: 1 }],
          remove: [],
        },
      ],
    });
    assert.deepEqual(uids(store), [
      { id: 'a', uid: null },
      { id: 'b', uid: 1 },
    ]);
    // A later page in its own commit reaches `a` without colliding either.
    store.commit({
      opId: 'reset-2',
      origin: 'sync',
      step: 'resync',
      writes: [msg('a', 'ta', 0, { folders: [{ folder: 'INBOX', uid: 2 }] })],
    });
    assert.deepEqual(uids(store), [
      { id: 'a', uid: 2 },
      { id: 'b', uid: 1 },
    ]);
  });
});

test('a first UIDVALIDITY after an absent one keeps the stored UIDs', () => {
  withStore(store => {
    store.commit({
      opId: 'list',
      origin: 'sync',
      writes: [
        accountWrite,
        { ...imapFolder(1), uidValidity: undefined },
        msg('a', 'ta', 0, { folders: [{ folder: 'INBOX', uid: 1 }] }),
      ],
    });
    // The folder list arriving with its first validity must not throw away UIDs stamped before it.
    store.commit({ opId: 'first-validity', origin: 'sync', writes: [imapFolder(3)] });
    assert.deepEqual(uids(store), [{ id: 'a', uid: 1 }]);
  });
});

test('a folder write without uidValidity keeps the stored one, so a later real change still clears the UIDs (R2G-1)', () => {
  withStore(store => {
    store.commit({
      opId: 'list',
      origin: 'sync',
      writes: [
        accountWrite,
        imapFolder(1),
        msg('a', 'ta', 0, { folders: [{ folder: 'INBOX', uid: 1 }] }),
        msg('b', 'tb', 1, { folders: [{ folder: 'INBOX', uid: 2 }] }),
      ],
    });
    // A folder list from LIST without STATUS: no validity at all.
    store.commit({
      opId: 'list-no-status',
      origin: 'sync',
      writes: [{ ...imapFolder(1), uidValidity: undefined }],
    });
    const stored = () =>
      store.read(q => q.get<{ v: number | null }>('SELECT uidvalidity AS v FROM folders')?.v);
    assert.equal(stored(), 1, 'absent keeps the stored value');
    // UIDVALIDITY really changes, and the first resync page gives `b` UID 1: no collision with `a`'s stale UID 1.
    store.commit({
      opId: 'reset',
      origin: 'sync',
      step: 'resync',
      writes: [
        imapFolder(7),
        {
          kind: 'placements',
          accountId: ACCOUNT,
          target: { remoteId: 'b' },
          add: [{ folder: 'INBOX', uid: 1 }],
          remove: [],
        },
      ],
    });
    assert.deepEqual(uids(store), [
      { id: 'a', uid: null },
      { id: 'b', uid: 1 },
    ]);
    // An explicit null still clears the stored value.
    store.commit({
      opId: 'clear',
      origin: 'sync',
      writes: [{ ...imapFolder(7), uidValidity: null }],
    });
    assert.equal(stored(), null);
  });
});

// Freeze round 3: an explicit null clears the validity and the UIDs with it, so the next real UIDVALIDITY cannot collide.
test('an explicit null uidValidity clears the UIDs too, so the next real validity resyncs cleanly', () => {
  withStore(store => {
    store.commit({
      opId: 'list',
      origin: 'sync',
      writes: [
        accountWrite,
        imapFolder(1),
        msg('a', 'ta', 0, { folders: [{ folder: 'INBOX', uid: 1 }] }),
        msg('b', 'tb', 1, { folders: [{ folder: 'INBOX', uid: 2 }] }),
      ],
    });
    store.commit({
      opId: 'clear',
      origin: 'sync',
      writes: [{ ...imapFolder(1), uidValidity: null }],
    });
    assert.deepEqual(uids(store), [
      { id: 'a', uid: null },
      { id: 'b', uid: null },
    ]);
    store.commit({
      opId: 'reset',
      origin: 'sync',
      step: 'resync',
      writes: [
        imapFolder(9),
        {
          kind: 'placements',
          accountId: ACCOUNT,
          target: { remoteId: 'b' },
          add: [{ folder: 'INBOX', uid: 1 }],
          remove: [],
        },
      ],
    });
    assert.deepEqual(uids(store), [
      { id: 'a', uid: null },
      { id: 'b', uid: 1 },
    ]);
  });
});
