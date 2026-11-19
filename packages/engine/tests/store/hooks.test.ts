import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../../../../apps/desktop/src/host/sqlite';
import type { LaneFor, LaneInput } from '../../src/ports/content';
import {
  openStore,
  STORED_HEADER,
  type CommitExtension,
  type IngestBatch,
  type OpenStoreOptions,
} from '../../src/store';
import { ACCOUNT, T0, accountWrite, folderWrites, msg, tempDb } from './helpers';

const OWNER = accountWrite.address;
const importantFolder = {
  kind: 'folder',
  accountId: ACCOUNT,
  remoteId: 'IMPORTANT',
  name: 'Important',
  role: 'important',
  folderKind: 'system',
} as const;

function open(options: OpenStoreOptions = {}) {
  const store = openStore(openSqlite(':memory:'), { now: () => T0, ...options });
  store.commit({
    opId: 'setup',
    origin: 'sync',
    writes: [accountWrite, ...folderWrites, importantFolder],
  });
  return store;
}
type Store = ReturnType<typeof open>;

const people = (store: Store) =>
  store.read(q =>
    q
      .all<{ address: string; name: string | null; sent_to: number; received_from: number }>(
        'SELECT address, name, sent_to, received_from FROM correspondents ORDER BY address',
      )
      .map(r => ({ ...r })),
  );
const workflow = (store: Store, thread: string) =>
  store.read(q => ({
    ...q.get(
      `SELECT w.lane, w.importance, w.rank_source, w.due_date, w.due_source, w.ranked_at, t.rev FROM thread_workflow w
      JOIN threads t ON t.id = w.thread_id WHERE t.remote_id = ?`,
      thread,
    ),
  }));
const sent = (id: string, thread: string, minutes: number, to: string[], extra = {}) =>
  msg(id, thread, minutes, {
    from: { address: OWNER },
    to: to.map(address => ({ address, name: `Name ${address}` })),
    flags: { seen: true, flagged: false, draft: false, fromMe: true },
    folders: [{ folder: 'SENT' }],
    ...extra,
  });

// ------------------------------------------------------------ correspondents

test('correspondents count sent-to and received-from inside the commit, once per message', () => {
  const store = open();
  store.commit({
    opId: 'p1',
    origin: 'sync',
    writes: [
      msg('m1', 't1', 0, { from: { address: 'Friend@Mail.Example', name: 'Friend' } }),
      sent('m2', 't1', 1, ['friend@mail.example', 'FRIEND@mail.example', OWNER], {
        cc: [{ address: 'boss@mail.example' }],
        bcc: [{ address: 'quiet@mail.example' }],
      }),
      msg('m3', 't2', 2, { flags: { seen: false, flagged: false, draft: true, fromMe: true } }),
    ],
  });
  // The same messages again (a resync page) and a flag change never count twice.
  store.commit({
    opId: 'p2',
    origin: 'sync',
    writes: [
      msg('m1', 't1', 0, { from: { address: 'friend@mail.example', name: 'Friend' } }),
      { kind: 'flags', accountId: ACCOUNT, target: { remoteId: 'm2' }, flagged: true },
    ],
  });
  assert.deepEqual(people(store), [
    { address: 'boss@mail.example', name: null, sent_to: 1, received_from: 0 },
    { address: 'friend@mail.example', name: 'Friend', sent_to: 1, received_from: 1 },
    { address: 'quiet@mail.example', name: null, sent_to: 1, received_from: 0 },
  ]);
  store.close();
});

test('a failed commit leaves no correspondents behind', () => {
  const store = open();
  assert.throws(() =>
    store.commit({
      opId: 'bad',
      origin: 'local',
      writes: [
        msg('m1', 't1', 0),
        { kind: 'flags', accountId: ACCOUNT, target: { remoteId: 'nope' }, seen: true },
      ],
    }),
  );
  assert.deepEqual(people(store), []);
  store.close();
});

