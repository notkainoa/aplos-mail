/**
 * Review findings on the workflow channel (WF-1 to WF-10): the only readable copy is never stranded, retention keeps the
 * view bounded, and no cap, failure or stale label makes a round skip a copy. Synthetic data and test keys only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowWrite } from '@aplos/engine/store';
import { RETENTION_MS, type WorkflowRecord } from '../../src/host/providers/google/workflow-merge';
import { parseCopyMessage, remember } from '../../src/host/providers/google/workflow-message';
import { channelKey, open } from '../../src/host/providers/google/workflow-seal';
import {
  threadKey,
  threadValue,
  workflowCommit,
  workflowFacts,
} from '../../src/host/providers/google/workflow-facts';
import { rig, type Rig } from './harness';
import { RigStore } from './store-rig';
import { appLabel, device, plant, sealedCopy, testKey } from './workflow-rig';

const DAY = 86_400_000;
const done = threadValue({ status: 'done' });

const rec = (key: string, at: number, value: WorkflowRecord['value']): WorkflowRecord => ({
  key,
  stamp: { at, gen: 0, device: 'device-x' },
  value,
});

/** Plants `n` copies of one record each, written by another device. */
function plantCopies(r: Rig, n: number, prefix = 'p'): void {
  for (let i = 0; i < n; i++) {
    const records = [rec(threadKey(`${prefix}${i}`), r.clock.now() + i, done)];
    plant(r, sealedCopy(r, { v: 2, device: 'device-x', writtenAt: 1, records }).raw);
  }
}

/** The record keys inside a stored copy, opened with the shared test key. */
function copyKeys(r: Rig, id: string): string[] {
  const parsed = parseCopyMessage(r.emu.mailbox.rawOf(id).toString('latin1'));
  const opened = open(
    parsed!.data,
    channelKey(testKey('shared'), r.account.address),
    r.account.address,
  );
  assert.ok(opened.ok);
  return (opened.plain as { records: WorkflowRecord[] }).records.map(x => x.key);
}

const liveCopies = (r: Rig) =>
  r.emu.mailbox.select({ labelIds: [appLabel(r)], q: '', includeSpamTrash: false }).map(m => m.id);

test('WF-1 a write over the readers cap is refused and the readable copy is never compacted away', async () => {
  const r = await rig();
  const a = device(r, 'device-a', { maxRecords: 3 });
  await a.channel.write(
    [
      { key: threadKey('t1'), value: done },
      { key: threadKey('t2'), value: done },
    ],
    a.ctx(),
  );
  const readable = liveCopies(r);
  await assert.rejects(
    a.channel.write(
      [
        { key: threadKey('t3'), value: done },
        { key: threadKey('t4'), value: done },
      ],
      a.ctx(),
    ),
    /Too much workflow data/,
  );
  assert.equal(await a.channel.compact(a.ctx()), 0);
  assert.deepEqual(liveCopies(r), readable, 'nothing written, nothing trashed');
  const b = device(r, 'device-b', { maxRecords: 3 });
  assert.equal((await b.round()).records.length, 2, 'another device still reads the old copy');
});

