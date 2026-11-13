import test from 'node:test';
import assert from 'node:assert/strict';
import type { Frame } from '@aplos/contract';
import type { AccountActorHost, DeadlineRegistry, DeadlineSource } from '../../src/ports';
import {
  incoming,
  openEngine,
  patch,
  splitThread,
  worldEngine,
  type TestEngine,
  type WindowFrame,
} from './harness';
import { BIG_NOW } from './big';
import { makeWorld } from './world';

/*
 * views-2: the live-window engine over a real store. First answers, frames after commits, scrolling, closing,
 * ownership, scope gating by account and type, coalescing, frozen order, sidebar numbers and remote search.
 */

const frameOf = (t: TestEngine, id: string) => t.windowFrames(id).at(-1);

async function withWorld(fn: (t: Awaited<ReturnType<typeof worldEngine>>) => Promise<void>) {
  const t = await worldEngine();
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

/** A thread of the mailbox that is not in `notIn`. */
async function newThread(t: TestEngine, notIn: string[]) {
  const all = await t.call('View/query', { spec: { kind: 'mailbox', role: 'all' }, limit: 200 });
  return all.ids.find(id => !notIn.includes(id))!;
}

/** A thread that arrives newer than everything else, with a message in the Inbox. */
function arrive(t: TestEngine, remoteThreadId: string) {
  return t.commit([incoming(remoteThreadId)], 'sync');
}

test('the first answer is at most 200 body-free ids, newest first, under 150 KB', async () => {
  await withWorld(async t => {
    const win = await t.call('View/watch', {
      spec: { kind: 'mailbox', role: 'all' },
      limit: 200,
    });
    assert.ok(win.ids.length > 0 && win.ids.length <= 200);
    assert.equal(win.rowType, 'Thread');
    assert.ok(win.total >= win.ids.length);
    assert.equal(win.position, 0);
    assert.ok(JSON.stringify(win).length < 150_000);
    assert.equal(win.state.dbEpoch, t.store.dbEpoch);
    const query = await t.call('View/query', {
      spec: { kind: 'mailbox', role: 'all' },
      limit: 200,
    });
    assert.deepEqual(win.ids, query.ids, 'a one-shot read and a watch agree');
    assert.equal('windowId' in query, false, 'a one-shot read opens no window');
    assert.equal(t.views.stats.windows, 1);
  });
});

test('a watch caps its limit at 200 and defaults below it', async () => {
  const t = await openEngine((await bigStore()).store);
  try {
    const dflt = await t.call('View/watch', { spec: { kind: 'mailbox', role: 'all' } });
    assert.equal(dflt.ids.length, 100);
    const capped = await t.call('View/watch', {
      spec: { kind: 'mailbox', role: 'all' },
      limit: 200,
    });
    assert.equal(capped.ids.length, 200);
    assert.ok(JSON.stringify(capped).length < 150_000);
  } finally {
    await t.close();
  }
});

let cache: ReturnType<typeof makeWorld> | undefined;
async function bigStore() {
  cache ??= makeWorld(11, BIG_NOW, 300);
  return cache;
}
test.after(() => cache?.cleanup());

test('a commit that moves a row pushes an ID-only frame, stamped at or after the commit', async () => {
  await withWorld(async t => {
    const win = await t.call('View/watch', { spec: { kind: 'done' } });
    const leaving = win.ids[0]!;
    const result = t.commit([patch(leaving, { status: 'later' })]);
    await t.advance(300);
    const last = frameOf(t, win.windowId);
    assert.ok(last, 'a window frame arrives after a relevant commit');
    assert.ok(!last.ids.includes(leaving), 'the thread left the Done view');
    assert.equal(last.total, win.total - 1);
    assert.ok(last.seq >= result.seq, "the frame has reached the commit's state");
    assert.equal(last.dbEpoch, t.store.dbEpoch);
    assert.deepEqual(
      Object.keys(last).filter(k => ['body', 'rows', 'threads'].includes(k)),
      [],
    );
  });
});

test('a row revised inside the window is reported as changed', async () => {
  await withWorld(async t => {
    const win = await t.call('View/watch', { spec: { kind: 'done' } });
    const target = win.ids[1]!;
    t.commit([patch(target, { bookmarked: true })]);
    await t.advance(300);
    const last = frameOf(t, win.windowId);
    assert.ok(last, 'a changed row sends a frame even when the ids did not move');
    assert.ok(last.changed?.includes(target));
  });
});

test('a row that arrives is placed by the view order', async () => {
  await withWorld(async t => {
    const win = await t.call('View/watch', { spec: { kind: 'done' }, limit: 200 });
    const incoming = await newThread(t, win.ids);
    t.commit([patch(incoming, { status: 'done' })]);
    await t.advance(300);
    const last = frameOf(t, win.windowId)!;
    assert.ok(last.ids.includes(incoming));
    const fresh = await t.call('View/query', { spec: { kind: 'done' }, limit: 200 });
    assert.deepEqual(last.ids, fresh.ids, 'the frame is what a fresh read gives');
  });
});

test('View/move scrolls by position, by row and by offset; View/unwatch ends the window', async () => {
  await withWorld(async t => {
    const all = await t.call('View/query', { spec: { kind: 'mailbox', role: 'all' }, limit: 200 });
    const win = await t.call('View/watch', { spec: { kind: 'mailbox', role: 'all' }, limit: 2 });
    assert.deepEqual(win.ids, all.ids.slice(0, 2));
    const moved = await t.call('View/move', { windowId: win.windowId, anchor: { position: 2 } });
    assert.equal(moved.position, 2);
    assert.deepEqual(moved.ids, all.ids.slice(2, 4));
    const next = await t.call('View/move', { windowId: win.windowId, anchor: { offset: 2 } });
    assert.equal(next.position, 4);
    assert.deepEqual(next.ids, all.ids.slice(4, 6));
    const byId = await t.call('View/move', {
      windowId: win.windowId,
      anchor: { id: all.ids[10]! },
    });
    assert.equal(byId.position, 10);
    assert.deepEqual(byId.ids, all.ids.slice(10, 12));
    const back = await t.call('View/move', { windowId: win.windowId, anchor: { position: 3 } });
    assert.deepEqual(back.ids, all.ids.slice(3, 5), 'scrolling back works without OFFSET');
    const past = await t.call('View/move', {
      windowId: win.windowId,
      anchor: { position: 10_000 },
    });
    assert.equal(past.ids.length, 1, 'past the end shows the last row');
    assert.equal(past.ids[0], all.ids.at(-1));
    await t.call('View/unwatch', { windowId: win.windowId });
    await assert.rejects(
      t.call('View/move', { windowId: win.windowId, anchor: { position: 0 } }),
      /no longer open/,
    );
    const before = t.windowFrames(win.windowId).length;
    t.commit([patch(all.ids[0]!, { bookmarked: true })]);
    await t.advance(600);
    assert.equal(t.windowFrames(win.windowId).length, before, 'a closed window gets no frames');
    assert.equal(t.views.stats.windows, 0);
  });
});

test('a scrolled window keeps its place while rows arrive above it', async () => {
  await withWorld(async t => {
    const win = await t.call('View/watch', { spec: { kind: 'done' }, limit: 5 });
    const moved = await t.call('View/move', { windowId: win.windowId, anchor: { position: 5 } });
    arrive(t, 'new-t');
    t.commit([patch('acct-1:new-t', { status: 'done' })]);
    await t.advance(300);
    const full = await t.call('View/query', { spec: { kind: 'done' }, limit: 200 });
    assert.equal(full.ids[0], 'acct-1:new-t', 'the arrival sits at the top of the list');
    const last = frameOf(t, win.windowId);
    const ids = last?.ids ?? moved.ids;
    assert.deepEqual(ids, moved.ids, 'the rows on screen did not shift');
    assert.equal(last?.total, win.total + 1, 'but the total counts the arrival');
  });
});

test('View/move lands on the right rows after rows arrived above the window', async () => {
  await withWorld(async t => {
    const spec = { kind: 'mailbox', role: 'all' } as const;
    const win = await t.call('View/watch', { spec, limit: 5 });
    await t.call('View/move', { windowId: win.windowId, anchor: { position: 50 } });
    for (let i = 0; i < 5; i++) arrive(t, `above-${i}`);
    await t.advance(300);
    const fresh = await t.call('View/query', { spec, limit: 200 });
    const byPosition = await t.call('View/move', {
      windowId: win.windowId,
      anchor: { position: 55 },
    });
    assert.deepEqual(byPosition.ids, fresh.ids.slice(55, 60), 'a position finds the row at it');
    const byRow = await t.call('View/move', {
      windowId: win.windowId,
      anchor: { id: fresh.ids[60]! },
    });
    assert.equal(byRow.position, 60);
    assert.equal(byRow.ids[0], fresh.ids[60], 'a row anchor starts at the row');
  });
});

test('another connection cannot touch a window', async () => {
  await withWorld(async t => {
    const win = await t.call('View/watch', { spec: { kind: 'done' } });
    const other = t.engine.connect();
    await assert.rejects(other.call('View/move', { windowId: win.windowId }), /no longer open/);
    await assert.rejects(
      other.call('View/hold', { windowId: win.windowId, ids: [win.ids[0]!] }),
      /no longer open/,
    );
    await other.call('View/unwatch', { windowId: win.windowId });
    const still = await t.call('View/move', { windowId: win.windowId, anchor: { position: 0 } });
    assert.deepEqual(still.ids, win.ids, 'another connection cannot close it either');
  });
});

test('frames go only to the connection that opened the window', async () => {
  await withWorld(async t => {
    const other = t.engine.connect();
    const seen: Frame[] = [];
    other.subscribe(f => seen.push(f));
    const win = await t.call('View/watch', { spec: { kind: 'done' } });
    t.commit([patch(win.ids[0]!, { status: 'later' })]);
    await t.advance(300);
    assert.ok(frameOf(t, win.windowId));
    assert.equal(seen.filter(f => f.frame === 'window').length, 0);
  });
});

test('windows are gated by account and by type', async () => {
  await withWorld(async t => {
    const all = await t.call('View/query', { spec: { kind: 'mailbox', role: 'all' }, limit: 200 });
    const first = all.ids.find(id => id.startsWith('acct-1:'))!;
    const second = all.ids.find(id => id.startsWith('imap:2:'))!;
    const scoped = await t.call('View/watch', {
      spec: { kind: 'mailbox', role: 'all', accountId: 'acct-1' },
    });
    const drafts = await t.call('View/watch', { spec: { kind: 'drafts' } });
    await t.advance(300);
    const base = t.views.stats.reruns;
    t.commit([patch(second, { bookmarked: true })]);
    await t.advance(600);
    assert.equal(t.windowFrames(scoped.windowId).length, 0, 'another account does not reach it');
    assert.equal(t.views.stats.reruns, base, 'no window ran for another account or type');
    t.commit([patch(first, { bookmarked: true })]);
    await t.advance(600);
    assert.ok(t.views.stats.reruns > base, 'its own account runs the window');
    assert.equal(
      t.windowFrames(drafts.windowId).length,
      0,
      'a thread change does not reach drafts',
    );
  });
});

test('at most four frames a second per window, and the burst settles on the last state', async () => {
  await withWorld(async t => {
    const win = await t.call('View/watch', { spec: { kind: 'done' } });
    const target = win.ids[0]!;
    let seq = 0;
    for (let i = 0; i < 20; i++) {
      seq = t.commit([patch(target, { bookmarked: i % 2 === 0 })]).seq;
      await t.advance(50);
    }
    const during = t.windowFrames(win.windowId).length;
    assert.ok(during >= 2, `frames keep flowing during a burst (${during})`);
    assert.ok(during <= 4, `at most 4 frames in 1 s, saw ${during}`);
    await t.advance(500);
    const last = frameOf(t, win.windowId)!;
    assert.ok(last.seq >= seq, 'the burst settles on a frame at the last change');
  });
});

test('oneByOne keeps the order it was opened with', async () => {
  await withWorld(async t => {
    const spec = { kind: 'oneByOne', section: 'do' } as const;
    const win = await t.call('View/watch', { spec, limit: 200 });
    assert.ok(win.ids.length > 2);
    const [a, b] = win.ids;
    t.commit([patch(a!, { status: 'done' })]);
    await t.advance(300);
    const kept = await t.call('View/move', { windowId: win.windowId, anchor: { position: 0 } });
    assert.deepEqual(
      kept.ids,
      win.ids,
      'a thread handled while stepping does not reshuffle the rest',
    );
    assert.equal(kept.ids[1], b);
  });
});

test('a deleted thread ends its reader window with an error frame', async () => {
  await withWorld(async t => {
    const all = await t.call('View/query', { spec: { kind: 'mailbox', role: 'all' } });
    const threadId = all.ids[0]!;
    const win = await t.call('View/watch', { spec: { kind: 'thread', threadId } });
    assert.equal(win.rowType, 'Message');
    assert.ok(win.ids.length > 0);
    t.commit([{ kind: 'threadDelete', ...splitThread(threadId) }] as never);
    await t.advance(300);
    const last = frameOf(t, win.windowId)!;
    assert.equal(last.error?.type, 'notFound');
    assert.deepEqual(last.ids, []);
    assert.equal(t.views.stats.windows, 0, 'the window stopped');
  });
});

test('Counts/get agrees with the lists it opens, and handledToday counts today only', async () => {
  await withWorld(async t => {
    const counts = await t.call('Counts/get', {});
    const doNow = await t.call('View/query', { spec: { kind: 'homeSection', section: 'do' } });
    const update = await t.call('View/query', { spec: { kind: 'homeSection', section: 'update' } });
    assert.equal(counts.all.do, doNow.total);
    assert.equal(counts.all.update, update.total);
    assert.equal(counts.all.home, doNow.total + update.total);
    const perAccount = Object.values(counts.accounts).reduce((n, b) => n + b.do, 0);
    assert.equal(perAccount, counts.all.do);
    assert.equal(counts.all.handledToday, 0);
    const victim = doNow.ids[0]!;
    t.commit([patch(victim, { status: 'done', editedAt: BIG_NOW - 60_000 })]);
    const after = await t.call('Counts/get', {});
    assert.equal(after.all.handledToday, 1);
    assert.equal(after.all.do, counts.all.do - 1);
    t.commit([patch(victim, { status: 'new', editedAt: BIG_NOW - 30_000 })]);
    const undone = await t.call('Counts/get', {});
    assert.equal(undone.all.handledToday, 0, 'undo subtracts');
    assert.ok(Object.keys(undone.folders).length > 0);
  });
});

test('Folder/get lists labels and folders with unread thread counts', async () => {
  await withWorld(async t => {
    const folders = await t.call('Folder/get', {});
    const inbox = folders.list.find(f => f.role === 'inbox' && f.accountId === 'acct-1')!;
    assert.equal(inbox.id, 'acct-1:INBOX');
    const unread = t.store.read(
      q =>
        q.get<{ n: number }>(
          `SELECT count(*) AS n FROM thread_folders tf JOIN folders f ON f.id = tf.folder_id
           WHERE f.account_id = 'acct-1' AND f.remote_id = 'INBOX' AND tf.unread > 0`,
        )!.n,
    );
    assert.ok(unread > 0);
    assert.equal(inbox.unread, unread);
    const one = await t.call('Folder/get', { accountId: 'imap:2' });
    assert.ok(one.list.length > 0 && one.list.every(f => f.accountId === 'imap:2'));
    assert.equal(folders.state.dbEpoch, t.store.dbEpoch);
  });
});

test('SenderGroup/get serves the rows of a lowSenders window', async () => {
  await withWorld(async t => {
    const win = await t.call('View/watch', { spec: { kind: 'lowSenders' } });
    assert.equal(win.rowType, 'SenderGroup');
    assert.ok(win.ids.length > 0);
    const got = await t.call('SenderGroup/get', { ids: [...win.ids, 'sender:nobody@nowhere'] });
    assert.deepEqual(got.notFound, ['sender:nobody@nowhere']);
    assert.deepEqual(
      got.list.map(g => g.id),
      win.ids,
    );
    const by = await t.call('View/query', { spec: { kind: 'lowBySender' }, limit: 200 });
    for (const g of got.list) {
      const section = by.sections.find(s => s.key === g.address)!;
      assert.equal(g.count, section.count);
      assert.equal(g.latestThreadId, by.ids[section.start]);
    }
  });
});

test('a lowSenders window reports a sender group whose count changed', async () => {
  await withWorld(async t => {
    const win = await t.call('View/watch', { spec: { kind: 'lowSenders' }, limit: 200 });
    const by = await t.call('View/query', { spec: { kind: 'lowBySender' }, limit: 200 });
    const crowd = by.sections.find(s => s.count >= 2)!;
    assert.ok(crowd, 'a sender with several Low threads exists in the seeded mailbox');
    const group = `sender:${crowd.key}`;
    assert.ok(win.ids.includes(group));
    t.commit([patch(by.ids[crowd.start]!, { lane: 'update' })]);
    await t.advance(300);
    const last = frameOf(t, win.windowId);
    assert.ok(last?.changed?.includes(group), 'the group whose count moved is changed');
  });
});

test('a coarse commit marks every shown row of a reader window as changed', async () => {
  await withWorld(async t => {
    const all = await t.call('View/query', { spec: { kind: 'mailbox', role: 'all' } });
    const threadId = all.ids[0]!;
    const { accountId, remoteThreadId } = splitThread(threadId);
    const win = await t.call('View/watch', { spec: { kind: 'thread', threadId } });
    const first = win.ids[0]!;
    const before = t.store.seq();
    t.store.commit({
      opId: 'coarse-seen',
      origin: 'sync',
      step: 'backfill',
      changes: 'coarse',
      writes: [
        incoming(remoteThreadId, {
          accountId,
          remoteId: first.slice(accountId.length + 1),
          seen: false,
          date: BIG_NOW - 5,
        }),
      ],
    });
    assert.ok(t.store.seq() > before, 'the commit landed');
    await t.advance(300);
    const last = frameOf(t, win.windowId);
    assert.ok(last?.changed?.includes(first), 'a coarse change reaches the rows it might have hit');
  });
});

test('a connection past its window share has its oldest window ended with an error frame', async () => {
  await withWorld(async t => {
    const first = await t.call('View/watch', { spec: { kind: 'done' }, limit: 1 });
    for (let i = 0; i < 64; i++) await t.call('View/watch', { spec: { kind: 'done' }, limit: 1 });
    const last = frameOf(t, first.windowId);
    assert.equal(last?.error?.type, 'notFound', 'the evicted window is told, not dropped');
    assert.deepEqual(last?.ids, []);
    assert.equal(t.views.stats.windows, 64);
  });
});

test('the engine-wide window cap ends another connection oldest window with an error frame', async () => {
  await withWorld(async t => {
    const others = Array.from({ length: 8 }, () => t.engine.connect());
    const seen = others.map(c => {
      const frames: Frame[] = [];
      c.subscribe(f => frames.push(f));
      return frames;
    });
    const spec = { kind: 'done' } as const;
    const firsts = await Promise.all(others.map(c => c.call('View/watch', { spec, limit: 1 })));
    for (const c of others)
      for (let i = 1; i < 64; i++) await c.call('View/watch', { spec, limit: 1 });
    assert.equal(t.views.stats.windows, 512);
    await t.call('View/watch', { spec, limit: 1 });
    const stopped = seen[0]!.filter(f => f.frame === 'window' && f.error);
    assert.equal(stopped.length, 1, 'the oldest window of another connection is told');
    assert.equal(
      (stopped[0] as WindowFrame).windowId,
      (firsts[0] as { windowId: string }).windowId,
    );
  });
});

test('Search/remote asks the provider and the results join the search window', async () => {
  const world = makeWorld(5, BIG_NOW, 60);
  const asked: string[] = [];
  const accounts = {
    search: async (account: string, query: { text: string }) => {
      asked.push(`${account}:${query.text}`);
      return { remoteThreadIds: [] };
    },
  } as unknown as AccountActorHost;
  const t = await openEngine(world.store, { ports: { accounts } });
  try {
    const win = await t.call('View/watch', { spec: { kind: 'search', query: { text: 'garden' } } });
    const res = await t.call('Search/remote', { opId: 'op-1', query: { text: 'garden' } });
    const again = await t.call('Search/remote', { opId: 'op-1', query: { text: 'garden' } });
    assert.equal(again.runId, res.runId, 'a repeated opId is the same run');
    await t.advance(10);
    assert.deepEqual(asked.sort(), ['acct-1:garden', 'imap:2:garden']);
    const progress = t.frames.filter(f => f.frame === 'progress');
    assert.equal(progress.at(-1)?.kind, 'done');
    // The provider commits what it found as `origin='search'` rows, as the real host does (step 'search'): a thread in
    // no local list. The commit indexes them, and the window picks the thread up like any commit (fix-search: before,
    // nothing wrote the index and the search kind's visibility left search-only threads out).
    t.store.commit({
      opId: 'found',
      origin: 'sync',
      step: 'search',
      writes: [incoming('found-t')],
    });
    await t.advance(300);
    assert.ok(frameOf(t, win.windowId)?.ids.includes('acct-1:found-t'));
    const inbox = await t.call('View/query', {
      spec: { kind: 'mailbox', role: 'inbox' },
      limit: 200,
    });
    assert.ok(!inbox.ids.includes('acct-1:found-t'), 'a search hit stays out of the lists');
  } finally {
    await t.close();
    world.cleanup();
  }
});

test('Search/remote failure ends the search window with WindowBody.error', async () => {
  await withWorld(async t => {
    const win = await t.call('View/watch', { spec: { kind: 'search', query: { text: 'garden' } } });
    const other = await t.call('View/watch', {
      spec: { kind: 'search', query: { text: 'other' } },
    });
    const scoped = await t.call('View/watch', {
      spec: { kind: 'search', query: { text: 'garden' }, accountId: 'imap:2' },
    });
    await t.call('Search/remote', { opId: 'op-2', query: { text: 'garden' } });
    await t.advance(10);
    const last = frameOf(t, win.windowId)!;
    assert.equal(last.error?.type, 'unavailable');
    assert.equal(frameOf(t, other.windowId), undefined, 'only the matching search window stops');
    assert.equal(frameOf(t, scoped.windowId), undefined, 'a search over another scope goes on');
    const progress = t.frames.filter(f => f.frame === 'progress');
    assert.equal(progress.at(-1)?.kind, 'error');
  });
});

test('a restore voids windows: a new epoch answers notFound, and a re-run after it sends nothing', async () => {
  await withWorld(async t => {
    const win = await t.call('View/watch', { spec: { kind: 'done' } });
    const store = t.store as { dbEpoch: string };
    const real = store.dbEpoch;
    const before = t.windowFrames(win.windowId).length;
    Object.defineProperty(t.store, 'dbEpoch', { value: 'other-epoch', configurable: true });
    try {
      t.commit([patch(win.ids[0]!, { status: 'later' })]);
      await t.advance(600);
      const after = t.windowFrames(win.windowId).filter(f => f.dbEpoch === 'other-epoch');
      assert.equal(after.length, 0, 'a window of the old epoch does not answer in the new one');
      assert.equal(t.windowFrames(win.windowId).length, before);
      await assert.rejects(
        t.call('View/move', { windowId: win.windowId, anchor: { position: 0 } }),
        /no longer open/,
      );
      assert.equal(t.views.stats.windows, 0, 'the window was dropped');
    } finally {
      Object.defineProperty(t.store, 'dbEpoch', { value: real, configurable: true });
    }
  });
});

test('a View/move to a row that is not in the list answers notFound', async () => {
  await withWorld(async t => {
    const win = await t.call('View/watch', { spec: { kind: 'done' } });
    await assert.rejects(
      t.call('View/move', { windowId: win.windowId, anchor: { id: 'acct-1:no-such-thread' } }),
      /not in this list/,
    );
  });
});

test('windows below a compacted log are voided with a reset frame', async () => {
  await withWorld(async t => {
    const win = await t.call('View/watch', { spec: { kind: 'done' } });
    const first = win.ids[0]!;
    t.commit([patch(first, { bookmarked: true })]);
    t.store.compact({ maxRows: 1, maxAgeMs: 0 });
    t.commit([patch(first, { bookmarked: false })]);
    t.store.compact({ maxRows: 1, maxAgeMs: 0 });
    await t.advance(300);
    const reset = t.frames.find(f => f.frame === 'reset');
    assert.ok(reset, 'a reset frame arrives');
    await assert.rejects(
      t.call('View/move', { windowId: win.windowId, anchor: { position: 0 } }),
      /no longer open/,
    );
  });
});

test('with the timer loop injected, the views module is one deadline source and runs when it fires', async () => {
  const world = makeWorld(5, BIG_NOW, 60);
  const sources: DeadlineSource[] = [];
  const deadlines: DeadlineRegistry = {
    register: source => (
      sources.push(source),
      () => void sources.splice(sources.indexOf(source), 1)
    ),
    changed: () => undefined,
  };
  const t = await openEngine(world.store, { ports: { deadlines } });
  try {
    // Other lanes (the outbox) register their own sources; this test is about the views source only.
    assert.equal(
      sources.filter(s => s.id === 'views').length,
      0,
      'no views source while no window is open',
    );
    const win = await t.call('View/watch', { spec: { kind: 'done' } });
    const source = sources.find(s => s.id === 'views')!;
    assert.ok(source, 'a window registers the views source');
    t.commit([patch(win.ids[0]!, { status: 'later' })]);
    await t.clock.advance(300);
    assert.equal(t.windowFrames(win.windowId).length, 0, 'nothing runs on its own clock timer');
    assert.equal(typeof (await source.next()), 'number');
    await source.fire(t.clock.now());
    assert.equal(t.windowFrames(win.windowId).length, 1);
    await t.call('View/unwatch', { windowId: win.windowId });
    assert.equal(await source.next(), undefined, 'no deadline once the last window closes');
  } finally {
    await t.close();
    world.cleanup();
  }
});

test('a repeated query joins the running search; a throttled account cools down before it is asked again', async () => {
  const world = makeWorld(5, BIG_NOW, 60);
  const calls: string[] = [];
  // The first provider call holds its round open on a real gate, so the second Return must join it.
  let release!: () => void;
  const blocker = new Promise<void>(resolve => (release = resolve));
  let asked = 0;
  const accounts = {
    search: async (account: string, query: { text: string }) => {
      calls.push(`${account}:${query.text}`);
      if (asked++ === 0) await blocker;
      return { remoteThreadIds: [] };
    },
  } as unknown as AccountActorHost;
  const t = await openEngine(world.store, { ports: { accounts } });
  try {
    // Two Returns on the same query while the first runs: the second joins, not fans out.
    const a = t.call('Search/remote', { opId: 'c1', query: { text: 'garden' } });
    const b = t.call('Search/remote', { opId: 'c2', query: { text: 'garden' } });
    const [ra, rb] = await Promise.all([a, b]);
    await t.advance(10);
    release();
    await t.advance(10);
    assert.deepEqual(
      calls.sort(),
      ['acct-1:garden', 'imap:2:garden'],
      'two Enters, one provider round',
    );
    assert.notEqual(ra.runId, rb.runId, 'each caller still gets its own run');
  } finally {
    await t.close();
    world.cleanup();
  }
});

test('a throttled search answer cools the account; the next search fails fast locally', async () => {
  const world = makeWorld(5, BIG_NOW, 60);
  const calls: string[] = [];
  const { ProviderError } = await import('../../src/ports');
  const accounts = {
    search: async (account: string, query: { text: string }) => {
      calls.push(`${account}:${query.text}`);
      if (account === 'acct-1')
        throw new ProviderError({
          class: 'throttle',
          reason: 'rateLimitExceeded',
          retryAfterMs: 60_000,
        } as never);
      return { remoteThreadIds: [] };
    },
  } as unknown as AccountActorHost;
  const t = await openEngine(world.store, { ports: { accounts } });
  try {
    await t.call('Search/remote', { opId: 'p1', query: { text: 'garden' } });
    await t.advance(10);
    // Inside the pause: the cooled account is skipped, but a healthy one is still asked.
    await t.call('Search/remote', { opId: 'p2', query: { text: 'garden' } });
    await t.advance(10);
    assert.deepEqual(
      calls.filter(c => c === 'acct-1:garden'),
      ['acct-1:garden'],
      'the paused account is not re-asked',
    );
    assert.deepEqual(
      calls.filter(c => c === 'imap:2:garden'),
      ['imap:2:garden'],
    );
    // A healthy account answered but one was skipped: the run says so (partial), it does not end `done` as if nothing
    // were missing, and it carries when the skipped account is asked again.
    const last = t.frames.filter(f => f.frame === 'progress').at(-1) as {
      kind?: string;
      problem?: { reasonCode?: string; resumeAt?: number };
    };
    assert.equal(last?.kind, 'error');
    assert.equal(last?.problem?.reasonCode, 'paused');
    assert.ok((last?.problem?.resumeAt ?? 0) > t.clock.now(), 'resumeAt is ahead of now');
  } finally {
    await t.close();
    world.cleanup();
  }
});

test('every account cooled down: the whole run fails fast as paused, nothing asked', async () => {
  const world = makeWorld(5, BIG_NOW, 60);
  const calls: string[] = [];
  const { ProviderError } = await import('../../src/ports');
  const accounts = {
    search: async (account: string, query: { text: string }) => {
      calls.push(`${account}:${query.text}`);
      // A refusal that cools only the account that got it (the project-wide kind is in remote-pause.test.ts).
      throw new ProviderError({
        class: 'throttle',
        reason: 'rateLimitExceeded',
        retryAfterMs: 60_000,
      } as never);
    },
  } as unknown as AccountActorHost;
  const t = await openEngine(world.store, { ports: { accounts } });
  try {
    await t.call('Search/remote', { opId: 'q1', query: { text: 'garden' } });
    await t.advance(10);
    await t.call('Search/remote', { opId: 'q2', query: { text: 'garden' } });
    await t.advance(10);
    const asked = calls.length;
    assert.deepEqual(
      calls.sort(),
      ['acct-1:garden', 'imap:2:garden'],
      'each account was asked once',
    );
    await t.call('Search/remote', { opId: 'q3', query: { text: 'garden' } });
    await t.advance(10);
    assert.equal(calls.length, asked, 'all accounts cooled: nothing is re-asked');
    const last = t.frames.filter(f => f.frame === 'progress').at(-1);
    assert.equal(last?.kind, 'error');
    assert.equal((last as { problem?: { reasonCode?: string } })?.problem?.reasonCode, 'paused');
  } finally {
    await t.close();
    world.cleanup();
  }
});

test('a lazy view chunk that cannot load answers unavailable, never a thrown import', async () => {
  const { lazyViewLoaderForTest } = await import('../../src/views/registry');
  // `plans` has not loaded in this process: swap its loader for one that rejects (a missing chunk).
  lazyViewLoaderForTest('plans', () => Promise.reject(new Error('chunk missing')));
  await withWorld(async t => {
    const body = await t
      .call('View/watch', { spec: { kind: 'plans' } })
      .then(() => undefined)
      .catch(e => e as { type?: string });
    assert.equal((body as { type?: string })?.type, 'unavailable');
  });
});

test('a Reconnect-state account is needsReauth, never the throttle copy', async () => {
  const world = makeWorld(5, BIG_NOW, 60);
  const { PausedError, ProviderError } = await import('../../src/ports');
  const accounts = {
    search: async (account: string) => {
      if (account === 'acct-1')
        throw new PausedError(account as never, 'interactive' as never, 'auth', 'reconnect');
      if (account === 'imap:2')
        throw new ProviderError({ class: 'auth', reason: 'authError' } as never);
      return { remoteThreadIds: [] };
    },
  } as unknown as AccountActorHost;
  const t = await openEngine(world.store, { ports: { accounts } });
  try {
    const win = await t.call('View/watch', {
      spec: { kind: 'search', query: { text: 'receipt' } },
    });
    await t.call('Search/remote', { opId: 'a1', query: { text: 'receipt' } });
    await t.advance(10);
    const last = frameOf(t, win.windowId)!;
    assert.equal(last.error?.type, 'needsReauth', 'an auth refusal is not a rate limit');
    const progress = t.frames.filter(f => f.frame === 'progress').at(-1);
    assert.equal(
      (progress as { problem?: { reasonCode?: string } })?.problem?.reasonCode,
      'auth.reconnect',
    );
  } finally {
    await t.close();
    world.cleanup();
  }
});

test('concurrent watchers of a lazy kind share the one load', async () => {
  const { lazyViewLoaderForTest } = await import('../../src/views/registry');
  let loads = 0;
  // `events` is unloaded in this process: a slow gated loader proves the second watcher joins the first.
  // The loader registers a stub plan itself — importing the real module would register every kind in it.
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  lazyViewLoaderForTest('events', async () => {
    loads += 1;
    await gate;
    const { registerViewKind } = await import('../../src/views/registry');
    registerViewKind('events', () => ({
      kind: 'events',
      rowType: 'Event',
      layout: () => ({ total: 0, sections: [] }),
      rows: () => [],
      locate: () => undefined,
      statements: () => [],
    }));
  });
  await withWorld(async t => {
    const spec = { kind: 'events' as const, from: 0, to: 86_400_000 };
    const a = t.call('View/watch', { spec });
    const b = t.call('View/watch', { spec });
    await t.advance(10);
    release();
    await Promise.all([a, b]);
    assert.equal(loads, 1, 'two watchers, one chunk load');
  });
});

test('a lazy view chunk that cannot load answers unavailable, never a thrown import', async () => {
  const { lazyViewLoaderForTest } = await import('../../src/views/registry');
  // `plans` has not loaded in this process: swap its loader for one that rejects (a missing chunk).
  lazyViewLoaderForTest('plans', () => Promise.reject(new Error('chunk missing')));
  await withWorld(async t => {
    const body = await t
      .call('View/watch', { spec: { kind: 'plans' } })
      .then(() => undefined)
      .catch(e => e as { type?: string });
    assert.equal((body as { type?: string })?.type, 'unavailable');
    // The rejection is not cached: a loader that later resolves serves the next watcher.
    lazyViewLoaderForTest('plans', async () => {
      const { registerViewKind } = await import('../../src/views/registry');
      registerViewKind('plans', () => ({
        kind: 'plans',
        rowType: 'Event',
        layout: () => ({ total: 0, sections: [] }),
        rows: () => [],
        locate: () => undefined,
        statements: () => [],
      }));
    });
    const ok = await t
      .call('View/watch', { spec: { kind: 'plans' } })
      .then(() => 'ok')
      .catch(() => 'fail');
    assert.equal(ok, 'ok', 'a call after the rejection retries the load');
  });
});
