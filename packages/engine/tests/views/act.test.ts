import test from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadAction } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { AccountActorHost } from '../../src/ports';
import { openStore, type StorePort } from '../../src/store';
import { tempDb } from '../store/helpers';
import { BIG_NOW, populate } from './big';
import { incoming, openEngine, worldEngine, type WindowFrame } from './harness';
import { makeWorld } from './world';
import { facts, inboxIds, nextOp, openOps, rowOf, settle } from './acts';

/*
 * views-3's `Thread/act` (plan 10 E3 item 4): one commit, a receipt at its seq, the provider op in the queue, a selector
 * resolved at the state the owner saw, and a repeated opId that applies nothing twice. Mirrors the conformance ids
 * `receipts/natural-order`, `act/selector`, `envelope/not-found` and `envelope/idempotent-opId`.
 */

const stateOf = (t: Awaited<ReturnType<typeof worldEngine>>) => ({
  dbEpoch: t.store.dbEpoch,
  seq: t.store.seq(),
});

const isType = (type: string) => (e: unknown) => e instanceof ContractError && e.type === type;

/** The first Inbox thread of the account that has an Inbox message, with its Inbox message count. */
async function pickInbox(t: Awaited<ReturnType<typeof worldEngine>>) {
  const id = (await inboxIds(t, 'acct-1'))[0]!;
  return id;
}

test('done is one commit: workflow, local effect and the provider ops land together and the receipt names that seq', async () => {
  const t = await worldEngine(5);
  try {
    const id = await pickInbox(t);
    const before = t.store.seq();
    const receipt = await t.call('Thread/act', {
      opId: nextOp(),
      ids: [id],
      action: { type: 'done' },
    });
    assert.equal(receipt.appliedState.seq, before + 1, 'exactly one commit');
    assert.equal(receipt.appliedState.seq, t.store.seq());
    assert.equal(receipt.appliedState.dbEpoch, t.store.dbEpoch);
    assert.equal(receipt.undoable, true);
    const changes = t.store.changesSince(before);
    assert.equal(changes.status, 'ok');
    if (changes.status === 'ok')
      assert.ok(
        changes.changes.every(c => c.seq === before + 1),
        'every change row is one commit',
      );
    const row = await rowOf(t, id);
    assert.equal(row.workflow.status, 'done');
    assert.ok(!row.labels.includes('acct-1:INBOX'), 'the local effect is already in the row');
    assert.ok(!(await inboxIds(t, 'acct-1')).includes(id));
    const ops = openOps(t.store);
    assert.ok(ops.length > 0 && ops.every(o => o.state === 'queued' && o.scope === 'triage'));
    for (const o of ops) {
      assert.equal(o.payload?.change.kind, 'folders');
      assert.deepEqual((o.payload?.change as { remove: string[] }).remove, ['INBOX']);
    }
  } finally {
    await t.close();
  }
});

test('a window frame follows the receipt and no frame at or past it shows the old list', async () => {
  const t = await worldEngine(5);
  try {
    const win = await t.call('View/watch', { spec: { kind: 'mailbox', role: 'inbox' } });
    const target = win.ids[0]!;
    const receipt = await t.call('Thread/act', {
      opId: nextOp(),
      ids: [target],
      action: { type: 'done' },
    });
    await t.advance(300);
    const frames = t.windowFrames(win.windowId);
    const reached = frames.filter((f: WindowFrame) => f.state.seq >= receipt.appliedState.seq);
    assert.ok(reached.length, 'a frame reaches the receipt');
    assert.ok(reached.every(f => !f.ids.includes(target)));
  } finally {
    await t.close();
  }
});

