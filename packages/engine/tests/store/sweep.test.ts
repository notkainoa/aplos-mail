import test from 'node:test';
import assert from 'node:assert/strict';
import type { CommitInput, StorePort, SweepWrite } from '../../src/store';
import { ACCOUNT, T0, accountWrite, folderWrites, msg, withStore } from './helpers';

// The bounded generation sweep (Providers F3 review, blocker 2 and should-fixes 9, 11; nit 14).

const setup = (store: StorePort) =>
  store.commit({ opId: 'setup', origin: 'sync', writes: [accountWrite, ...folderWrites] });
const inFolder = (store: StorePort, folder: string) =>
  store.read(q =>
    q
      .all(
        `SELECT m.remote_id AS id FROM message_folders mf
  JOIN messages m ON m.id = mf.message_id JOIN folders f ON f.id = mf.folder_id WHERE f.remote_id = ? ORDER BY m.remote_id`,
        folder,
      )
      .map(r => r.id),
  );
const listed = (store: StorePort, folder: string) =>
  store.read(q =>
    q
      .all(
        `SELECT t.remote_id AS id FROM thread_folders tf
  JOIN threads t ON t.id = tf.thread_id JOIN folders f ON f.id = tf.folder_id WHERE f.remote_id = ? ORDER BY t.remote_id`,
        folder,
      )
      .map(r => r.id),
  );
const at = (minutes: number) => T0 + minutes * 60_000;

/** One step of a round: stamped messages, its sync state, and the sweep when the step covered the scope. */
function step(
  store: StorePort,
  opId: string,
  scope: string,
  generation: number,
  ids: [string, number][],
  sweep?: Omit<SweepWrite, 'kind' | 'accountId' | 'generation'>,
): void {
  const input: CommitInput = {
    opId,
    origin: 'sync',
    step: 'backfill',
    writes: [
      ...ids.map(([id, minutes]) => msg(id, `t-${id}`, minutes, { seenGen: generation })),
      { kind: 'syncState', accountId: ACCOUNT, scope, generation },
      ...(sweep ? [{ kind: 'sweep', accountId: ACCOUNT, generation, ...sweep } as SweepWrite] : []),
    ],
  };
  store.commit(input);
}

test('a backfill round that covers its range keeps the first window in Inbox (review blocker 2)', () => {
  withStore(store => {
    setup(store);
    // An earlier round (before the first window) stamped two old messages; one of them has since left Inbox at Gmail.
    const old = store.seq();
    step(store, 'old', 'backfill:inbox', old, [
      ['old-kept', 5],
      ['old-gone', 7],
    ]);
    // First sync: the window round draws its generation from the store's seq, like every scope.
    const window = store.seq();
    step(store, 'window-1', 'window:inbox', window, [
      ['w1', 50],
      ['w2', 49],
      ['w3', 48],
    ]);
    // History adds a message mid-round without a stamp (NULL keeps).
    store.commit({
      opId: 'history-1',
      origin: 'sync',
      step: 'incremental',
      writes: [msg('h1', 't-h1', 6)],
    });

    const backfill = store.seq();
    assert.ok(
      backfill > window && window > old,
      'one monotonic source: a later round of any scope is higher',
    );
    // The backfill page lists 4..10 minutes (oldest and newest on the page) and covers that range.
    step(
      store,
      'backfill-1',
      'backfill:inbox',
      backfill,
      [
        ['old-kept', 5],
        ['b1', 9],
      ],
      { folder: 'INBOX', since: at(4), until: at(10) },
    );

    assert.deepEqual(
      inFolder(store, 'INBOX'),
      ['b1', 'h1', 'old-kept', 'w1', 'w2', 'w3'],
      'only the unlisted, stamped message inside the bound left Inbox',
    );
    assert.deepEqual(listed(store, 'INBOX'), [
      't-b1',
      't-h1',
      't-old-kept',
      't-w1',
      't-w2',
      't-w3',
    ]);
    assert.equal(
      store.read(q => q.get("SELECT count(*) AS n FROM messages WHERE remote_id = 'old-gone'"))!.n,
      1,
      'the message is kept; only its placement goes',
    );

    // Without `until`, the same sweep is the reported failure: every newer Inbox placement stamped before the round goes.
    step(store, 'unbounded', 'backfill:inbox', store.seq(), [['b1', 9]], {
      folder: 'INBOX',
      since: at(4),
    });
    assert.deepEqual(
      inFolder(store, 'INBOX'),
      ['b1', 'h1'],
      'what an unbounded sweep does, which is why the bound needs `until`',
    );
  });
});

