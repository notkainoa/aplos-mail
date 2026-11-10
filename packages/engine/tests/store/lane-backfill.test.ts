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

const setup = [{ opId: 'setup', origin: 'sync', writes: [accountWrite, ...folderWrites] }] as const;

test('threads stored before laneFor existed are re-ranked on the next commit, and user ranks are left alone', () => {
  const file = tempDb();
  try {
    const before = openStore(file.open(), { now: () => T0 });
    before.commit(setup[0]);
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
    before.commit(setup[0]);
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
    for (const n of [1, 2, 3, 4]) {
      after.commit({ opId: `tick${n}`, origin: 'sync', writes: [msg(`x${n}`, `x${n}`, 1000 + n)] });
      counts.push(low());
    }
    assert.equal(counts[0], 200, 'one commit ranks one batch');
    assert.equal(counts[1], 400);
    assert.equal(counts[2], 450, 'the last batch ends the catch-up');
    assert.equal(counts[3], 450, 'a later commit ranks only its own mail');
    after.close();
  } finally {
    file.cleanup();
  }
});