test('a repeated opId answers the same receipt and applies nothing twice', async () => {
  const t = await worldEngine(5);
  try {
    const id = await pickInbox(t);
    const args = { opId: 'same-op', ids: [id], action: { type: 'done' } as ThreadAction };
    const first = await t.call('Thread/act', args);
    const seq = t.store.seq();
    const queued = openOps(t.store).length;
    const second = await t.call('Thread/act', args);
    assert.deepEqual(second, first);
    assert.equal(t.store.seq(), seq, 'no second commit');
    assert.equal(openOps(t.store).length, queued, 'no second set of provider ops');
  } finally {
    await t.close();
  }
});

test('a selector acts on the view as it was at atState, not on mail that arrived since', async () => {
  const t = await worldEngine(6);
  try {
    const atState = stateOf(t);
    const spec = { kind: 'mailbox', role: 'inbox', accountId: 'acct-1' } as const;
    const seen = await inboxIds(t, 'acct-1');
    assert.ok(seen.length > 3);
    t.commit([incoming('late-thread')], 'sync');
    const late = 'acct-1:late-thread';
    assert.ok((await inboxIds(t, 'acct-1')).includes(late));
    await t.call('Thread/act', {
      opId: nextOp(),
      selector: { spec, atState },
      action: { type: 'done' },
    });
    const left = await inboxIds(t, 'acct-1');
    assert.deepEqual(left, [late], 'everything seen is done; the late arrival is untouched');
    assert.equal((await rowOf(t, late)).workflow.status, 'new');
  } finally {
    await t.close();
  }
});

test('a selector names one section, and a state from another database is refused', async () => {
  const t = await worldEngine(6);
  try {
    const atState = stateOf(t);
    const home = await t.call('View/query', { spec: { kind: 'home' }, limit: 200 });
    const low = home.sections.find(s => s.key === 'low');
    assert.ok(low && low.count > 0, 'the seeded mailbox has a Low band');
    const lowIds = await t.call('View/query', {
      spec: { kind: 'homeSection', section: 'low' },
      limit: 200,
    });
    await t.call('Thread/act', {
      opId: nextOp(),
      selector: { spec: { kind: 'home' }, section: 'low', atState },
      action: { type: 'bookmark', on: true },
    });
    for (const id of lowIds.ids.slice(0, 5))
      assert.equal((await rowOf(t, id)).workflow.bookmarked, true);
    await assert.rejects(
      t.call('Thread/act', {
        opId: nextOp(),
        selector: { spec: { kind: 'home' }, atState: { dbEpoch: 'another', seq: 1 } },
        action: { type: 'done' },
      }),
      isType('stateMismatch'),
    );
    await assert.rejects(
      t.call('Thread/act', {
        opId: nextOp(),
        selector: { spec: { kind: 'drafts' }, atState },
        action: { type: 'done' },
      }),
      isType('unsupported'),
    );
  } finally {
    await t.close();
  }
});

test('unknown ids: Thread/get lists them, Thread/act refuses and applies nothing', async () => {
  const t = await worldEngine(5);
  try {
    const rows = await t.call('Thread/get', { ids: ['no-such-thread', 'acct-1:nope'] });
    assert.deepEqual(rows.notFound, ['no-such-thread', 'acct-1:nope']);
    const id = await pickInbox(t);
    const seq = t.store.seq();
    await assert.rejects(
      t.call('Thread/act', {
        opId: nextOp(),
        ids: [id, 'acct-1:nope'],
        action: { type: 'done' },
      }),
      isType('notFound'),
    );
    assert.equal(t.store.seq(), seq);
    assert.equal(openOps(t.store).length, 0);
    await assert.rejects(
      t.call('Thread/act', { opId: nextOp(), action: { type: 'done' } }),
      isType('validation'),
    );
  } finally {
    await t.close();
  }
});

const LATER = Date.UTC(2026, 10, 3, 9);

