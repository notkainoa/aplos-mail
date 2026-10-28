import test from 'node:test';
import assert from 'node:assert/strict';
import { FLAG, StoreError, type CommitInput, type StorePort } from '../../src/store';
import { ACCOUNT, T0, accountWrite, folderWrites, msg, withStore } from './helpers';

const setup = (store: StorePort) =>
  store.commit({ opId: 'setup', origin: 'sync', writes: [accountWrite, ...folderWrites] });
const thread = (store: StorePort, remoteId: string) =>
  store.read(q =>
    q.get('SELECT * FROM threads WHERE account_id = ? AND remote_id = ?', ACCOUNT, remoteId),
  );
const lists = (store: StorePort, remoteId: string) =>
  store.read(q =>
    q
      .all(
        `SELECT f.remote_id AS folder, tf.unread FROM thread_folders tf
  JOIN folders f ON f.id = tf.folder_id JOIN threads t ON t.id = tf.thread_id WHERE t.remote_id = ? ORDER BY f.remote_id`,
        remoteId,
      )
      .map(r => ({ ...r })),
  );
const counts = (store: StorePort) =>
  store.read(q =>
    q.get(`SELECT (SELECT count(*) FROM threads) AS threads, (SELECT count(*) FROM messages) AS messages,
  (SELECT count(*) FROM changes) AS changes, (SELECT count(*) FROM thread_folders) AS lists, (SELECT count(*) FROM commits) AS commits`),
  );

test('one commit writes the rows, its rollups and change rows, and bumps seq once', () => {
  withStore(store => {
    assert.equal(setup(store).seq, 1);
    const result = store.commit({
      opId: 'page-1',
      origin: 'sync',
      step: 'baseline',
      writes: [
        msg('m1', 't1', 0, { flags: { seen: true, flagged: false, draft: false, fromMe: false } }),
        msg('m2', 't1', 5, {
          flags: { seen: false, flagged: true, draft: false, fromMe: false },
          hasAttachments: true,
        }),
        msg('m3', 't1', 9, {
          flags: { seen: true, flagged: false, draft: true, fromMe: true },
          folders: [{ folder: 'INBOX' }, { folder: 'DRAFT' }],
        }),
        {
          kind: 'workflow',
          accountId: ACCOUNT,
          remoteThreadId: 't1',
          patch: { status: 'later', laterUntil: T0 + 86_400_000, bookmarked: true },
        },
        {
          kind: 'syncState',
          accountId: ACCOUNT,
          scope: 'window:inbox',
          cursor: 'h-100',
          generation: 1,
          pending: ['m9'],
        },
      ],
    });
    assert.deepEqual(
      result,
      { seq: 2, dbEpoch: store.dbEpoch, replayed: false, changed: 6 },
      'workflow folds into the Thread row; the thread joins the Inbox list, so one Folder row',
    );
    assert.equal(store.seq(), 2);

    const t = thread(store, 't1')!;
    assert.equal(t.msg_count, 2, 'the draft is not counted (D9)');
    assert.equal(t.unread_count, 1);
    assert.equal(t.flagged, 1);
    assert.equal(t.has_attach, 1);
    assert.equal(t.first_date, T0);
    assert.equal(t.last_date, T0 + 5 * 60_000, 'last date ignores the draft');
    assert.equal(t.snippet, 'Snippet m2');
    assert.equal(t.rev, 2);
    assert.deepEqual(
      JSON.parse(String(t.participants)).map((p: { address: string }) => p.address),
      ['sender-m2@mail.example', 'sender-m1@mail.example'],
    );
    assert.deepEqual(
      lists(store, 't1'),
      [{ folder: 'INBOX', unread: 1 }],
      'the DRAFT placeholder folder lists nothing',
    );

    const wf = store.read(q =>
      q.get(
        'SELECT status, later_until, bookmarked, last_date FROM thread_workflow WHERE thread_id = ?',
        t.id,
      ),
    )!;
    assert.deepEqual(
      { ...wf },
      { status: 'later', later_until: T0 + 86_400_000, bookmarked: 1, last_date: t.last_date },
    );
    store.commit({
      opId: 'done-1',
      origin: 'local',
      writes: [
        { kind: 'workflow', accountId: ACCOUNT, remoteThreadId: 't1', patch: { status: 'done' } },
      ],
    });
    assert.equal(thread(store, 't1')!.rev, 3, 'a workflow edit moves the thread rev');
    const sync = store.read(q =>
      q.get('SELECT cursor, generation, pending FROM sync_state WHERE scope = ?', 'window:inbox'),
    )!;
    assert.deepEqual({ ...sync }, { cursor: 'h-100', generation: 1, pending: '["m9"]' });

    const ids = store.read(q =>
      q.all('SELECT id, internal_date FROM messages ORDER BY id').map(r => [r.id, r.internal_date]),
    );
    for (const [id, date] of ids)
      assert.equal(
        Math.floor(Number(id) / 4096),
        Math.floor(Number(date) / 1000),
        'date-ordered rowid',
      );

    const page = store.changesSince(1);
    assert.equal(page.status, 'ok');
    if (page.status !== 'ok') return;
    assert.deepEqual(
      page.changes.filter(c => c.seq === 2).map(c => `${c.seq} ${c.type} ${c.id} ${c.op}`),
      [
        `2 Folder ${ACCOUNT}:DRAFT u`,
        `2 Folder ${ACCOUNT}:INBOX u`,
        `2 Message ${ACCOUNT}:m1 u`,
        `2 Message ${ACCOUNT}:m2 u`,
        `2 Message ${ACCOUNT}:m3 u`,
        `2 Thread ${ACCOUNT}:t1 u`,
      ],
      'one row per changed item, all at seq 2, in (seq, type, id) order',
    );
  });
});

