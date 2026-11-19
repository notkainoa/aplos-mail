import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore, StoreError, type SqlDatabase, type StorePort } from '../../src/store';
import { compactChanges } from '../../src/store/compact';
import { NestedTransactionError, transaction } from '../../src/store/sql';
import { ACCOUNT, T0, accountWrite, folderWrites, msg, tempDb, withStore } from './helpers';

const MINUTE = 60_000;

/** A store on a clock the test moves. */
function clocked() {
  const clock = { now: T0 };
  return { clock, options: { now: () => clock.now } };
}

const setup = (store: StorePort) =>
  store.commit({ opId: 'setup', origin: 'sync', writes: [accountWrite, ...folderWrites] });

/** One sync commit of `n` new messages: n Message rows, n Thread rows, and one Folder row for INBOX. */
function page(store: StorePort, name: string, n: number) {
  const writes = Array.from({ length: n }, (_, i) => msg(`${name}-${i}`, `${name}-t${i}`, i));
  return store.commit({ opId: name, origin: 'sync', writes }).seq;
}

const rowsPerSeq = (store: StorePort) =>
  store.read(q =>
    q
      .all<{ seq: number; n: number }>('SELECT seq, count(*) AS n FROM changes GROUP BY seq')
      .map(r => [r.seq, r.n]),
  );
const floor = (store: StorePort) =>
  store.read(q => Number(q.get("SELECT value FROM meta WHERE key = 'change_floor_seq'")!.value));

test('compact by rows keeps at most maxRows rows and never splits a commit', () => {
  withStore(store => {
    setup(store); // seq 1: Account + 3 Folder rows
    const s2 = page(store, 'a', 2); // 2 messages, 2 threads, INBOX: 5 rows
    const s3 = page(store, 'b', 1); // 3 rows
    const s4 = page(store, 'c', 1); // 3 rows
    assert.deepEqual(rowsPerSeq(store), [
      [1, 4],
      [s2, 5],
      [s3, 3],
      [s4, 3],
    ]);
    // 7 rows allowed: seq 4 and 3 fit (6), seq 2 would make 11, so the floor is seq 2.
    assert.deepEqual(store.compact({ maxRows: 7 }), { floorSeq: s2, deleted: 9 });
    assert.equal(floor(store), s2);
    assert.deepEqual(rowsPerSeq(store), [
      [s3, 3],
      [s4, 3],
    ]);
    // 4 rows allowed: seq 4 alone (3) fits, seq 3 does not; the whole of seq 3 goes.
    assert.deepEqual(store.compact({ maxRows: 4 }), { floorSeq: s3, deleted: 3 });
    // A generous limit changes nothing.
    assert.deepEqual(store.compact({ maxRows: 100 }), { floorSeq: s3, deleted: 0 });
  });
});

test('compact by age drops commits older than maxAgeMs on the store clock', () => {
  const { clock, options } = clocked();
  withStore(store => {
    setup(store);
    clock.now += 10 * MINUTE;
    const s2 = page(store, 'a', 1);
    clock.now += 10 * MINUTE;
    const s3 = page(store, 'b', 1);
    clock.now += 10 * MINUTE;
    // Commits at T0 and T0+10m are older than 15 minutes; T0+20m is not.
    assert.deepEqual(store.compact({ maxAgeMs: 15 * MINUTE, maxRows: 1_000 }), {
      floorSeq: s2,
      deleted: 7,
    });
    assert.deepEqual(rowsPerSeq(store), [[s3, 3]]);
    // The commits table is the opId record, never compacted: a replayed commit still answers with its seq.
    assert.deepEqual(store.commit({ opId: 'setup', origin: 'sync', writes: [] }), {
      seq: 1,
      dbEpoch: store.dbEpoch,
      replayed: true,
      changed: 0,
    });
  }, options);
});

test('the defaults keep 50,000 rows and 30 days', () => {
  const { clock, options } = clocked();
  withStore(store => {
    setup(store);
    page(store, 'a', 1);
    clock.now += 29 * 86_400_000;
    assert.deepEqual(store.compact(), { floorSeq: 0, deleted: 0 });
    clock.now += 2 * 86_400_000;
    assert.deepEqual(store.compact(), { floorSeq: 2, deleted: 7 });
  }, options);
});