/** Each action, what it does to the row, and whether the provider is told. */
const CASES: {
  action: ThreadAction;
  expect: (a: ReturnType<typeof facts>) => boolean;
  ops: boolean;
}[] = [
  { action: { type: 'done' }, expect: f => f.workflow.status === 'done', ops: true },
  {
    action: { type: 'later', until: LATER },
    expect: f => f.workflow.laterUntil === LATER,
    ops: true,
  },
  { action: { type: 'trash' }, expect: f => f.labels.every(l => l.endsWith(':TRASH')), ops: true },
  { action: { type: 'spam' }, expect: f => f.labels.every(l => l.endsWith(':SPAM')), ops: true },
  { action: { type: 'read' }, expect: f => !f.unread, ops: true },
  { action: { type: 'flag', on: true }, expect: f => f.flagged, ops: true },
  { action: { type: 'bookmark', on: true }, expect: f => f.workflow.bookmarked, ops: false },
  { action: { type: 'due', date: '2026-10-28' }, expect: f => f.rank.dueBand === 0, ops: false },
  {
    action: { type: 'reminder', at: LATER },
    expect: f => f.workflow.reminderAt === LATER,
    ops: false,
  },
  {
    action: { type: 'lane', lane: 'low' },
    expect: f => f.rank.lane === 'low' && f.rank.source === 'user',
    ops: false,
  },
  {
    action: { type: 'importance', importance: 'important' },
    expect: f => f.rank.importance === 'important',
    ops: true,
  },
  {
    action: { type: 'replyStatus', status: 'needsReply' },
    expect: f => f.workflow.replyStatus === 'needsReply',
    ops: false,
  },
  {
    action: { type: 'todo', text: 'Send the form' },
    expect: f => f.workflow.todo === 'Send the form',
    ops: false,
  },
  { action: { type: 'home', hidden: true }, expect: f => f.workflow.hiddenFromHome, ops: false },
];

test('every action does its edit in the row and enqueues provider ops only for mail changes', async () => {
  for (const c of CASES) {
    const t = await worldEngine(8);
    try {
      const id = await pickInbox(t);
      await t.call('Thread/act', { opId: nextOp(), ids: [id], action: c.action });
      const f = facts(await rowOf(t, id));
      assert.ok(c.expect(f), `${c.action.type} shows in the row`);
      assert.equal(openOps(t.store).length > 0, c.ops, `${c.action.type} provider ops`);
    } finally {
      await t.close();
    }
  }
});

test('laneStep, restore, labels and clearFromHome', async () => {
  const t = await worldEngine(8);
  try {
    const id = await pickInbox(t);
    const lane = (await rowOf(t, id)).rank.lane;
    await t.call('Thread/act', {
      opId: nextOp(),
      ids: [id],
      action: { type: 'laneStep', direction: 'down' },
    });
    const down = (await rowOf(t, id)).rank;
    assert.equal(down.source, 'user');
    assert.equal(down.lane, lane === 'low' ? 'low' : lane === 'do' ? 'update' : 'low');
    await t.call('Thread/act', { opId: nextOp(), ids: [id], action: { type: 'trash' } });
    await t.call('Thread/act', { opId: nextOp(), ids: [id], action: { type: 'restore' } });
    const restored = await rowOf(t, id);
    assert.ok(
      restored.labels.includes('acct-1:INBOX'),
      'restore puts the thread back in the Inbox',
    );
    assert.ok(restored.labels.every(l => !/:(TRASH|SPAM)$/.test(l)));
    await t.call('Thread/act', {
      opId: nextOp(),
      ids: [id],
      action: {
        type: 'labels',
        add: ['acct-1:Label_2', 'imap:2:Projects'],
        remove: ['acct-1:INBOX'],
      },
    });
    const labelled = await rowOf(t, id);
    assert.ok(labelled.labels.includes('acct-1:Label_2'));
    assert.ok(!labelled.labels.includes('acct-1:INBOX'));
    assert.ok(!labelled.labels.includes('imap:2:Projects'), "another account's folder is ignored");
    const before = t.store.seq();
    await t.call('Thread/act', { opId: nextOp(), ids: [id], action: { type: 'clearFromHome' } });
    assert.equal(
      (await rowOf(t, id)).workflow.hiddenFromHome,
      false,
      'not back from Later: unchanged',
    );
    assert.equal(t.store.seq(), before, 'and nothing was written');
  } finally {
    await t.close();
  }
});

