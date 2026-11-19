import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../../../../apps/desktop/src/host/sqlite';
import { createKnownLookup, openStore, type CommitExtension } from '../../src/store';
import { ACCOUNT, T0, accountWrite, folderWrites, msg } from './helpers';

// A test-only draft writer: eng-time's real one lives in outbox/store.ts; the lookup reads only the drafts table.
interface TestDraftWrite {
  kind: 'testDraft';
  id: string;
  accountId: string;
  remoteDraftId?: string;
  remoteMessageId?: string;
}
declare module '../../src/store/port' {
  interface ExtensionWrites {
    testDraft: TestDraftWrite;
  }
}
const drafts: CommitExtension = {
  lane: 'eng-time',
  kinds: ['testDraft'],
  changeTypes: ['Draft'],
  apply(write, tx) {
    const w = write as TestDraftWrite;
    tx.run(
      `INSERT INTO drafts(id, account_id, revision, data, remote_draft_id, remote_message_id, synced_revision,
        remote_change_key, updated_at) VALUES(?, ?, 1, '{}', ?, ?, 1, 'ck-1', ?)`,
      w.id,
      w.accountId,
      w.remoteDraftId ?? null,
      w.remoteMessageId ?? null,
      tx.now(),
    );
    tx.mark('Draft', w.id, 'u');
  },
};

function setup() {
  const store = openStore(openSqlite(':memory:'), { now: () => T0, extensions: [drafts] });
  const other = { ...accountWrite, id: 'acct-2', address: 'other@mail.example' };
  store.commit({
    opId: 'setup',
    origin: 'sync',
    writes: [
      accountWrite,
      other,
      ...folderWrites,
      { ...folderWrites[0], accountId: 'acct-2' },
      msg('m1', 't1', 0, { folders: [{ folder: 'INBOX', uid: 11 }, { folder: 'Label_1' }] }),
      msg('m2', 't1', 1, { folders: [] }),
      msg('m3', 't2', 2, { folders: [{ folder: 'INBOX', uid: 13 }] }),
      { ...msg('m9', 't9', 3), accountId: 'acct-2' },
      {
        kind: 'testDraft',
        id: 'd1',
        accountId: ACCOUNT,
        remoteDraftId: 'r-d1',
        remoteMessageId: 'r-m1',
      },
      { kind: 'testDraft', id: 'd2', accountId: ACCOUNT, remoteDraftId: 'r-d2' },
      {
        kind: 'testDraft',
        id: 'd3',
        accountId: 'acct-2',
        remoteDraftId: 'r-d3',
        remoteMessageId: 'r-m3',
      },
      {
        kind: 'calendar',
        accountId: ACCOUNT,
        remoteId: 'cal',
        name: 'Cal',
        hidden: false,
        readOnly: false,
      },
      {
        kind: 'event',
        accountId: ACCOUNT,
        calendarRemoteId: 'cal',
        remoteId: 'e1',
        rows: [
          { status: 'confirmed', allDay: false, etag: 'etag-1', data: '{}' },
          {
            recurrenceId: '20261101T090000Z',
            status: 'confirmed',
            allDay: false,
            etag: 'etag-o',
            data: '{}',
          },
        ],
      },
    ],
  });
  return store;
}

test('KnownLookup answers from the store for one account only (F3, FR-26)', async () => {
  const store = setup();
  const known = createKnownLookup(store, ACCOUNT);
  assert.deepEqual([...(await known.knownThreads(['t1', 't9', 'tx']))], ['t1']);
  assert.deepEqual([...(await known.knownMessages(['m1', 'm3', 'm9']))].sort(), ['m1', 'm3']);
  assert.deepEqual([...(await known.trackedDraftIds(['r-d1', 'r-d2', 'r-d3']))].sort(), [
    'r-d1',
    'r-d2',
  ]);
  assert.deepEqual(
    [...(await known.draftsByMessageId(['r-m1', 'r-m3', 'r-mx']))],
    [['r-m1', 'r-d1']],
    "another account's draft and an unknown message are absent",
  );
  assert.deepEqual(await known.threadMessages('t1'), [
    { remoteId: 'm1', placements: [{ folder: 'INBOX', uid: 11 }, { folder: 'Label_1' }] },
    { remoteId: 'm2', placements: [] },
  ]);
  assert.deepEqual(await known.threadMessages('t9'), [], 'acct-2 thread');
  assert.deepEqual(
    [...(await known.placements(['m3', 'm2', 'm9']))],
    [
      ['m2', []],
      ['m3', [{ folder: 'INBOX', uid: 13 }]],
    ],
  );
  assert.deepEqual(await known.folderUids('INBOX', 10, 12), [11]);
  assert.deepEqual(await known.folderUids('INBOX', 1, 99), [11, 13]);
  assert.deepEqual([...(await known.eventEtags('cal', ['e1', 'e2']))], [['e1', 'etag-1']]);
  for (const empty of [
    await known.knownThreads([]),
    await known.draftsByMessageId([]),
    await known.placements([]),
  ])
    assert.equal(empty.size, 0);
  store.close();
});

test('KnownLookup is read-only: it runs inside store.read, where SQLite refuses writes', async () => {
  const store = setup();
  const seq = store.seq();
  const known = createKnownLookup(store, ACCOUNT);
  await Promise.all([known.knownThreads(['t1']), known.draftsByMessageId(['r-m1'])]);
  assert.equal(store.seq(), seq);
  assert.throws(
    () => store.read(q => q.get("INSERT INTO meta(key, value) VALUES('x', 'y') RETURNING key")),
    /readonly/,
  );
  store.close();
});

test('schema 0002 records the pinned revision and the remote change key (FR-7, round 3)', () => {
  const store = setup();
  const cols = (table: string) =>
    store.read(q =>
      q.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).map(c => c.name),
    );
  assert.ok(cols('submissions').includes('revision'));
  assert.ok(cols('drafts').includes('remote_change_key'));
  const plan = store.read(q =>
    q
      .all<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT remote_draft_id FROM drafts WHERE account_id = 'a' AND remote_message_id IN ('x')",
      )
      .map(r => r.detail)
      .join(' '),
  );
  assert.match(plan, /drafts_remote_message/);
  store.close();
});