test('a draft that is sent in place counts its recipients once it stops being a draft', () => {
  const store = open();
  const draft = { seen: true, flagged: false, draft: true, fromMe: true };
  const to = [{ address: 'friend@mail.example' }];
  store.commit({
    opId: 'd1',
    origin: 'sync',
    writes: [msg('m1', 't1', 0, { to, flags: draft })],
  });
  assert.deepEqual(people(store), []);
  store.commit({
    opId: 'd2',
    origin: 'sync',
    writes: [sent('m1', 't1', 0, ['friend@mail.example'])],
  });
  assert.equal(people(store)[0]?.sent_to, 1);
  store.commit({
    opId: 'd3',
    origin: 'sync',
    writes: [sent('m1', 't1', 0, ['friend@mail.example'])],
  });
  assert.equal(people(store)[0]?.sent_to, 1);
});

// ------------------------------------------------------------ laneFor

function recordingLane(answer: (input: LaneInput) => ReturnType<LaneFor>) {
  const calls: LaneInput[] = [];
  const laneFor: LaneFor = input => {
    calls.push(input);
    return answer(input);
  };
  return { calls, laneFor };
}

test('laneFor runs at ingest with the thread facts and stores a heuristic rank with a change row', () => {
  const { calls, laneFor } = recordingLane(() => ({ lane: 'low', importance: 'important' }));
  const store = open({ ingest: { laneFor } });
  store.commit({
    opId: 'out',
    origin: 'sync',
    writes: [sent('s0', 't0', 0, ['news@shop.example'])],
  });
  assert.equal(calls.length, 0, 'a thread with no inbound message is not ranked');
  const before = store.seq();
  store.commit({
    opId: 'p1',
    origin: 'sync',
    writes: [
      msg('m1', 't1', 1, {
        from: { address: 'News@Shop.Example' },
        hdr: { bulk: true, list: true, autoSubmitted: true },
        listUnsubscribe: { urls: ['https://shop.example/u'], oneClick: true },
        folders: [{ folder: 'INBOX' }, { folder: 'IMPORTANT' }],
      }),
      sent('m2', 't1', 2, ['news@shop.example']),
    ],
  });
  assert.equal(calls.length, 1, 'one call per thread per commit');
  const input = calls[0];
  assert.equal(input.message.from?.address, 'News@Shop.Example');
  assert.deepEqual(input.message.roles, ['important', 'inbox']);
  assert.deepEqual(input.message.list, {
    listUnsubscribe: '<https://shop.example/u>',
    listUnsubscribePost: 'List-Unsubscribe=One-Click',
    listId: STORED_HEADER.listId,
    precedence: 'bulk',
    autoSubmitted: 'auto-generated',
  });
  assert.deepEqual(input.self, [OWNER]);
  assert.equal(input.knownCorrespondent, true, 'the owner wrote to them (s0 counted first)');
  assert.equal(input.userReplied, true);
  assert.equal(input.userEndedThread, true);
  assert.equal(input.text, undefined);
  const wf = workflow(store, 't1');
  assert.equal(wf.lane, 'low');
  assert.equal(wf.importance, 'important');
  assert.equal(wf.rank_source, 'heuristic');
  assert.equal(wf.ranked_at, T0);
  const page = store.changesSince(before);
  assert.ok(page.status === 'ok');
  assert.ok(page.changes.some(c => c.type === 'Thread' && c.id === `${ACCOUNT}:t1`));
  store.close();
});

test('laneFor runs again when a body arrives, with the text capped', () => {
  const { calls, laneFor } = recordingLane(input =>
    input.text?.includes('invoice')
      ? { lane: 'do', importance: 'normal', due: '2026-11-05' }
      : { lane: 'update', importance: 'normal' },
  );
  const store = open({ ingest: { laneFor } });
  store.commit({ opId: 'p1', origin: 'sync', writes: [msg('m1', 't1', 0)] });
  assert.equal(workflow(store, 't1').lane, 'update');
  store.commit({
    opId: 'b1',
    origin: 'sync',
    step: 'prefetch',
    writes: [
      {
        kind: 'body',
        accountId: ACCOUNT,
        remoteId: 'm1',
        body: { text: `invoice ${'x'.repeat(40_000)}` },
      },
    ],
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].text?.length, 16_384);
  assert.deepEqual(
    { ...workflow(store, 't1'), rev: undefined, ranked_at: undefined },
    {
      lane: 'do',
      importance: 'normal',
      rank_source: 'heuristic',
      due_date: '2026-11-05',
      due_source: 'structured',
      rev: undefined,
      ranked_at: undefined,
    },
  );
  store.close();
});