test('Thread/get marks a thread built from one metadata message as partial', async () => {
  const t = await worldEngine(5);
  try {
    const id = (await inboxIds(t, 'acct-1'))[0]!;
    const [account, remote] = ['acct-1', id.slice('acct-1:'.length)];
    t.world.db
      .prepare('UPDATE threads SET complete = 0 WHERE account_id = ? AND remote_id = ?')
      .run(account, remote);
    assert.equal((await rowOf(t, id)).partial, true);
    t.world.db
      .prepare('UPDATE threads SET complete = 1 WHERE account_id = ? AND remote_id = ?')
      .run(account, remote);
    assert.equal((await rowOf(t, id)).partial, false);
  } finally {
    await t.close();
  }
});

test('Thread/why for a Do now thread with a to-do says the sender asked something, never "waiting on you"', async () => {
  const t = await worldEngine(5);
  try {
    const id = await pickInbox(t);
    const [account, remote] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    t.world.db
      .prepare(
        "UPDATE thread_workflow SET lane = 'do', rank_source = 'heuristic', todo = 'Pick a layout' WHERE thread_id = (SELECT id FROM threads WHERE account_id = ? AND remote_id = ?)",
      )
      .run(account, remote);
    const why = await t.call('Thread/why', { threadId: id });
    assert.match(why.sentence, / asked you something: pick a layout\.$/);
    assert.doesNotMatch(why.sentence, /waiting on you/i, 'DESIGN section 10 bans the phrase');
  } finally {
    await t.close();
  }
});

test('Thread/why names the lane, who placed it and quotes the newest incoming message', async () => {
  const t = await worldEngine(5);
  try {
    const id = await pickInbox(t);
    const why = await t.call('Thread/why', { threadId: id });
    assert.equal(why.threadId, id);
    assert.ok(why.sentence.length > 0);
    assert.equal(why.lane, (await rowOf(t, id)).rank.lane);
    await t.call('Thread/act', {
      opId: nextOp(),
      ids: [id],
      action: { type: 'lane', lane: 'low' },
    });
    const moved = await t.call('Thread/why', { threadId: id });
    assert.equal(moved.rankSource, 'user');
    assert.equal(moved.sentence, 'You moved this to Low importance.');
    await assert.rejects(t.call('Thread/why', { threadId: 'acct-1:nope' }), isType('notFound'));
  } finally {
    await t.close();
  }
});

test('ten acts in two seconds give ten receipts and at most one window update per 250 ms', async () => {
  const t = await worldEngine(9);
  try {
    const win = await t.call('View/watch', { spec: { kind: 'mailbox', role: 'inbox' } });
    const times: number[] = [];
    t.session.subscribe(f => {
      if (f.frame === 'window' && f.windowId === win.windowId) times.push(t.clock.now());
    });
    const ids = (await inboxIds(t)).slice(0, 10);
    const receipts = [];
    for (const id of ids) {
      receipts.push(
        await t.call('Thread/act', { opId: nextOp('burst'), ids: [id], action: { type: 'done' } }),
      );
      await t.advance(200);
    }
    await t.advance(500);
    assert.equal(new Set(receipts.map(r => r.opId)).size, 10);
    assert.deepEqual(
      receipts.map(r => r.appliedState.seq),
      [...receipts.map(r => r.appliedState.seq)].sort((a, b) => a - b),
    );
    for (let i = 1; i < times.length; i++)
      assert.ok(times[i]! - times[i - 1]! >= 250, `frames ${i - 1} and ${i} are 250 ms apart`);
    const last = t.windowFrames(win.windowId).at(-1)!;
    assert.ok(
      ids.every(id => !last.ids.includes(id)),
      'the burst settles on the final list',
    );
  } finally {
    await t.close();
  }
});

