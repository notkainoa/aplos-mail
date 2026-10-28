import test from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadAction } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { Caller } from '../../src/methods/types';
import { worldEngine } from './harness';
import { createJournal, rowId, type OpRecord } from '../../src/views/ops';
import { facts, inboxIds, nextOp, openOps, rowOf, settle } from './acts';

/*
 * views-3's `Operation/undo`, `get` and `retry` (DESIGN section 5 rule 11): undo is the inverse operation. Queued, the
 * edit is cancelled and the provider never hears of it; after it synced an inverse is enqueued; a caller without the
 * scope of the operation can do neither. Mirrors the conformance id `undo/restores-thread`.
 */

type T = Awaited<ReturnType<typeof worldEngine>>;
const isType = (type: string) => (e: unknown) => e instanceof ContractError && e.type === type;
const first = async (t: T) => (await inboxIds(t, 'acct-1'))[0]!;

async function act(t: T, id: string, action: ThreadAction) {
  const opId = nextOp('act');
  const receipt = await t.call('Thread/act', { opId, ids: [id], action });
  return { opId, receipt };
}

test('undo while the op is queued cancels it: the thread comes back and the provider hears nothing', async () => {
  const t = await worldEngine(5);
  try {
    const id = await first(t);
    const before = await rowOf(t, id);
    const { opId, receipt } = await act(t, id, { type: 'done' });
    assert.ok(openOps(t.store).length > 0);
    const undoOpId = nextOp('undo');
    const undo = await t.call('Operation/undo', { opId, undoOpId });
    assert.equal(undo.opId, undoOpId);
    assert.ok(undo.appliedState.seq > receipt.appliedState.seq);
    assert.equal(undo.undoable, false);
    assert.deepEqual(openOps(t.store), [], 'the queued edits are cancelled, no inverse is sent');
    const after = await rowOf(t, id);
    assert.deepEqual(facts(after), facts(before));
    assert.ok(after.rev > before.rev, 'revisions only move forward');
    assert.equal(after.workflow.editedAt, before.workflow.editedAt, 'the edit time goes back too');
    assert.ok((await inboxIds(t, 'acct-1')).includes(id));
    const op = (await t.call('Operation/get', { opIds: [opId] })).list[0]!;
    assert.equal(op.state, 'cancelled');
    assert.equal(op.undoable, false);
  } finally {
    await t.close();
  }
});

test('undo after the op synced enqueues the inverse, and the thread is restored at once', async () => {
  const t = await worldEngine(5);
  try {
    const id = await first(t);
    const before = await rowOf(t, id);
    const { opId } = await act(t, id, { type: 'done' });
    const sent = openOps(t.store).length;
    settle(t, 'synced');
    assert.deepEqual(openOps(t.store), [], 'the provider took it');
    assert.equal((await t.call('Operation/get', { opIds: [opId] })).list[0]?.state, 'synced');
    const undoOpId = nextOp('undo');
    await t.call('Operation/undo', { opId, undoOpId });
    const rows = openOps(t.store);
    assert.equal(rows.length, sent, 'one inverse per message edit');
    for (const r of rows) {
      assert.equal(r.state, 'queued');
      assert.equal(r.payload?.change.kind, 'folders');
      assert.deepEqual((r.payload?.change as { add: string[] }).add, ['INBOX']);
      assert.deepEqual((r.payload?.change as { remove: string[] }).remove, []);
      assert.equal(r.scope, 'triage');
    }
    assert.deepEqual(facts(await rowOf(t, id)), facts(before));
    const ops = await t.call('Operation/get', { opIds: [opId, undoOpId] });
    assert.equal(ops.list.find(o => o.opId === opId)?.state, 'cancelled');
    assert.equal(ops.list.find(o => o.opId === undoOpId)?.state, 'queued');
    assert.equal(ops.list.find(o => o.opId === undoOpId)?.undoable, false);
  } finally {
    await t.close();
  }
});

test('an op in flight or of unknown outcome is not cancelled: the inverse follows it', async () => {
  for (const mode of ['inflight', 'uncertain'] as const) {
    const t = await worldEngine(5);
    try {
      const id = await first(t);
      const before = await rowOf(t, id);
      const { opId } = await act(t, id, { type: 'done' });
      const original = openOps(t.store).map(r => r.opId);
      if (mode === 'inflight') settle(t, 'inflight');
      else
        t.commit(
          original.map(opId => ({
            kind: 'opSettle',
            opId,
            state: 'queued',
            attempts: 1,
            lastError: 'uncertain',
          })),
          'sync',
        );
      await t.call('Operation/undo', { opId, undoOpId: nextOp('undo') });
      const rows = openOps(t.store);
      assert.deepEqual(
        rows.slice(0, original.length).map(r => r.opId),
        original,
        `${mode}: the original stays queued ahead of its inverse`,
      );
      assert.equal(rows.length, original.length * 2);
      assert.deepEqual(facts(await rowOf(t, id)), facts(before));
    } finally {
      await t.close();
    }
  }
});