test('laneFor never overrides a rule, user or AI rank, nor a user or AI due date', () => {
  const { laneFor } = recordingLane(() => ({
    lane: 'low',
    importance: 'normal',
    due: '2026-12-01',
  }));
  const store = open({ ingest: { laneFor } });
  store.commit({
    opId: 'p1',
    origin: 'sync',
    writes: ['t1', 't2', 't3', 't4'].map((t, i) => msg(`m${i}`, t, i)),
  });
  const patches = {
    t1: { rankSource: 'rule', lane: 'do' },
    t2: { rankSource: 'user', lane: 'do' },
    t3: { rankSource: 'ai', lane: 'update' },
    t4: { rankSource: 'heuristic', lane: 'do', dueDate: '2026-11-02', dueSource: 'user' },
  } as const;
  store.commit({
    opId: 'ranks',
    origin: 'local',
    writes: Object.entries(patches).map(([t, patch]) => ({
      kind: 'workflow' as const,
      accountId: ACCOUNT,
      remoteThreadId: t,
      patch,
    })),
  });
  store.commit({
    opId: 'p2',
    origin: 'sync',
    writes: ['t1', 't2', 't3', 't4'].map((t, i) => msg(`n${i}`, t, 10 + i)),
  });
  assert.equal(workflow(store, 't1').lane, 'do');
  assert.equal(workflow(store, 't2').lane, 'do');
  assert.equal(workflow(store, 't3').lane, 'update');
  const t4 = workflow(store, 't4');
  assert.equal(t4.lane, 'low', 'a heuristic rank is re-ranked');
  assert.deepEqual([t4.due_date, t4.due_source], ['2026-11-02', 'user'], 'the user date stays');
  store.close();
});

test('a laneFor that throws or answers out of range keeps the stored rank and the mail still arrives', () => {
  let mode: 'throw' | 'junk' = 'throw';
  const laneFor = ((): ReturnType<LaneFor> => {
    if (mode === 'throw') throw new Error('lane bug');
    return { lane: 'urgent', importance: 'normal' } as never;
  }) as LaneFor;
  const store = open({ ingest: { laneFor } });
  store.commit({ opId: 'p1', origin: 'sync', writes: [msg('m1', 't1', 0)] });
  mode = 'junk';
  store.commit({ opId: 'p2', origin: 'sync', writes: [msg('m2', 't1', 1)] });
  assert.equal(
    store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM messages')!.n),
    2,
  );
  assert.equal(workflow(store, 't1').lane, 'do', 'the schema default');
  store.close();
});

// ------------------------------------------------------------ the lanes' ingest hook (notifications, time-5)

function notifier(opts: { fail?: boolean; forge?: boolean } = {}) {
  const batches: IngestBatch[] = [];
  const ext: CommitExtension = {
    lane: 'eng-time',
    kinds: ['notification'],
    changeTypes: ['Notification'],
    apply() {},
    ingest(batch, tx) {
      batches.push(batch);
      if (opts.fail) throw new Error('notify bug');
      if (opts.forge) tx.mark('Message', `${ACCOUNT}:m1`, 'u');
      for (const m of batch.messages)
        if (m.added && !m.flags.fromMe && m.roles.includes('inbox')) {
          tx.run(
            "INSERT INTO notifications(message_id, state, created_at) VALUES(?, 'pending', ?)",
            m.rowId,
            tx.now(),
          );
          tx.mark('Notification', `${m.accountId}:${m.remoteId}`, 'u');
        }
    },
  };
  return { ext, batches };
}
const notifications = (store: Store) =>
  store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM notifications')!.n);