test('a throw inside a commit leaves nothing behind, and the same opId can then succeed', () => {
  withStore(store => {
    setup(store);
    const before = counts(store);
    const input: CommitInput = {
      opId: 'local-1',
      origin: 'local',
      writes: [
        msg('m1', 't1', 0),
        {
          kind: 'workflow',
          accountId: ACCOUNT,
          remoteThreadId: 'missing',
          patch: { status: 'done' },
        },
      ],
    };
    assert.throws(
      () => store.commit(input),
      (e: unknown) => e instanceof StoreError && e.code === 'notFound',
    );
    assert.deepEqual(counts(store), before, 'no message, thread, change or commit row');
    assert.equal(store.seq(), 1);
    // The opId was not recorded, so a corrected retry applies.
    const ok = store.commit({ ...input, writes: [input.writes[0]] });
    assert.equal(ok.replayed, false);
    assert.equal(ok.seq, 2);
  });
});

test('a replayed opId is a no-op: no row change, no second seq bump, same receipt seq', () => {
  withStore(store => {
    setup(store);
    const first = store.commit({
      opId: 'op-archive',
      origin: 'sync',
      writes: [msg('m1', 't1', 0)],
    });
    const snapshot = counts(store);
    const again = store.commit({
      opId: 'op-archive',
      origin: 'sync',
      writes: [msg('m1', 't1', 0, { subject: 'changed' }), msg('m2', 't2', 1)],
    });
    assert.deepEqual(again, { seq: first.seq, dbEpoch: store.dbEpoch, replayed: true, changed: 0 });
    assert.equal(store.seq(), first.seq);
    assert.deepEqual(counts(store), snapshot);
    assert.equal(thread(store, 't1')!.subject, 'Subject t1');
  });
});