test('a failed op is given up by undo, and its local effect is not applied twice', async () => {
  const t = await worldEngine(5);
  try {
    const id = await first(t);
    const before = await rowOf(t, id);
    const { opId } = await act(t, id, { type: 'done' });
    settle(t, 'failed', undefined, 'invalidPayload');
    await t.call('Operation/undo', { opId, undoOpId: nextOp('undo') });
    assert.deepEqual(openOps(t.store), []);
    assert.deepEqual(facts(await rowOf(t, id)), facts(before));
  } finally {
    await t.close();
  }
});

const LATER = Date.UTC(2026, 10, 3, 9);
const ACTIONS: ThreadAction[] = [
  { type: 'done' },
  { type: 'later', until: LATER },
  { type: 'later' },
  { type: 'trash' },
  { type: 'spam' },
  { type: 'read' },
  { type: 'unread' },
  { type: 'flag', on: true },
  { type: 'bookmark', on: true },
  { type: 'due', date: '2026-10-29' },
  { type: 'reminder', at: LATER },
  { type: 'lane', lane: 'low' },
  { type: 'laneStep', direction: 'up' },
  { type: 'importance', importance: 'important' },
  { type: 'replyStatus', status: 'none' },
  { type: 'todo', text: 'Call back' },
  { type: 'home', hidden: true },
  { type: 'labels', add: ['acct-1:Label_2'], remove: ['acct-1:INBOX'] },
];

test('undo restores the thread for every action, queued and after the provider took it', async () => {
  for (const syncFirst of [false, true]) {
    for (const action of ACTIONS) {
      const t = await worldEngine(13);
      try {
        const id = await first(t);
        // An unread thread, so that `read` changes something.
        const before = await rowOf(t, id);
        const { opId } = await act(t, id, action);
        const changed = await rowOf(t, id);
        if (syncFirst) settle(t, 'synced');
        await t.call('Operation/undo', { opId, undoOpId: nextOp('undo') });
        const after = await rowOf(t, id);
        const label = `${action.type}${syncFirst ? ' after sync' : ' queued'}`;
        if (action.type !== 'unread' && action.type !== 'read')
          assert.notDeepEqual(facts(changed), facts(before), `${label} changed the row`);
        assert.deepEqual(facts(after), facts(before), `undo of ${label} restores the row`);
        assert.ok(after.rev > before.rev, `${label}: revisions only move forward`);
      } finally {
        await t.close();
      }
    }
  }
});

test('undo of trash after sync sends untrash and then the old placements back', async () => {
  const t = await worldEngine(5);
  try {
    const id = await first(t);
    const { opId } = await act(t, id, { type: 'trash' });
    assert.ok(openOps(t.store).every(r => r.payload?.change.kind === 'trash'));
    settle(t, 'synced');
    await t.call('Operation/undo', { opId, undoOpId: nextOp('undo') });
    const kinds = openOps(t.store).map(r => r.payload?.change.kind);
    assert.ok(kinds.includes('untrash') && kinds.includes('folders'));
    assert.ok(kinds.indexOf('untrash') < kinds.indexOf('folders'), 'untrash comes first');
  } finally {
    await t.close();
  }
});

test('a local-only action is undone without the provider', async () => {
  const t = await worldEngine(5);
  try {
    const id = await first(t);
    const before = await rowOf(t, id);
    const { opId } = await act(t, id, { type: 'bookmark', on: true });
    assert.deepEqual(openOps(t.store), []);
    await t.call('Operation/undo', { opId, undoOpId: nextOp('undo') });
    assert.deepEqual(openOps(t.store), []);
    assert.deepEqual(facts(await rowOf(t, id)), facts(before));
  } finally {
    await t.close();
  }
});

test('undo twice, undo of the unknown, and a replayed undoOpId', async () => {
  const t = await worldEngine(5);
  try {
    const id = await first(t);
    const { opId } = await act(t, id, { type: 'done' });
    const undoOpId = nextOp('undo');
    const undo = await t.call('Operation/undo', { opId, undoOpId });
    const seq = t.store.seq();
    assert.deepEqual(await t.call('Operation/undo', { opId, undoOpId }), undo, 'same receipt');
    assert.equal(t.store.seq(), seq, 'and nothing happened twice');
    await assert.rejects(
      t.call('Operation/undo', { opId, undoOpId: nextOp('undo') }),
      isType('conflict'),
    );
    await assert.rejects(
      t.call('Operation/undo', { opId: 'never-made', undoOpId: nextOp('undo') }),
      isType('notFound'),
    );
    // An undo is not itself undoable: acting again is how to redo.
    await assert.rejects(
      t.call('Operation/undo', { opId: undoOpId, undoOpId: nextOp('undo') }),
      isType('conflict'),
    );
  } finally {
    await t.close();
  }
});

