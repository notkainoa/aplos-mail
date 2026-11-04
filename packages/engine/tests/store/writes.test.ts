import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBody } from '../../src/store/bodies';
import { readBody, StoreError, type OpWrite, type StorePort } from '../../src/store';
import { ACCOUNT, T0, accountWrite, folderWrites, msg, withStore } from './helpers';

const setup = (store: StorePort) =>
  store.commit({ opId: 'setup', origin: 'sync', writes: [accountWrite, ...folderWrites] });
const labels = (store: StorePort, remoteId: string) =>
  store.read(q =>
    q
      .all<{ f: string }>(
        `SELECT f.remote_id AS f FROM message_folders mf JOIN folders f ON f.id = mf.folder_id JOIN messages m ON m.id = mf.message_id
        WHERE m.remote_id = ? ORDER BY f.remote_id`,
        remoteId,
      )
      .map(r => r.f),
  );
const archive = (opId: string, thread: string): OpWrite => ({
  kind: 'op',
  opId,
  accountId: ACCOUNT,
  opKind: 'archive',
  targets: [`${ACCOUNT}:${thread}`],
  payload: JSON.stringify({ removeLabelIds: ['INBOX'] }),
  effect: [{ kind: 'placements', target: { remoteThreadId: thread }, add: [], remove: ['INBOX'] }],
  scope: 'triage',
});

