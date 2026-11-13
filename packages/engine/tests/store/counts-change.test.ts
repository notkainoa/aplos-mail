import test from 'node:test';
import assert from 'node:assert/strict';
import type { StorePort } from '../../src/store';
import { observeCommits } from '../../src/runtime/frames';
import { ACCOUNT, accountWrite, folderWrites, msg, withStore } from './helpers';

/*
 * `Counts/get` is re-read by the renderer only when a `state` frame carries the `Counts` type, so every commit that
 * moves a count marks it there. The 2026-11-12 packaged build's stale badges (Home 43 vs 42, Drafts 46 vs 47, a
 * draft saved mid-session never reaching the badge) trace to no such mark existing. The mark is derived at
 * fan-out, not written as a `changes` row — the durable log and `Session/changes` keep only what was written.
 */

/** Commits through `observeCommits`; `types` is what each commit reported to the bus (the `state` frame's keys). */
function observed<T>(
  store: StorePort,
  fn: (store: StorePort, types: Record<string, number>[]) => T,
): T {
  const types: Record<string, number>[] = [];
  const wrapped = observeCommits(store, { changed: t => types.push(t), reset: () => {} });
  return fn(wrapped, types);
}

const setup = (store: StorePort) =>
  store.commit({ opId: 'setup', origin: 'sync', writes: [accountWrite, ...folderWrites] });

test('a message commit marks Counts in the state frame so badges re-read', () => {
  withStore(store => {
    observed(store, (obs, types) => {
      setup(obs);
      types.length = 0;
      obs.commit({ opId: 'page-1', origin: 'sync', writes: [msg('m1', 't1', 0)] });
      assert.ok(
        types.some(t => 'Counts' in t),
        'the frame types carry Counts',
      );
      assert.ok(types.some(t => 'Message' in t));
    });
  });
});

test('a workflow (Done) commit marks Counts', () => {
  withStore(store => {
    observed(store, (obs, types) => {
      setup(obs);
      obs.commit({ opId: 'page-1', origin: 'sync', writes: [msg('m1', 't1', 0)] });
      types.length = 0;
      obs.commit({
        opId: 'done-1',
        origin: 'local',
        writes: [
          {
            kind: 'workflow',
            accountId: ACCOUNT,
            remoteThreadId: 't1',
            patch: { status: 'done' },
          },
        ],
      });
      assert.ok(types.some(t => 'Counts' in t));
      assert.ok(types.some(t => 'Thread' in t));
    });
  });
});

test('a bookkeeping-only commit marks nothing, Counts least of all', () => {
  withStore(store => {
    observed(store, (obs, types) => {
      setup(obs);
      types.length = 0;
      obs.commit({
        opId: 'cursor-1',
        origin: 'sync',
        writes: [
          {
            kind: 'syncState',
            accountId: ACCOUNT,
            scope: 'window:inbox',
            cursor: 'h-100',
            generation: 0,
          },
        ],
      });
      assert.equal(types.length, 0);
    });
  });
});

test('no Counts row lands in the durable changes log', () => {
  withStore(store => {
    setup(store);
    const base = store.seq();
    store.commit({ opId: 'page-1', origin: 'sync', writes: [msg('m1', 't1', 0)] });
    const since = store.changesSince(base);
    assert.equal(since.status, 'ok');
    if (since.status !== 'ok') return;
    assert.ok(!since.changes.some(c => c.type === 'Counts'));
  });
});