const listener = (...scopes: Caller['scopes'][number][]): Caller => ({
  kind: 'listener',
  via: 'socket',
  clientId: 'tool-1',
  scopes,
});

test('scope bypass: a read caller cannot undo or retry a triage operation, and triage cannot reach a send one', async () => {
  const t = await worldEngine(5);
  try {
    const id = await first(t);
    const { opId } = await act(t, id, { type: 'done' });
    const reader = t.engine.connect(listener('read'));
    await assert.rejects(
      reader.call('Operation/undo', { opId, undoOpId: nextOp('undo') }),
      isType('forbidden'),
    );
    await assert.rejects(reader.call('Operation/retry', { opId }), isType('forbidden'));
    assert.ok(openOps(t.store).length > 0, 'nothing was cancelled');
    assert.equal((await rowOf(t, id)).workflow.status, 'done');
    // A triage tool undoes what it did.
    const tool = t.engine.connect(listener('read', 'triage'));
    const own = nextOp('tool');
    await tool.call('Thread/act', { opId: own, ids: [id], action: { type: 'bookmark', on: true } });
    await tool.call('Operation/undo', { opId: own, undoOpId: nextOp('undo') });
    // An operation made with a dearer scope needs it again: seed one as the outbox would.
    t.commit([
      {
        kind: 'op',
        opId: 'send-op',
        accountId: 'acct-1',
        opKind: 'Submission/set',
        targets: [],
        payload: '{}',
        effect: [],
        scope: 'send',
      },
      { kind: 'opSettle', opId: 'send-op', state: 'failed' },
    ]);
    await assert.rejects(
      tool.call('Operation/undo', { opId: 'send-op', undoOpId: nextOp('undo') }),
      isType('forbidden'),
    );
    await assert.rejects(tool.call('Operation/retry', { opId: 'send-op' }), isType('forbidden'));
    const full = t.engine.connect(listener('read', 'triage', 'send'));
    await assert.rejects(
      full.call('Operation/undo', { opId: 'send-op', undoOpId: nextOp('undo') }),
      isType('conflict'),
      'with the scope, an operation this lane did not make still cannot be inverted',
    );
  } finally {
    await t.close();
  }
});

test('retry puts a failed op back in the queue and brings its local effect back', async () => {
  const t = await worldEngine(5);
  try {
    const id = await first(t);
    const { opId } = await act(t, id, { type: 'done' });
    const queued = openOps(t.store).length;
    await assert.rejects(t.call('Operation/retry', { opId }), isType('conflict'));
    settle(t, 'failed', undefined, 'invalidPayload');
    // Provider truth arrives: the thread is still in the Inbox.
    const remote = id.slice('acct-1:'.length);
    t.commit(
      [
        {
          kind: 'placements',
          accountId: 'acct-1',
          target: { remoteThreadId: remote },
          add: [{ folder: 'INBOX' }],
          remove: [],
        },
      ],
      'sync',
    );
    assert.ok((await inboxIds(t, 'acct-1')).includes(id), 'the row returned to its place');
    assert.equal((await t.call('Operation/get', { opIds: [opId] })).list[0]?.state, 'failed');
    const receipt = await t.call('Operation/retry', { opId });
    assert.equal(receipt.opId, opId);
    assert.equal(openOps(t.store).length, queued);
    assert.ok(openOps(t.store).every(r => r.state === 'queued'));
    assert.ok(!(await inboxIds(t, 'acct-1')).includes(id), 'out of the Inbox again');
    assert.equal((await t.call('Operation/get', { opIds: [opId] })).list[0]?.state, 'queued');
    await assert.rejects(t.call('Operation/retry', { opId: 'never-made' }), isType('notFound'));
  } finally {
    await t.close();
  }
});

const settleWith = (
  t: T,
  ids: readonly string[],
  state: 'queued' | 'failed' | 'inflight',
  attempts: number,
  lastError?: string,
) =>
  t.commit(
    ids.map(opId => ({
      kind: 'opSettle',
      opId,
      state,
      attempts,
      ...(lastError ? { lastError } : {}),
    })),
    'sync',
  );