test('an op without its originating scope is refused, and ops.scope is NOT NULL, so the check fails closed (R2H-2)', () => {
  withStore((store, file) => {
    setup(store);
    store.commit({ opId: 'p1', origin: 'sync', writes: [msg('m1', 't1', 0)] });
    for (const scope of [undefined, ''])
      assert.throws(
        () =>
          store.commit({
            opId: `no-scope-${scope}`,
            origin: 'local',
            writes: [{ ...archive('op-x', 't1'), scope } as unknown as OpWrite],
          }),
        (e: unknown) => e instanceof StoreError && e.code === 'invalid' && /scope/.test(e.message),
      );
    assert.deepEqual(labels(store, 'm1'), ['INBOX'], 'the refused commit left no effect');
    store.commit({ opId: 'a1', origin: 'local', writes: [archive('op-1', 't1')] });
    // The queue item's and Operation's scope is the stored one.
    assert.equal(
      store.read(q => q.get<{ scope: string }>('SELECT scope FROM ops')?.scope),
      'triage',
    );
    // A writer that bypasses the type (raw SQL, a later migration) still cannot store an op without one.
    const db = file.open();
    try {
      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO ops(op_id, account_id, kind, target, payload, state, created_seq) VALUES('raw', ?, 'archive', '[]', '{}', 'queued', 1)`,
            )
            .run(ACCOUNT),
        /NOT NULL constraint failed: ops.scope/,
      );
    } finally {
      db.close();
    }
  });
});

test('a pending op is replayed over a sync page fenced after the edit, so Inbox does not come back (FR-10, ARCH 4.3)', () => {
  withStore(store => {
    setup(store);
    store.commit({ opId: 'p1', origin: 'sync', writes: [msg('m1', 't1', 0), msg('m2', 't1', 1)] });
    // The owner archives t1: the op and its local effect commit together.
    const local = store.commit({ opId: 'a1', origin: 'local', writes: [archive('op-1', 't1')] });
    assert.deepEqual(labels(store, 'm1'), []);
    assert.equal(
      store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM ops')!.n),
      1,
    );
    // A page requested after the edit (fence >= the local seq) that the provider produced before it saw the op.
    store.commit({
      opId: 'p2',
      origin: 'sync',
      fenceSeq: local.seq,
      writes: [msg('m1', 't1', 0), msg('m2', 't1', 1), msg('m3', 't1', 2)],
    });
    assert.deepEqual(labels(store, 'm1'), [], 'replayed: still archived');
    assert.deepEqual(labels(store, 'm2'), []);
    assert.deepEqual(
      labels(store, 'm3'),
      ['INBOX'],
      'a reply that arrived after the op is provider truth',
    );
    const inbox = store.read(q =>
      q.get<{ unread: number }>(
        `SELECT tf.unread FROM thread_folders tf JOIN folders f ON f.id = tf.folder_id WHERE f.remote_id = 'INBOX'`,
      ),
    );
    assert.equal(inbox?.unread, 1, 'the rollup ran after the replay');

    // Failed: replay stops, and the next page shows provider truth (the row returns to its place).
    store.commit({
      opId: 's1',
      origin: 'sync',
      writes: [
        { kind: 'opSettle', opId: 'op-1', state: 'failed', attempts: 3, lastError: 'notFound' },
      ],
    });
    store.commit({ opId: 'p3', origin: 'sync', writes: [msg('m1', 't1', 0)] });
    assert.deepEqual(labels(store, 'm1'), ['INBOX']);
    // Synced deletes the row.
    store.commit({
      opId: 's2',
      origin: 'sync',
      writes: [{ kind: 'opSettle', opId: 'op-1', state: 'synced' }],
    });
    assert.equal(
      store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM ops')!.n),
      0,
    );
  });
});

test('ops change the account row (pendingChanges) and refuse duplicates; a local settle of an unknown op fails', () => {
  withStore(store => {
    setup(store);
    store.commit({ opId: 'p1', origin: 'sync', writes: [msg('m1', 't1', 0)] });
    const before = store.seq();
    store.commit({ opId: 'a1', origin: 'local', writes: [archive('op-1', 't1')] });
    const page = store.changesSince(before);
    assert.ok(page.status === 'ok');
    assert.ok(page.changes.some(c => c.type === 'Account' && c.id === ACCOUNT));
    assert.throws(
      () => store.commit({ opId: 'a2', origin: 'local', writes: [archive('op-1', 't1')] }),
      StoreError,
    );
    assert.throws(
      () =>
        store.commit({
          opId: 'a3',
          origin: 'local',
          writes: [{ kind: 'opSettle', opId: 'nope', state: 'cancelled' }],
        }),
      StoreError,
    );
  });
});

test('IMAP deltas address a message by folder and UID (FR-10)', () => {
  withStore(store => {
    setup(store);
    store.commit({
      opId: 'p1',
      origin: 'sync',
      writes: [msg('m1', 't1', 0, { folders: [{ folder: 'INBOX', uid: 41 }] })],
    });
    store.commit({
      opId: 'f1',
      origin: 'sync',
      writes: [
        { kind: 'flags', accountId: ACCOUNT, target: { folder: 'INBOX', uid: 41 }, seen: true },
        {
          kind: 'placements',
          accountId: ACCOUNT,
          target: { folder: 'INBOX', uid: 41 },
          add: [],
          remove: ['INBOX'],
        },
        { kind: 'flags', accountId: ACCOUNT, target: { folder: 'INBOX', uid: 99 }, seen: true }, // unknown: dropped
      ],
    });
    assert.deepEqual(labels(store, 'm1'), []);
    assert.equal(
      store.read(
        q => q.get<{ flags: number }>("SELECT flags FROM messages WHERE remote_id = 'm1'")!.flags,
      ) & 1,
      1,
    );
  });
});

test('a header-thread merge moves messages into one thread and deletes the emptied ones (FR-10)', () => {
  withStore(store => {
    setup(store);
    store.commit({
      opId: 'p1',
      origin: 'sync',
      writes: [msg('a1', 'ta', 0), msg('b1', 'tb', 1), msg('c1', 'tc', 2)],
    });
    const before = store.seq();
    store.commit({
      opId: 'm',
      origin: 'sync',
      writes: [{ kind: 'threadMerge', accountId: ACCOUNT, from: ['tb', 'tc'], into: 'ta' }],
    });
    const t = store.read(q =>
      q
        .all<{ remote_id: string; msg_count: number }>('SELECT remote_id, msg_count FROM threads')
        .map(r => ({ ...r })),
    );
    assert.deepEqual(t, [{ remote_id: 'ta', msg_count: 3 }]);
    const page = store.changesSince(before);
    assert.ok(page.status === 'ok');
    assert.deepEqual(
      page.changes.filter(c => c.type !== 'Folder').map(c => `${c.type} ${c.id} ${c.op}`),
      [
        `Message ${ACCOUNT}:b1 u`,
        `Message ${ACCOUNT}:c1 u`,
        `Thread ${ACCOUNT}:ta u`,
        `Thread ${ACCOUNT}:tb d`,
        `Thread ${ACCOUNT}:tc d`,
      ],
    );
    // `into` unknown: the first stored `from` thread is renamed and keeps its workflow.
    store.commit({
      opId: 'w',
      origin: 'local',
      writes: [
        { kind: 'workflow', accountId: ACCOUNT, remoteThreadId: 'ta', patch: { status: 'done' } },
      ],
    });
    store.commit({
      opId: 'm2',
      origin: 'sync',
      writes: [
        { kind: 'threadMerge', accountId: ACCOUNT, from: ['ta'], into: '<root@mail.example>' },
      ],
    });
    const wf = store.read(q =>
      q.get<{ remote_id: string; status: string }>(
        'SELECT t.remote_id, w.status FROM threads t JOIN thread_workflow w ON w.thread_id = t.id',
      ),
    );
    assert.deepEqual({ ...wf }, { remote_id: '<root@mail.example>', status: 'done' });
  });
});

test('the account write carries the status copy key (FR-10)', () => {
  withStore(store => {
    setup(store);
    store.commit({
      opId: 'r',
      origin: 'sync',
      writes: [
        {
          kind: 'account',
          id: ACCOUNT,
          status: {
            state: 'paused',
            class: 'rate',
            reason: 'rateLimitExceeded',
            until: T0 + 60_000,
          },
          reasonCode: 'quota',
        },
      ],
    });
    assert.equal(
      store.read(q => q.get<{ c: string }>('SELECT status_reason_code AS c FROM accounts')!.c),
      'quota',
    );
    store.commit({
      opId: 'r2',
      origin: 'sync',
      writes: [{ kind: 'account', id: ACCOUNT, status: { state: 'ok' }, reasonCode: null }],
    });
    assert.equal(
      store.read(
        q => q.get<{ c: string | null }>('SELECT status_reason_code AS c FROM accounts')!.c,
      ),
      null,
    );
  });
});

test('bodies round-trip through the codec, set the part bits and re-queue search; attachments keep file state (FR-10)', () => {
  const codec = {
    encode: (d: Uint8Array) => ({ codec: 2, data: Uint8Array.from(d).reverse() }),
    decode: (c: number, d: Uint8Array) => (assert.equal(c, 2), Uint8Array.from(d).reverse()),
  };
  withStore(
    store => {
      setup(store);
      store.commit({
        opId: 'p1',
        origin: 'sync',
        writes: [msg('m1', 't1', 0, { hasAttachments: true })],
      });
      const body = { text: 'Hello', html: '<p>Hello <img src="cid:a"></p>', cidMap: { a: '0.1' } };
      store.commit({
        opId: 'b',
        origin: 'sync',
        step: 'prefetch',
        writes: [{ kind: 'body', accountId: ACCOUNT, remoteId: 'm1', body }],
      });
      assert.deepEqual(
        store.read(q => readBody(q, ACCOUNT, 'm1', codec)),
        body,
      );
      // The read side decodes with the store's own codec when no explicit one is given.
      assert.deepEqual(
        store.read(q => readBody(q, ACCOUNT, 'm1')),
        body,
      );
      const row = store.read(q =>
        q.get<{ codec: number; parts: number }>(
          'SELECT b.codec, m.parts FROM bodies b JOIN messages m ON m.id = b.message_id',
        )!,
      );
      assert.equal(row.codec, 2);
      assert.equal(row.parts & 0b111, 0b111, 'meta, text and html');
      // A codec-0 row decodes raw even through a codec that only knows its own number.
      const raw0 = {
        codec: 0,
        data: new TextEncoder().encode(JSON.stringify({ text: 'raw' })),
      };
      const picky = {
        encode: codec.encode,
        decode: (c: number, d: Uint8Array) => {
          if (c !== 2) throw new Error('unknown codec');
          return codec.decode(c, d);
        },
      };
      assert.deepEqual(decodeBody(raw0, picky), { text: 'raw' });

      const list = (names: string[]) =>
        ({
          kind: 'attachments',
          accountId: ACCOUNT,
          remoteId: 'm1',
          list: names.map(n => ({
            remotePart: n,
            name: `${n}.pdf`,
            mime: 'application/pdf',
            size: 10,
            inline: false,
          })),
        }) as const;
      store.commit({ opId: 'a1', origin: 'sync', writes: [list(['0.1', '0.2'])] });
      store.commit({
        opId: 'a2',
        origin: 'local',
        writes: [
          {
            kind: 'attachmentState',
            accountId: ACCOUNT,
            remoteId: 'm1',
            remotePart: '0.1',
            state: 'present',
            path: 'ab/0.1.pdf',
          },
        ],
      });
      store.commit({ opId: 'a3', origin: 'sync', writes: [list(['0.1'])] });
      const att = store.read(q =>
        q.all('SELECT remote_part, state, path FROM attachments').map(r => ({ ...r })),
      );
      assert.deepEqual(att, [{ remote_part: '0.1', state: 'present', path: 'ab/0.1.pdf' }]);
    },
    { bodyCodec: codec },
  );
});

test('governor state, provider memory and quarantine persist without change rows (FR-10)', () => {
  withStore(store => {
    setup(store);
    const before = store.seq();
    store.commit({
      opId: 'g',
      origin: 'system',
      writes: [
        {
          kind: 'governor',
          accountId: '*',
          budget: 'gmail',
          patch: { dailyBlockUntil: T0 + 3_600_000, reason: 'dailyLimitExceeded' },
        },
        {
          kind: 'governor',
          accountId: ACCOUNT,
          budget: 'gmail',
          patch: { cooldownStep: 2, cooldownUntil: T0 + 30_000 },
        },
        {
          kind: 'providerMemory',
          accountId: ACCOUNT,
          values: { 'imap.host': 'imap.mail.example', stale: null },
        },
        {
          kind: 'syncFailure',
          accountId: ACCOUNT,
          item: 'm9',
          failure: { attempts: 1, nextRetryAt: T0 + 60_000, lastReason: 'parse' },
        },
      ],
    });
    assert.equal(store.seq(), before, 'nothing contract-visible changed');
    store.commit({
      opId: 'g2',
      origin: 'system',
      writes: [
        { kind: 'governor', accountId: ACCOUNT, budget: 'gmail', patch: { cooldownUntil: null } },
      ],
    });
    const g = store.read(q =>
      q.get(
        'SELECT cooldown_step, cooldown_until FROM governor_state WHERE account_id = ?',
        ACCOUNT,
      ),
    );
    assert.deepEqual({ ...g }, { cooldown_step: 2, cooldown_until: null });
    store.commit({
      opId: 'g3',
      origin: 'sync',
      writes: [{ kind: 'syncFailure', accountId: ACCOUNT, item: 'm9', failure: null }],
    });
    assert.equal(
      store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM sync_failures')!.n),
      0,
    );
    assert.equal(
      store.read(q => q.get<{ v: string }>('SELECT value AS v FROM provider_memory')!.v),
      'imap.mail.example',
    );
  });
});

test('calendars and event resources: full row sets, the resync sweep and cascading deletes (FR-10)', () => {
  withStore(store => {
    setup(store);
    const cal = {
      kind: 'calendar',
      accountId: ACCOUNT,
      remoteId: 'primary',
      name: 'Owner',
      hidden: false,
      readOnly: false,
      primary: true,
    } as const;
    const row = (recurrenceId?: string) => ({
      recurrenceId,
      status: 'confirmed',
      allDay: false,
      startUtc: T0,
      endUtc: T0 + 3_600_000,
      data: '{}',
    });
    store.commit({
      opId: 'c1',
      origin: 'sync',
      writes: [
        cal,
        {
          kind: 'event',
          accountId: ACCOUNT,
          calendarRemoteId: 'primary',
          remoteId: 'e1',
          rows: [row(), row('20261103T090000Z')],
          seenGen: 5,
        },
        {
          kind: 'event',
          accountId: ACCOUNT,
          calendarRemoteId: 'primary',
          remoteId: 'e2',
          rows: [row()],
          seenGen: 5,
        },
      ],
    });
    // The owner hides the calendar locally; a later list without `selected` keeps that choice.
    store.commit({ opId: 'c-sel', origin: 'local', writes: [{ ...cal, selected: false }] });
    store.commit({ opId: 'c-list', origin: 'sync', writes: [cal] });
    assert.equal(
      store.read(q => q.get<{ s: number }>('SELECT selected AS s FROM calendars')!.s),
      0,
    );
    // The override was dropped at the server: the resource's new row set has only the master.
    store.commit({
      opId: 'c2',
      origin: 'sync',
      writes: [
        {
          kind: 'event',
          accountId: ACCOUNT,
          calendarRemoteId: 'primary',
          remoteId: 'e1',
          rows: [row()],
          seenGen: 9,
        },
      ],
    });
    assert.equal(
      store.read(
        q => q.get<{ n: number }>("SELECT count(*) AS n FROM events WHERE remote_id = 'e1'")!.n,
      ),
      1,
    );
    const before = store.seq();
    store.commit({
      opId: 'c3',
      origin: 'sync',
      writes: [
        { kind: 'eventSweep', accountId: ACCOUNT, calendarRemoteId: 'primary', generation: 9 },
      ],
    });
    const page = store.changesSince(before);
    assert.ok(page.status === 'ok');
    assert.deepEqual(
      page.changes.map(c => `${c.type} ${c.id} ${c.op}`),
      [`Event ${ACCOUNT}:primary/e2 d`],
    );
    store.commit({
      opId: 'c4',
      origin: 'sync',
      writes: [{ kind: 'calendarDelete', accountId: ACCOUNT, remoteId: 'primary' }],
    });
    assert.equal(
      store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM events')!.n),
      0,
    );
  });
});
