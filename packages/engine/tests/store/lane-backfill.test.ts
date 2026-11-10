import test from 'node:test';
import assert from 'node:assert/strict';
import { laneFor } from '../../src/ai/lanes';
import { openStore, type StorePort } from '../../src/store';
import { ACCOUNT, T0, accountWrite, folderWrites, msg, tempDb } from './helpers';

/*
 * Mail that synced before `laneFor` was wired (the owner's real mailbox on 2026-11-10) kept the schema default lane
 * `do` for good. The store now catches those threads up, a bounded batch per commit, and never touches a rank the
 * owner, a rule or the AI set.
 */

const lanesOf = (store: StorePort) =>
  Object.fromEntries(
    store.read(q =>
      q
        .all<{ id: string; lane: string; rank_source: string }>(
          'SELECT t.remote_id AS id, w.lane, w.rank_source FROM thread_workflow w JOIN threads t ON t.id = w.thread_id',
        )
        .map(r => [r.id, `${r.lane}/${r.rank_source}`]),
    ),
  );

const newsletter = (id: string, thread: string, minutes: number) =>
  msg(id, thread, minutes, {
    from: { address: 'no-reply@news.example', name: 'News' },
    hdr: { bulk: true, list: true },
  });

const setup = () => ({
  opId: 'setup',
  origin: 'sync' as const,
  writes: [accountWrite, ...folderWrites],
});

test('threads stored before laneFor existed are re-ranked on the next commit, and user ranks are left alone', () => {
  const file = tempDb();
  try {
    const before = openStore(file.open(), { now: () => T0 });
    before.commit(setup());
    before.commit({
      opId: 'old',
      origin: 'sync',
      writes: [
        newsletter('m1', 'news', 1),
        msg('m2', 'person', 2),
        msg('m3', 'pinned', 3, { from: { address: 'no-reply@pinned.example' } }),
      ],
    });
    before.commit({
      opId: 'pin',
      origin: 'local',
      writes: [
        {
          kind: 'workflow',
          accountId: ACCOUNT,
          remoteThreadId: 'pinned',
          patch: { rankSource: 'user', lane: 'do' },
        },
      ],
    });
    assert.deepEqual(lanesOf(before), {
      news: 'do/heuristic',
      person: 'do/heuristic',
      pinned: 'do/user',
    });
    before.close();

    const after = openStore(file.open(), { now: () => T0, ingest: { laneFor } });
    assert.equal(lanesOf(after).news, 'do/heuristic', 'nothing is ranked until a commit runs');
    after.commit({ opId: 'tick', origin: 'sync', writes: [msg('m4', 'fresh', 4)] });
    assert.deepEqual(lanesOf(after), {
      news: 'low/heuristic',
      person: 'do/heuristic',
      pinned: 'do/user',
      fresh: 'do/heuristic',
    });
    after.close();
  } finally {
    file.cleanup();
  }
});

test('the catch-up runs a bounded batch per commit and then stops', () => {
  const file = tempDb();
  try {
    const before = openStore(file.open(), { now: () => T0 });
    before.commit(setup());
    const threads = Array.from({ length: 450 }, (_, i) => `t${i}`);
    before.commit({
      opId: 'many',
      origin: 'sync',
      writes: threads.map((t, i) => newsletter(`m${i}`, t, i)),
    });
    before.close();

    const after = openStore(file.open(), { now: () => T0, ingest: { laneFor } });
    const low = () => Object.values(lanesOf(after)).filter(v => v === 'low/heuristic').length;
    const counts: number[] = [];
    for (const n of [1, 2, 3, 4, 5, 6]) {
      after.commit({ opId: `tick${n}`, origin: 'sync', writes: [msg(`x${n}`, `x${n}`, 1000 + n)] });
      counts.push(low());
      if (n === 1) {
        const lanes = lanesOf(after);
        assert.equal(lanes.t449, 'low/heuristic', 'the newest thread is ranked in the first batch');
        assert.equal(lanes.t0, 'do/heuristic', 'the oldest waits for a later batch');
      }
    }
    // The first batch of 100 holds the commit's own new thread too (it stays `do`), so 99 newsletters are Low.
    assert.deepEqual(
      counts,
      [99, 199, 299, 399, 450, 450],
      'one batch per commit, then only its own mail',
    );
    after.close();
  } finally {
    file.cleanup();
  }
});

