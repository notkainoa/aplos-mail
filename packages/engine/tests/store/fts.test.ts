import test from 'node:test';
import assert from 'node:assert/strict';
import type { StorePort, StoreWrite } from '../../src/store';
// What `views/module.ts` loads at engine start: installs the row builder `indexWritten` calls.
import { FTS_BATCH } from '../../src/store/fts-indexer';
import { ACCOUNT, accountWrite, folderWrites, msg, withStore } from './helpers';

/*
 * The search index (fix-search, 2026-11-12). Before this, no commit wrote `messages_fts`, so every word search on the
 * real engine answered nothing. Each commit now indexes what it writes; mail stored before that is the backlog that
 * `ftsIndex` writes index in batches.
 */

let n = 0;
const commit = (store: StorePort, writes: StoreWrite[], origin: 'sync' | 'system' = 'sync') =>
  store.commit({ opId: `fts-${++n}`, origin, writes });
const setup = (store: StorePort) => commit(store, [accountWrite, ...folderWrites], 'system');
const rows = (store: StorePort) =>
  store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM messages_fts_docsize')!.n);
const bits = (store: StorePort) =>
  store.read(
    q => q.get<{ n: number }>('SELECT count(*) AS n FROM messages WHERE (parts & 8) <> 0')!.n,
  );
const hits = (store: StorePort, match: string) =>
  store.read(q =>
    q
      .all<{ remote_id: string }>(
        `SELECT m.remote_id FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ?
        ORDER BY m.remote_id`,
        match,
      )
      .map(r => r.remote_id),
  );

test('a message is indexed in the commit that stores it: subject, people and snippet', () => {
  withStore(store => {
    setup(store);
    commit(store, [
      msg('m1', 't1', 1, {
        subject: 'Reservation confirmed',
        from: { address: 'automated@airbnb.example', name: 'Airbnb' },
        cc: [{ address: 'friend@mail.example', name: 'Robin Lee' }],
        snippet: 'Check-in is at three',
      }),
    ]);
    assert.equal(rows(store), 1);
    assert.equal(bits(store), 1);
    assert.deepEqual(hits(store, 'reservation'), ['m1']);
    assert.deepEqual(
      hits(store, 'people : airbnb'),
      ['m1'],
      'the sender address, split at @ and dots',
    );
    assert.deepEqual(hits(store, 'people : robin'), ['m1'], 'cc names');
    assert.deepEqual(
      hits(store, 'body : "check-in"'),
      ['m1'],
      'the snippet stands in for the body',
    );
  });
});

test('a body replaces the snippet in the index; an HTML-only body is indexed as its visible text', () => {
  withStore(store => {
    setup(store);
    commit(store, [msg('m1', 't1', 1), msg('m2', 't2', 2)]);
    commit(store, [
      {
        kind: 'body',
        accountId: ACCOUNT,
        remoteId: 'm1',
        body: { text: 'The pineapple order shipped' },
      },
      {
        kind: 'body',
        accountId: ACCOUNT,
        remoteId: 'm2',
        body: { html: '<style>.mango{}</style><p>Your <b>papaya</b>&nbsp;box</p>' },
      },
    ]);
    assert.equal(rows(store), 2, 'one row per message, never a second');
    assert.deepEqual(hits(store, 'pineapple'), ['m1']);
    assert.deepEqual(hits(store, 'Snippet'), [], 'the snippet row was replaced');
    assert.deepEqual(hits(store, 'papaya'), ['m2']);
    assert.deepEqual(hits(store, 'mango'), [], 'style text is not indexed');
  });
});

test('a write that changes the subject re-indexes; one that changes nothing indexed keeps the row', () => {
  withStore(store => {
    setup(store);
    commit(store, [msg('m1', 't1', 1, { subject: 'Old words' })]);
    commit(store, [msg('m1', 't1', 1, { subject: 'New words' })]);
    assert.deepEqual(hits(store, 'old'), []);
    assert.deepEqual(hits(store, 'new'), ['m1']);
    assert.equal(rows(store), 1);
    commit(store, [
      msg('m1', 't1', 1, {
        subject: 'New words',
        flags: { seen: true, flagged: false, draft: false, fromMe: false },
      }),
    ]);
    assert.deepEqual(hits(store, 'new'), ['m1']);
    commit(store, [{ kind: 'messageDelete', accountId: ACCOUNT, remoteId: 'm1' }]);
    assert.equal(rows(store), 0, 'a deleted message leaves the index');
  });
});

test('the backlog: mail stored without index rows is indexed by ftsIndex batches, once', () => {
  withStore((store, file) => {
    setup(store);
    const count = FTS_BATCH + 7;
    commit(
      store,
      Array.from({ length: count }, (_, i) =>
        msg(`m${i}`, `t${i}`, i, { subject: `Order ${i} airbnb` }),
      ),
    );
    // The owner's store as the old engine left it: messages, no index rows, no bits.
    const raw = file.open();
    raw.exec(
      "INSERT INTO messages_fts(messages_fts) VALUES('delete-all'); UPDATE messages SET parts = parts & ~8",
    );
    raw.close();
    assert.equal(rows(store), 0);
    assert.deepEqual(hits(store, 'airbnb'), []);

    const first = commit(store, [{ kind: 'ftsIndex' }], 'system');
    assert.equal(rows(store), FTS_BATCH, 'one batch per write');
    assert.ok(first.changed > 0, 'the batch marks its threads, so open search windows run again');
    const changed = store.read(
      q =>
        q.get<{ n: number }>(
          "SELECT count(*) AS n FROM changes WHERE seq = ? AND type = 'Thread'",
          first.seq,
        )!.n,
    );
    assert.equal(changed, FTS_BATCH);
    commit(store, [{ kind: 'ftsIndex' }], 'system');
    assert.equal(rows(store), count);
    assert.equal(bits(store), count);
    assert.equal(hits(store, 'airbnb').length, count);
    const again = commit(store, [{ kind: 'ftsIndex' }], 'system');
    assert.equal(again.changed, 0, 'no backlog: nothing changes');
    assert.equal(rows(store), count, 'idempotent: no second row for any message');
  });
});