test('a sweep commits with its step: a failing write leaves every placement in place', () => {
  withStore(store => {
    setup(store);
    step(store, 'window-1', 'window:inbox', store.seq(), [
      ['w1', 50],
      ['w2', 49],
    ]);
    const before = store.seq();
    assert.throws(() =>
      store.commit({
        opId: 'resync-1',
        origin: 'sync',
        step: 'resync',
        writes: [
          msg('w1', 't-w1', 50, { seenGen: before }),
          { kind: 'sweep', accountId: ACCOUNT, folder: 'INBOX', generation: before },
          {
            kind: 'syncState',
            accountId: ACCOUNT,
            scope: 'window:inbox',
            generation: before,
            pending: Array.from({ length: 501 }, (_, i) => `p${i}`),
          },
        ],
      }),
    );
    assert.deepEqual(inFolder(store, 'INBOX'), ['w1', 'w2']);
    assert.equal(store.seq(), before);
  });
});

test('a stamp only rises, so a late page of an older round cannot expose a placement to a newer sweep', () => {
  withStore(store => {
    setup(store);
    const older = store.seq();
    step(store, 'a-1', 'window:inbox', older, [['x', 20]]);
    const newer = store.seq();
    step(store, 'b-1', 'backfill:inbox', newer, [['m', 10]]);
    // The older round's next page lists m again after the newer round stamped it.
    step(store, 'a-2', 'window:inbox', older, [['m', 10]]);
    step(store, 'b-2', 'backfill:inbox', newer, [], {
      folder: 'INBOX',
      since: at(5),
      until: at(15),
    });
    assert.deepEqual(inFolder(store, 'INBOX'), ['m', 'x']);
  });
});

test('uid bounds, other folders and fenced messages limit the sweep', () => {
  withStore(store => {
    setup(store);
    const gen = store.seq();
    store.commit({
      opId: 'imap-1',
      origin: 'sync',
      step: 'backfill',
      writes: [
        msg('u1', 't1', 1, {
          folders: [{ folder: 'INBOX', uid: 1 }, { folder: 'Label_1' }],
          seenGen: gen,
        }),
        msg('u2', 't2', 2, { folders: [{ folder: 'INBOX', uid: 2 }], seenGen: gen }),
        msg('u9', 't9', 3, { folders: [{ folder: 'INBOX', uid: 9 }], seenGen: gen }),
      ],
    });
    const fence = store.seq();
    store.commit({
      opId: 'local-1',
      origin: 'local',
      writes: [{ kind: 'flags', accountId: ACCOUNT, target: { remoteId: 'u2' }, seen: true }],
    });
    store.commit({
      opId: 'imap-2',
      origin: 'sync',
      step: 'resync',
      fenceSeq: fence,
      writes: [
        {
          kind: 'sweep',
          accountId: ACCOUNT,
          folder: 'INBOX',
          generation: store.seq(),
          uidFrom: 1,
          uidTo: 5,
        },
      ],
    });
    assert.deepEqual(
      inFolder(store, 'INBOX'),
      ['u2', 'u9'],
      'u1 swept; u2 fenced by a local edit; u9 outside the UID range',
    );
    assert.deepEqual(inFolder(store, 'Label_1'), ['u1'], 'a sweep touches its folder only');
  });
});

test('per-folder placements, Gmail tab roles and the server thread size are stored (should-fixes 9, 11; nit 14)', () => {
  withStore(store => {
    setup(store);
    store.commit({
      opId: 'tabs',
      origin: 'sync',
      writes: [
        {
          kind: 'folder',
          accountId: ACCOUNT,
          remoteId: 'CATEGORY_PROMOTIONS',
          name: 'Promotions',
          role: 'category.promotions',
          folderKind: 'system',
        },
        msg('p1', 'tp', 1, { folders: [{ folder: 'INBOX' }, { folder: 'Label_1' }] }),
      ],
    });
    assert.equal(
      store.read(q => q.get("SELECT role FROM folders WHERE remote_id = 'CATEGORY_PROMOTIONS'"))!
        .role,
      'category.promotions',
    );
    // A per-folder step (placementsComplete: false) omits `folders` and adds the one placement it saw.
    const { folders: _, ...partial } = msg('p1', 'tp', 1);
    store.commit({
      opId: 'per-folder',
      origin: 'sync',
      writes: [
        partial,
        {
          kind: 'placements',
          accountId: ACCOUNT,
          target: { remoteId: 'p1' },
          add: [{ folder: 'CATEGORY_PROMOTIONS' }],
          remove: [],
        },
      ],
    });
    assert.deepEqual(
      store.read(q =>
        q
          .all(
            `SELECT f.remote_id AS f FROM message_folders mf JOIN folders f ON f.id = mf.folder_id ORDER BY f.remote_id`,
          )
          .map(r => r.f),
      ),
      ['CATEGORY_PROMOTIONS', 'INBOX', 'Label_1'],
    );
    store.commit({
      opId: 'size',
      origin: 'sync',
      writes: [{ kind: 'thread', accountId: ACCOUNT, remoteThreadId: 'tp', remoteCount: 5 }],
    });
    assert.deepEqual(
      {
        ...store.read(q =>
          q.get("SELECT msg_count, remote_count FROM threads WHERE remote_id = 'tp'"),
        )!,
      },
      { msg_count: 1, remote_count: 5 },
    );
  });
});