test('the catch-up marker is reserved: no commit can write it, and a rank that stays Do is still stamped', () => {
  const file = tempDb();
  try {
    const store = openStore(file.open(), { now: () => T0, ingest: { laneFor } });
    store.commit(setup());
    assert.throws(
      () =>
        store.commit({
          opId: 'stray',
          origin: 'local',
          writes: [{ kind: 'meta', key: 'lane_backfill', value: 'done' }],
        }),
      /reserved|meta/i,
    );
    store.commit({ opId: 'p', origin: 'sync', writes: [msg('m1', 'person', 1)] });
    const stamped = store.read(
      q => q.get<{ ranked_at: number | null }>('SELECT ranked_at FROM thread_workflow')?.ranked_at,
    );
    assert.equal(stamped, T0, 'a thread that stays in Do now was still evaluated');
    store.close();
  } finally {
    file.cleanup();
  }
});

test("the catch-up waits out the owner's own commits, and a store without laneFor never starts it", () => {
  const file = tempDb();
  try {
    const before = openStore(file.open(), { now: () => T0 });
    before.commit(setup());
    before.commit({ opId: 'old', origin: 'sync', writes: [newsletter('m1', 'news', 1)] });
    before.commit({ opId: 'more', origin: 'sync', writes: [msg('m2', 'person', 2)] });
    const marker = (store: StorePort) =>
      store.read(q =>
        q.get<{ value: string }>("SELECT value FROM meta WHERE key = 'lane_backfill'"),
      );
    assert.equal(marker(before), undefined, 'without laneFor the walk never starts');
    before.close();

    const after = openStore(file.open(), { now: () => T0, ingest: { laneFor } });
    after.commit({
      opId: 'pin',
      origin: 'local',
      writes: [
        {
          kind: 'workflow',
          accountId: ACCOUNT,
          remoteThreadId: 'person',
          patch: { status: 'done' },
        },
      ],
    });
    assert.equal(lanesOf(after).news, 'do/heuristic', 'a local commit ranks nothing old');
    assert.equal(marker(after), undefined, 'and does not move the cursor');
    after.commit({ opId: 'tick', origin: 'sync', writes: [msg('m3', 'fresh', 3)] });
    assert.equal(lanesOf(after).news, 'low/heuristic', 'the next sync commit carries the batch');
    after.close();
  } finally {
    file.cleanup();
  }
});

test('only a sync commit carries a batch, and a marker in an unknown format restarts the walk', () => {
  const file = tempDb();
  try {
    const before = openStore(file.open(), { now: () => T0 });
    before.commit(setup());
    before.commit({ opId: 'old', origin: 'sync', writes: [newsletter('m1', 'news', 1)] });
    before.close();

    const after = openStore(file.open(), { now: () => T0, ingest: { laneFor } });
    const stray = (origin: 'system' | 'import') => ({
      opId: `stray-${origin}`,
      origin,
      writes: [msg(`s-${origin}`, `s-${origin}`, 5)],
    });
    after.commit(stray('system'));
    after.commit(stray('import'));
    assert.equal(lanesOf(after).news, 'do/heuristic', 'system and import commits rank nothing old');
    // A marker written by some other build: the next sync commit starts over instead of treating it as finished.
    after.close();
    const db = file.open();
    db.prepare("INSERT INTO meta(key, value) VALUES('lane_backfill', 'v2:whatever')").run();
    db.close();
    const again = openStore(file.open(), { now: () => T0, ingest: { laneFor } });
    again.commit({ opId: 'tick', origin: 'sync', writes: [msg('m9', 'fresh', 9)] });
    assert.equal(lanesOf(again).news, 'low/heuristic');
    again.close();
  } finally {
    file.cleanup();
  }
});