test('changesSince orders by seq, never splits a commit across pages, and refuses seqs below the floor', () => {
  withStore((store, file) => {
    setup(store);
    store.commit({ opId: 'a', origin: 'sync', writes: [msg('m1', 't1', 0), msg('m2', 't2', 1)] }); // seq 2: 5 rows (Inbox's list grew)
    store.commit({
      opId: 'b',
      origin: 'local',
      writes: [{ kind: 'flags', accountId: ACCOUNT, target: { remoteThreadId: 't1' }, seen: true }],
    }); // seq 3
    store.commit({
      opId: 'c',
      origin: 'sync',
      writes: [{ kind: 'messageDelete', accountId: ACCOUNT, remoteId: 'm2' }],
    }); // seq 4
    store.commit({
      opId: 'd',
      origin: 'sync',
      writes: [
        { kind: 'syncState', accountId: ACCOUNT, scope: 'history', cursor: 'h2', generation: 1 },
      ],
    });
    assert.equal(store.seq(), 4, 'a cursor-only commit changes nothing visible, so seq stays');

    const all = store.changesSince(1);
    assert.ok(all.status === 'ok');
    assert.deepEqual(
      all.changes.map(c => c.seq),
      [...all.changes.map(c => c.seq)].sort((x, y) => x - y),
    );
    assert.deepEqual(
      all.changes.filter(c => c.seq === 4).map(c => `${c.type} ${c.id} ${c.op}`),
      [`Folder ${ACCOUNT}:INBOX u`, `Message ${ACCOUNT}:m2 d`, `Thread ${ACCOUNT}:t2 d`],
      'the thread left the Inbox list, so the Inbox row changed too (FR-15)',
    );
    assert.equal(all.toSeq, 4);

    const first = store.changesSince(1, { limit: 1 });
    assert.ok(first.status === 'ok');
    assert.deepEqual(
      first.changes.map(c => c.seq),
      [2, 2, 2, 2, 2],
      'the whole of seq 2, though the limit is 1',
    );
    assert.equal(first.toSeq, 2);
    assert.equal(first.hasMore, true);
    const rest = store.changesSince(first.toSeq, { limit: 100 });
    assert.ok(rest.status === 'ok');
    assert.deepEqual([...new Set(rest.changes.map(c => c.seq))], [3, 4]);
    assert.equal(rest.hasMore, false);

    assert.deepEqual(store.changesSince(99), {
      status: 'cannotCalculateChanges',
      floorSeq: 0,
      seq: 4,
    });
    assert.throws(
      () =>
        store.read(q =>
          q.get("UPDATE meta SET value = '3' WHERE key = 'change_floor_seq' RETURNING value"),
        ),
      /readonly/,
      'read() cannot write',
    );
    const side = file.open(); // compaction stand-in: a later eng-store job raises the floor
    side.prepare("UPDATE meta SET value = '3' WHERE key = 'change_floor_seq'").run();
    side.close();
    assert.equal(store.changesSince(2).status, 'cannotCalculateChanges');
    assert.equal(store.changesSince(3).status, 'ok');
  });
});

test('a trashed reply leaves the conversation in Inbox and adds it to Trash (D8)', () => {
  withStore(store => {
    setup(store);
    store.commit({ opId: 'p', origin: 'sync', writes: [msg('m1', 't1', 0), msg('m2', 't1', 1)] });
    store.commit({
      opId: 'trash-m2',
      origin: 'sync',
      writes: [
        {
          kind: 'placements',
          accountId: ACCOUNT,
          target: { remoteId: 'm2' },
          add: [{ folder: 'TRASH' }],
          remove: ['INBOX'],
        },
      ],
    });
    assert.deepEqual(lists(store, 't1'), [
      { folder: 'INBOX', unread: 1 },
      { folder: 'TRASH', unread: 1 },
    ]);
    // Trash the whole thread: it leaves Inbox.
    store.commit({
      opId: 'trash-t1',
      origin: 'local',
      writes: [
        {
          kind: 'placements',
          accountId: ACCOUNT,
          target: { remoteThreadId: 't1' },
          add: [{ folder: 'TRASH' }],
          remove: [],
        },
      ],
    });
    assert.deepEqual(lists(store, 't1'), [{ folder: 'TRASH', unread: 2 }]);
  });
});