test('the ingest hook sees the stored messages after rollups and writes its rows in the same commit', () => {
  const { ext, batches } = notifier();
  const store = open({ extensions: [ext] });
  const r = store.commit({
    opId: 'p1',
    origin: 'sync',
    step: 'incremental',
    writes: [
      msg('m1', 't1', 0, { folders: [{ folder: 'INBOX' }, { folder: 'IMPORTANT' }] }),
      msg('m2', 't1', 1, { folders: [{ folder: 'TRASH' }] }),
      msg('m3', 't2', 2),
      { kind: 'messageDelete', accountId: ACCOUNT, remoteId: 'm3' },
    ],
  });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].origin, 'sync');
  assert.equal(batches[0].step, 'incremental');
  assert.deepEqual(
    batches[0].messages.map(m => [m.remoteId, m.remoteThreadId, m.added, m.folders, m.roles]),
    [
      ['m1', 't1', true, ['IMPORTANT', 'INBOX'], ['important', 'inbox']],
      ['m2', 't1', true, ['TRASH'], ['trash']],
    ],
    'deleted in the same commit: not in the batch',
  );
  assert.equal(notifications(store), 1);
  const page = store.changesSince(r.seq - 1);
  assert.ok(page.status === 'ok');
  assert.ok(
    page.changes.every(c => c.seq === r.seq),
    'one seq for the whole commit',
  );
  assert.ok(page.changes.some(c => c.type === 'Notification' && c.id === `${ACCOUNT}:m1`));

  store.commit({ opId: 'p2', origin: 'sync', writes: [msg('m1', 't1', 0)] });
  assert.equal(batches[1].messages[0].added, false, 'an update of a known message');
  store.commit({
    opId: 'p3',
    origin: 'sync',
    writes: [{ kind: 'flags', accountId: ACCOUNT, target: { remoteId: 'm1' }, seen: true }],
  });
  assert.equal(batches.length, 2, 'not called for a commit without a message write');
  store.close();
});

test('a throwing ingest hook rolls the whole commit back; it cannot forge store change rows', () => {
  for (const opts of [{ fail: true }, { forge: true }]) {
    const { ext } = notifier(opts);
    const store = open({ extensions: [ext] });
    const seq = store.seq();
    assert.throws(
      () => store.commit({ opId: 'p1', origin: 'sync', writes: [msg('m1', 't1', 0)] }),
      opts.fail ? /notify bug/ : /may not write Message/,
    );
    assert.equal(store.seq(), seq, 'no seq bump');
    assert.equal(
      store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM messages')!.n),
      0,
    );
    assert.equal(
      store.read(
        q => q.get<{ n: number }>('SELECT count(*) AS n FROM changes WHERE seq > ?', seq)!.n,
      ),
      0,
    );
    assert.equal(notifications(store), 0);
    store.close();
  }
});

test('a stored body that cannot be decoded gives up the rank, not the commit', () => {
  const file = tempDb();
  const codec = {
    encode: (d: Uint8Array) => ({ codec: 1, data: Uint8Array.from(d) }),
    decode: (_c: number, d: Uint8Array) => d,
  };
  const setup = openStore(file.open(), { now: () => T0, bodyCodec: codec });
  setup.commit({
    opId: 'setup',
    origin: 'sync',
    writes: [accountWrite, ...folderWrites, msg('m1', 't1', 0)],
  });
  setup.commit({
    opId: 'b',
    origin: 'sync',
    step: 'prefetch',
    writes: [{ kind: 'body', accountId: ACCOUNT, remoteId: 'm1', body: { text: 'Hello' } }],
  });
  setup.close();
  const store = openStore(file.open(), {
    now: () => T0,
    ingest: { laneFor: () => ({ lane: 'low', importance: 'normal' }) },
  });
  try {
    store.commit({ opId: 'n', origin: 'sync', writes: [msg('m2', 't1', -1)] });
    assert.equal(
      store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM messages')!.n),
      2,
    );
  } finally {
    store.close();
    file.cleanup();
  }
});

test('a failing SQL read while building the lane input still fails the commit (only decoding is forgiven)', () => {
  const db = openSqlite(':memory:');
  const store = openStore(db, {
    now: () => T0,
    ingest: { laneFor: () => ({ lane: 'low', importance: 'normal' }) },
  });
  store.commit({
    opId: 'setup',
    origin: 'sync',
    writes: [accountWrite, ...folderWrites, msg('m1', 't1', 0)],
  });
  store.commit({
    opId: 'b',
    origin: 'sync',
    step: 'prefetch',
    writes: [{ kind: 'body', accountId: ACCOUNT, remoteId: 'm1', body: { text: 'Hello' } }],
  });
  db.exec('DROP TABLE bodies');
  assert.throws(() => store.commit({ opId: 'n', origin: 'sync', writes: [msg('m2', 't1', -1)] }));
  assert.equal(
    store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM messages')!.n),
    1,
  );
  // The op id was not recorded, so a retry is not answered as replayed.
  assert.equal(
    store.read(q => q.get<{ n: number }>("SELECT count(*) AS n FROM commits WHERE op_id = 'n'")!.n),
    0,
  );
  store.close();
});