test('WF-1 retention: settled records past 180 days leave new copies, and an older Later cannot come back', async () => {
  // Refresh tokens that do not expire after 7 days, so half a year can pass on the shared clock (Gmail's too).
  const r = await rig({ emulator: { testingMode: false } });
  // Another device's old copy: t1 is Later.
  const t0 = r.clock.now();
  const later = threadValue({ status: 'later', laterUntil: t0 + 365 * DAY });
  const stale = sealedCopy(r, {
    v: 2,
    device: 'device-x',
    writtenAt: 1,
    records: [rec(threadKey('t1'), t0, later)],
  }).raw;
  plant(r, stale);
  const a = device(r, 'device-a');
  await a.round();
  await r.clock.advance(DAY);
  await a.channel.write([{ key: threadKey('t1'), value: done }], a.ctx());
  // Half a year later, for Gmail as well: a floor ahead of Gmail's own clock would not count (WF2-4).
  await r.clock.advance(RETENTION_MS + 10 * DAY);
  await a.round();
  await a.channel.write([{ key: threadKey('t2'), value: done }], a.ctx());
  assert.deepEqual(
    a.channel.view().map(x => x.key),
    [threadKey('t2')],
    'the settled t1 expired from the view',
  );
  assert.equal(await a.channel.compact(a.ctx()), 2, 'the old copies are superseded');
  assert.equal(liveCopies(r).length, 1);
  assert.deepEqual(copyKeys(r, liveCopies(r)[0]), [threadKey('t2')], 'the copy itself is pruned');

  // The stale copy comes back (a device that was offline for half a year writes it again).
  plant(r, stale);
  const fresh = device(r, 'device-c');
  await fresh.round();
  assert.equal(
    fresh.channel.view().find(x => x.key === threadKey('t1')),
    undefined,
  );
  assert.deepEqual(
    fresh.channel.view().map(x => x.key),
    a.channel.view().map(x => x.key),
  );
});

test('WF-2 a history read past the page cap advances to the last record it read', async () => {
  const r = await rig();
  plantCopies(r, 1, 'seed');
  const b = device(r, 'device-b', { limits: { historyPage: 1, historyPages: 1 } });
  await b.round();
  const before = b.syncState.cursor;
  plantCopies(r, 3, 'n');
  await b.round();
  assert.notEqual(b.syncState.cursor, before, 'the cursor moved');
  await b.round();
  await b.round();
  assert.equal(b.channel.view().length, 4, 'every copy read, one history record per round');
});

test('WF-3 a full read longer than the page cap resumes next round and is not complete until done', async () => {
  const r = await rig();
  plantCopies(r, 5);
  const b = device(r, 'device-b', { limits: { listPage: 2, listPages: 1 } });
  await b.round();
  assert.equal(b.channel.view().length, 2);
  assert.equal(b.syncState.cursor, undefined, 'no cursor until the listing is complete');
  await b.round();
  await b.round();
  assert.equal(b.channel.view().length, 5);
  assert.ok(b.syncState.cursor);
});

test('WF-4 bounded maps drop their oldest entry past the cap', () => {
  const map = new Map<string, number>();
  for (let i = 0; i < 5; i++) remember(map, `k${i}`, i, 3);
  assert.deepEqual([...map.keys()], ['k2', 'k3', 'k4']);
  remember(map, 'k2', 9, 3);
  assert.deepEqual([...map.keys()], ['k3', 'k4', 'k2'], 'a refreshed key is newest again');
});

test('WF-6 a put kept across a restart is looked for first when marked as a retry', async () => {
  const r = await rig();
  const a = device(r, 'device-a', { dropNextInsert: true });
  const copy = {
    deviceId: 'device-a',
    writtenAt: r.clock.now(),
    data: sealedCopy(r, { v: 2, device: 'device-a', writtenAt: 1, records: [] }).data,
  };
  await assert.rejects(a.transport.put(copy, a.ctx()));
  const restarted = device(r, 'device-a');
  const id = await restarted.transport.put(copy, restarted.ctx(), { retry: true });
  assert.deepEqual(liveCopies(r), [id], 'one copy');
  assert.equal(restarted.methods().filter(m => m === 'gmail.messages.insert').length, 0);

  const first = device(r, 'device-b');
  const since = first.governor.calls.length;
  await first.channel.write([{ key: threadKey('t'), value: done }], first.ctx());
  assert.ok(
    !first.methods(since).includes('gmail.messages.list'),
    'a first put pays for no lookup',
  );
});