test('the mutation fence keeps a local edit made after the page request went out (ARCH 4.3)', () => {
  withStore(store => {
    setup(store);
    store.commit({ opId: 'p1', origin: 'sync', writes: [msg('m1', 't1', 0)] });
    const fence = store.seq();
    // The user reads and archives while the page is in flight.
    store.commit({
      opId: 'act-1',
      origin: 'local',
      writes: [
        { kind: 'flags', accountId: ACCOUNT, target: { remoteThreadId: 't1' }, seen: true },
        {
          kind: 'placements',
          accountId: ACCOUNT,
          target: { remoteThreadId: 't1' },
          add: [],
          remove: ['INBOX'],
        },
      ],
    });
    // The page lands with the provider's older view: unread and in Inbox.
    store.commit({
      opId: 'p2',
      origin: 'sync',
      fenceSeq: fence,
      writes: [msg('m1', 't1', 0, { subject: 'Updated subject' })],
    });
    const m = store.read(q =>
      q.get('SELECT flags, subject FROM messages WHERE remote_id = ?', 'm1'),
    )!;
    assert.equal(Number(m.flags) & FLAG.seen, FLAG.seen, 'still read');
    assert.equal(m.subject, 'Updated subject', 'non-local fields still update');
    assert.deepEqual(lists(store, 't1'), [], 'still archived');
    // Without a fence (the next incremental pass), provider truth applies.
    store.commit({ opId: 'p3', origin: 'sync', writes: [msg('m1', 't1', 0)] });
    assert.deepEqual(lists(store, 't1'), [{ folder: 'INBOX', unread: 1 }]);
  });
});

test('coarse backfill pages write one * row per type and account', () => {
  withStore(store => {
    setup(store);
    const r = store.commit({
      opId: 'bf-1',
      origin: 'sync',
      step: 'backfill',
      changes: 'coarse',
      writes: [msg('m1', 't1', 0), msg('m2', 't2', 1), msg('m3', 't3', 2)],
    });
    assert.equal(r.changed, 3);
    const page = store.changesSince(1);
    assert.ok(page.status === 'ok');
    assert.deepEqual(
      page.changes.map(c => `${c.type} ${c.id} ${c.op}`),
      [`Folder ${ACCOUNT}:INBOX u`, `Message ${ACCOUNT} *`, `Thread ${ACCOUNT} *`],
      'folders stay fine-grained: there are few, and the sidebar counts must move',
    );
  });
});

test('the id allocator carries a full second into the next without repeating an id', () => {
  withStore(store => {
    setup(store);
    const second = Math.floor(T0 / 1000);
    // Something already sits in the next second's range.
    store.commit({
      opId: 'later',
      origin: 'sync',
      writes: [msg('next', 'tn', 0, { internalDate: (second + 1) * 1000 })],
    });
    const burst = Array.from({ length: 4097 }, (_, i) =>
      msg(`b${i}`, 'tb', 0, { internalDate: second * 1000 + (i % 1000) }),
    );
    store.commit({ opId: 'burst', origin: 'sync', changes: 'coarse', writes: burst });
    const ids = store.read(q => q.all('SELECT id FROM messages').map(r => Number(r.id)));
    assert.equal(new Set(ids).size, ids.length, 'all ids distinct');
    assert.equal(ids.filter(id => Math.floor(id / 4096) === second).length, 4096);
    assert.equal(
      ids.filter(id => Math.floor(id / 4096) === second + 1).length,
      2,
      'one carried, after the existing one',
    );
  });
});

test('accounts patch field by field and the status maps onto its columns', () => {
  withStore(store => {
    setup(store);
    store.commit({
      opId: 'pause',
      origin: 'system',
      writes: [
        {
          kind: 'account',
          id: ACCOUNT,
          tokenGrantedAt: T0,
          status: {
            state: 'paused',
            until: T0 + 60_000,
            class: 'throttle',
            reason: 'rateLimitExceeded',
          },
        },
      ],
    });
    const a = store.read(q =>
      q.get(
        'SELECT provider, status, status_reason, status_detail, resume_at, token_granted_at FROM accounts WHERE id = ?',
        ACCOUNT,
      ),
    )!;
    assert.deepEqual(
      { ...a },
      {
        provider: 'google',
        status: 'paused',
        status_reason: 'rateLimitExceeded',
        status_detail: '{"class":"throttle"}',
        resume_at: T0 + 60_000,
        token_granted_at: T0,
      },
    );
    assert.throws(
      () =>
        store.commit({
          opId: 'x',
          origin: 'system',
          writes: [{ kind: 'meta', key: 'db_epoch', value: 'forged' }],
        }),
      /written by the store only/,
    );
  });
});