test('an op the provider took leaves the queue; Operation/get follows it', async () => {
  const t = await worldEngine(5);
  try {
    const id = await pickInbox(t);
    const opId = nextOp();
    await t.call('Thread/act', { opId, ids: [id], action: { type: 'done' } });
    const state = async () => await t.call('Operation/get', { opIds: [opId, 'nope'] });
    let got = await state();
    assert.equal(got.list[0]?.state, 'queued');
    assert.deepEqual(got.notFound, ['nope']);
    assert.deepEqual(got.list[0]?.targets, [id]);
    assert.equal(got.list[0]?.scope, 'triage');
    settle(t, 'inflight');
    assert.equal((await state()).list[0]?.state, 'syncing');
    settle(t, 'failed', undefined, 'invalidPayload');
    got = await state();
    assert.equal(got.list[0]?.state, 'failed');
    assert.ok(got.list[0]?.error);
    settle(t, 'synced');
    assert.equal((await state()).list[0]?.state, 'synced');
    const local = nextOp();
    await t.call('Thread/act', { opId: local, ids: [id], action: { type: 'bookmark', on: true } });
    assert.equal((await t.call('Operation/get', { opIds: [local] })).list[0]?.state, 'applied');
  } finally {
    await t.close();
  }
});

const TIMINGS = process.env.APLOS_VIEWS_TIMINGS;
const BIG_THREADS = Number(process.env.APLOS_VIEWS_THREADS ?? 100_000);

async function bigEngine() {
  const file = tempDb();
  openStore(file.open()).close();
  const raw = file.open();
  populate(raw, BIG_THREADS, false);
  raw.close();
  const store = openStore(file.open(), { now: () => BIG_NOW });
  const t = await openEngine(store);
  return {
    ...t,
    async close() {
      await t.engine.close();
      store.close();
      file.cleanup();
    },
  };
}

// About a minute at 100,000 threads; the numbers are asserted only when asked for, as in the other view budgets.
test(
  `at ${BIG_THREADS} threads Thread/act plus its receipt: p95 under 4 ms`,
  { skip: !TIMINGS },
  async () => {
    const t = await bigEngine();
    try {
      const win = await t.call('View/watch', { spec: { kind: 'mailbox', role: 'inbox' } });
      const spent: number[] = [];
      for (const id of win.ids.slice(0, 200)) {
        const started = performance.now();
        await t.call('Thread/act', { opId: nextOp('timing'), ids: [id], action: { type: 'done' } });
        spent.push(performance.now() - started);
      }
      spent.sort((a, b) => a - b);
      const p95 = spent[Math.floor(spent.length * 0.95)]!;
      console.log(`Thread/act p95 ${p95.toFixed(2)} ms over ${spent.length} acts`);
      assert.ok(p95 < 4, `p95 ${p95} ms`);
    } finally {
      await t.close();
    }
  },
);

// ---------------------------------------------------------------- Thread/open and the account actors

function fakeAccounts(store: StorePort) {
  const opened: { account: string; thread: string; knownCount?: number; lane?: string }[] = [];
  const changed: string[] = [];
  const host = {
    opsChanged: (account: string) => void changed.push(account),
    async openThread(
      account: string,
      thread: string,
      opts: { knownCount?: number; lane?: string },
    ) {
      opened.push({ account, thread, ...opts });
      store.commit({
        opId: `open-${opened.length}`,
        origin: 'sync',
        writes: [{ kind: 'thread', accountId: account, remoteThreadId: thread, complete: true }],
      });
      return { messages: [], costUnits: 0 };
    },
  };
  return { host: host as unknown as AccountActorHost, opened, changed };
}