test('WF-7 a permanent download failure is retried before the copy is given up', async () => {
  const r = await rig();
  plantCopies(r, 1);
  const b = device(r, 'device-b', { batch: 1, failGets: { status: 400, times: 1 } });
  const first = await b.round();
  assert.equal(first.records.length, 0);
  assert.equal(b.syncState.pending?.length, 1);
  const second = await b.round();
  assert.equal(second.records.length, 1, 'read on the retry');

  const r2 = await rig();
  plantCopies(r2, 1);
  const c = device(r2, 'device-c', { batch: 1, failGets: { status: 400, times: 9 } });
  for (let i = 0; i < 4; i++) await c.round();
  assert.equal(c.methods().filter(m => m === 'gmail.messages.get').length, 3, 'three tries');
  assert.equal(c.syncState.pending, undefined);
  assert.ok(c.log.lines.some(l => JSON.stringify(l.fields).includes('workflowCopy.unreadable')));
});

test('WF-8 a 404 from history or insert re-resolves the label once', async () => {
  const r = await rig();
  plantCopies(r, 1);
  const b = device(r, 'device-b');
  await b.round();
  plantCopies(r, 1, 'late');
  b.options.history404 = true;
  const since = b.governor.calls.length;
  await b.round();
  assert.ok(b.methods(since).includes('gmail.labels.list'), 'label resolved again');
  assert.equal(b.channel.view().length, 2);

  b.options.insert404 = true;
  const before = liveCopies(r).length;
  const at = b.governor.calls.length;
  await b.channel.write([{ key: threadKey('w'), value: done }], b.ctx());
  assert.equal(liveCopies(r).length, before + 1);
  assert.ok(b.methods(at).includes('gmail.labels.list'));
});

test('WF-9 a fresh replica that applies only the last record equals one that applied every record', async () => {
  const r = await rig({ threads: 3 });
  await r.drive({ scopes: ['history', 'window:inbox'] });
  const thread = [...r.store.threadsIn('INBOX')].sort()[0];
  const fresh = new RigStore(r.account, () => r.clock.now());
  for (const c of r.store.commits) fresh.commit(c.step, c.result, c.at);
  const known = new Set([thread]);
  const apply = (store: RigStore, records: WorkflowRecord[]) => {
    const commit = workflowCommit(
      r.account.id,
      workflowFacts({ accountId: r.account.id, records, known, local: new Map() }),
    );
    if (commit) store.raw.commit(commit);
  };
  const key = threadKey(thread);
  const first = rec(key, 10, threadValue({ status: 'later', laterUntil: 99, todo: 'pay' }));
  const last = rec(key, 20, done);
  apply(r.store, [first]);
  apply(r.store, [last]);
  apply(fresh, [last]);
  const row = (store: RigStore) =>
    store.raw.read(q =>
      q.get(
        `SELECT w.status, w.later_until, w.todo, w.due_date, w.edited_at FROM thread_workflow w
        JOIN threads t ON t.id = w.thread_id WHERE t.remote_id = ?`,
        thread,
      ),
    );
  assert.deepEqual({ ...row(r.store) }, { ...row(fresh) });
  assert.equal((row(r.store) as { todo: string | null }).todo, null, 'the todo was cleared');
  fresh.close();
  const write = workflowFacts({ accountId: 'a', records: [last], known, local: new Map() })
    .writes[0] as WorkflowWrite;
  assert.equal(write.patch.laterUntil, null);
});

test('WF-10 more failed downloads than pending holds keep the cursor, so none is skipped', async () => {
  const r = await rig();
  plantCopies(r, 1, 'seed');
  const b = device(r, 'device-b', {
    batch: 1,
    limits: { maxPending: 1 },
    failGets: { status: 500, times: 0 },
  });
  await b.round();
  const cursor = b.syncState.cursor;
  plantCopies(r, 2, 'n');
  b.options.failGets = { status: 500, times: 2 };
  await b.round();
  assert.equal(b.syncState.cursor, cursor, 'held');
  await b.round();
  assert.equal(b.channel.view().length, 3);
});