test('a retried op that was tried before is not cancelled by undo: the inverse follows it', async () => {
  const t = await worldEngine(5);
  try {
    const id = await first(t);
    const before = await rowOf(t, id);
    const { opId } = await act(t, id, { type: 'trash' });
    const original = openOps(t.store).map(r => r.opId);
    settleWith(t, original, 'queued', 1, 'uncertain');
    settleWith(t, original, 'queued', 2, 'unclassified');
    await t.call('Operation/undo', { opId, undoOpId: nextOp('undo') });
    const rows = openOps(t.store);
    assert.deepEqual(
      rows.slice(0, original.length).map(r => r.opId),
      original,
    );
    assert.ok(
      rows.some(r => r.payload?.change.kind === 'untrash'),
      'the provider may have the trash, so the untrash follows it',
    );
    assert.deepEqual(facts(await rowOf(t, id)), facts(before));
  } finally {
    await t.close();
  }
});

test('a failed op that was tried again is given up and its inverse is queued as well', async () => {
  const t = await worldEngine(5);
  try {
    const id = await first(t);
    const { opId } = await act(t, id, { type: 'done' });
    const original = openOps(t.store).map(r => r.opId);
    settleWith(t, original, 'failed', 3, 'invalidPayload');
    await t.call('Operation/undo', { opId, undoOpId: nextOp('undo') });
    const rows = openOps(t.store);
    assert.equal(rows.length, original.length);
    assert.ok(rows.every(r => r.state === 'queued' && !original.includes(r.opId)));
  } finally {
    await t.close();
  }
});

test('an undone op that fails afterwards is not retried, and still shows as failed', async () => {
  const t = await worldEngine(5);
  try {
    const id = await first(t);
    const { opId } = await act(t, id, { type: 'done' });
    const original = openOps(t.store).map(r => r.opId);
    settleWith(t, original, 'inflight', 1);
    await t.call('Operation/undo', { opId, undoOpId: nextOp('undo') });
    settleWith(t, original, 'failed', 2, 'providerDown');
    const op = (await t.call('Operation/get', { opIds: [opId] })).list[0]!;
    assert.equal(op.state, 'failed');
    assert.ok(op.error);
    await assert.rejects(t.call('Operation/retry', { opId }), isType('conflict'));
    assert.ok((await inboxIds(t, 'acct-1')).includes(id), 'the thread stays in the Inbox');
  } finally {
    await t.close();
  }
});

test('an opId belongs to one method: undo of itself, and replays across methods, are refused', async () => {
  const t = await worldEngine(5);
  try {
    const id = await first(t);
    const { opId } = await act(t, id, { type: 'done' });
    await assert.rejects(t.call('Operation/undo', { opId, undoOpId: opId }), isType('validation'));
    assert.ok(!(await inboxIds(t, 'acct-1')).includes(id), 'nothing was undone');
    const other = await act(t, id, { type: 'bookmark', on: true });
    await assert.rejects(
      t.call('Operation/undo', { opId: other.opId, undoOpId: opId }),
      isType('conflict'),
      'a Thread/act commit is not an undo receipt',
    );
    const undoOpId = nextOp('undo');
    await t.call('Operation/undo', { opId, undoOpId });
    await assert.rejects(
      t.call('Thread/act', { opId: undoOpId, ids: [id], action: { type: 'done' } }),
      isType('conflict'),
      'an undo commit is not a Thread/act receipt',
    );
  } finally {
    await t.close();
  }
});

test('undo and retry need every scope among the op rows, not only the journal scope', async () => {
  const t = await worldEngine(5);
  try {
    const id = await first(t);
    const tool = t.engine.connect(listener('read', 'triage'));
    const own = nextOp('tool');
    await tool.call('Thread/act', { opId: own, ids: [id], action: { type: 'bookmark', on: true } });
    t.commit([
      {
        kind: 'op',
        opId: rowId(own, 7),
        accountId: 'acct-1',
        opKind: 'Submission/set',
        targets: [],
        payload: '{}',
        effect: [],
        scope: 'send',
      },
      { kind: 'opSettle', opId: rowId(own, 7), state: 'failed' },
    ]);
    await assert.rejects(
      tool.call('Operation/undo', { opId: own, undoOpId: nextOp('undo') }),
      isType('forbidden'),
    );
    await assert.rejects(tool.call('Operation/retry', { opId: own }), isType('forbidden'));
  } finally {
    await t.close();
  }
});

test('the journal says when it dropped a record too heavy to keep', () => {
  const record = (weightSteps: number): OpRecord => ({
    opId: 'big',
    method: 'Thread/act',
    scope: 'triage',
    targets: [],
    seq: 1,
    createdAt: 0,
    threads: [],
    steps: Array.from({ length: weightSteps }, () => ({}) as never),
    undoable: true,
  });
  const journal = createJournal(10);
  assert.equal(journal.add(record(3)), true);
  assert.equal(journal.add(record(20)), false);
  assert.equal(journal.get('big'), undefined);
});