test('Thread/open serves a complete thread locally, fetches a partial one, and says unavailable without a provider', async () => {
  const world = makeWorld(5, BIG_NOW, 60);
  const accounts = fakeAccounts(world.store);
  const t = await openEngine(world.store, { ports: { accounts: accounts.host } });
  const bareWorld = makeWorld(5, BIG_NOW, 60);
  const bare = await openEngine(bareWorld.store);
  try {
    const id = (await inboxIds(t, 'acct-1'))[0]!;
    const remote = id.slice('acct-1:'.length);
    const set = (complete: number, count: number | null) =>
      world.db
        .prepare(
          'UPDATE threads SET complete = ?, remote_count = ? WHERE account_id = ? AND remote_id = ?',
        )
        .run(complete, count, 'acct-1', remote);
    set(1, 3);
    const local = await t.call('Thread/open', { threadId: id });
    assert.equal(local.complete, true);
    assert.deepEqual(accounts.opened, [], 'a complete thread makes no provider call');
    set(0, 5);
    const fetched = await t.call('Thread/open', { threadId: id });
    assert.equal(fetched.complete, true);
    assert.deepEqual(accounts.opened, [
      { account: 'acct-1', thread: remote, knownCount: 5, lane: 'interactive' },
    ]);
    await assert.rejects(t.call('Thread/open', { threadId: 'acct-1:nope' }), isType('notFound'));
    // No account actors: a complete thread still opens, a partial one answers `unavailable`.
    const other = (await inboxIds(bare, 'acct-1'))[0]!;
    const complete = (n: number) =>
      bareWorld.db
        .prepare('UPDATE threads SET complete = ? WHERE account_id = ? AND remote_id = ?')
        .run(n, 'acct-1', other.slice('acct-1:'.length));
    complete(1);
    assert.equal((await bare.call('Thread/open', { threadId: other })).complete, true);
    complete(0);
    await assert.rejects(bare.call('Thread/open', { threadId: other }), isType('unavailable'));
  } finally {
    await t.close();
    await bare.close();
    world.cleanup();
    bareWorld.cleanup();
  }
});

test('Thread/act tells the account actors which accounts have new ops, once each', async () => {
  const world = makeWorld(5, BIG_NOW, 60);
  const accounts = fakeAccounts(world.store);
  const t = await openEngine(world.store, { ports: { accounts: accounts.host } });
  try {
    const id = (await inboxIds(t, 'acct-1'))[0]!;
    await t.call('Thread/act', { opId: nextOp(), ids: [id], action: { type: 'done' } });
    assert.deepEqual(accounts.changed, ['acct-1']);
    await t.call('Thread/act', {
      opId: nextOp(),
      ids: [id],
      action: { type: 'bookmark', on: true },
    });
    assert.deepEqual(accounts.changed, ['acct-1'], 'a workflow-only action has nothing to drain');
  } finally {
    await t.close();
    world.cleanup();
  }
});

test('labels refuses a folder the account does not have and a system folder, and queues nothing', async () => {
  const t = await worldEngine(5);
  try {
    const id = await pickInbox(t);
    for (const add of ['acct-1:NoSuchLabel', 'acct-1:SENT'])
      await assert.rejects(
        t.call('Thread/act', {
          opId: nextOp(),
          ids: [id],
          action: { type: 'labels', add: [add], remove: [] },
        }),
        isType('validation'),
        add,
      );
    assert.deepEqual(openOps(t.store), []);
    await t.call('Thread/act', {
      opId: nextOp(),
      ids: [id],
      action: { type: 'labels', add: ['acct-1:Label_2'], remove: [] },
    });
  } finally {
    await t.close();
  }
});

test('a selector from a state this database has not reached yet is refused', async () => {
  const t = await worldEngine(6);
  try {
    const atState = { dbEpoch: t.store.dbEpoch, seq: t.store.seq() + 5 };
    await assert.rejects(
      t.call('Thread/act', {
        opId: nextOp(),
        selector: { spec: { kind: 'mailbox', role: 'inbox', accountId: 'acct-1' }, atState },
        action: { type: 'done' },
      }),
      isType('stateMismatch'),
    );
    assert.deepEqual(openOps(t.store), []);
  } finally {
    await t.close();
  }
});