test('the floor is never lowered and never passes seq', () => {
  const { clock, options } = clocked();
  withStore(store => {
    setup(store);
    const s2 = page(store, 'a', 2);
    assert.equal(store.compact({ maxRows: 0 }).floorSeq, s2);
    assert.equal(store.seq(), s2);
    // A later commit whose rows all fit, and an age limit that reaches nothing, keep the old floor.
    page(store, 'b', 1);
    assert.deepEqual(store.compact({ maxRows: 1_000, maxAgeMs: 1 }), {
      floorSeq: s2,
      deleted: 0,
    });
    // A clock far ahead with an empty log: every commit is old, but the floor stops at seq.
    clock.now += 365 * 86_400_000;
    const empty = store.commit({ opId: 'noop', origin: 'sync', writes: [] });
    assert.equal(empty.changed, 0);
    assert.deepEqual(store.compact({ maxAgeMs: 0 }), { floorSeq: store.seq(), deleted: 3 });
    assert.deepEqual(store.compact({ maxAgeMs: 0, maxRows: 0 }), {
      floorSeq: store.seq(),
      deleted: 0,
    });
    assert.ok(floor(store) <= store.seq());
  }, options);
});

test('changesSince(floor) is fine and changesSince(floor - 1) is refused', () => {
  withStore(store => {
    setup(store);
    const s2 = page(store, 'a', 1);
    const s3 = page(store, 'b', 1);
    store.compact({ maxRows: 3 });
    const at = store.changesSince(s2);
    assert.equal(at.status, 'ok');
    assert.ok(at.status === 'ok');
    assert.deepEqual(new Set(at.changes.map(c => c.seq)), new Set([s3]));
    assert.deepEqual(store.changesSince(s2 - 1), {
      status: 'cannotCalculateChanges',
      floorSeq: s2,
      seq: s3,
    });
  });
});

test('compaction is one transaction: a failure halfway leaves the floor and the rows alone', () => {
  const file = tempDb();
  const real = file.open();
  const store = openStore(real);
  try {
    setup(store);
    page(store, 'a', 2);
    const before = rowsPerSeq(store);
    // The DELETE runs, then the floor UPDATE fails: the DELETE must roll back with it.
    let deletes = 0;
    const failing: SqlDatabase = {
      exec: sql => real.exec(sql),
      close: () => real.close(),
      prepare(sql) {
        if (sql.startsWith('DELETE FROM changes')) deletes++;
        if (sql.startsWith('UPDATE meta')) throw new Error('disk full');
        return real.prepare(sql);
      },
    };
    assert.throws(() => compactChanges(failing, { maxRows: 0, now: T0 }), /disk full/);
    assert.equal(deletes, 1);
    assert.deepEqual(rowsPerSeq(store), before);
    assert.equal(floor(store), 0);
    // And it takes the transaction helper: inside another transaction it is refused, not nested.
    assert.throws(
      () => transaction(real, () => compactChanges(real, { maxRows: 0, now: T0 })),
      NestedTransactionError,
    );
    assert.deepEqual(rowsPerSeq(store), before);
  } finally {
    store.close();
    file.cleanup();
  }
});

test('bad limits are refused', () => {
  withStore(store => {
    assert.throws(() => store.compact({ maxRows: -1 }), StoreError);
    assert.throws(() => store.compact({ maxAgeMs: Number.NaN }), StoreError);
  });
});

test('a restart keeps dbEpoch, the floor, and changesSince from the old token returns only the delta', () => {
  const file = tempDb();
  try {
    let store = openStore(file.open());
    setup(store);
    page(store, 'a', 1);
    const s3 = page(store, 'b', 1);
    store.compact({ maxRows: 3 });
    const token = { dbEpoch: store.dbEpoch, seq: store.seq() };
    store.close();

    store = openStore(file.open());
    try {
      assert.equal(store.dbEpoch, token.dbEpoch);
      assert.equal(store.seq(), s3);
      assert.equal(floor(store), s3 - 1);
      const s4 = store.commit({
        opId: 'after-restart',
        origin: 'sync',
        writes: [{ kind: 'flags', accountId: ACCOUNT, target: { remoteId: 'b-0' }, seen: true }],
      }).seq;
      const delta = store.changesSince(token.seq);
      assert.ok(delta.status === 'ok');
      assert.deepEqual(
        delta.changes.map(c => `${c.seq} ${c.type} ${c.id} ${c.op}`),
        [
          `${s4} Folder ${ACCOUNT}:INBOX u`,
          `${s4} Message ${ACCOUNT}:b-0 u`,
          `${s4} Thread ${ACCOUNT}:b-t0 u`,
        ],
      );
      assert.equal(delta.toSeq, s4);
      assert.equal(store.changesSince(s3 - 2).status, 'cannotCalculateChanges');
    } finally {
      store.close();
    }
  } finally {
    file.cleanup();
  }
});
