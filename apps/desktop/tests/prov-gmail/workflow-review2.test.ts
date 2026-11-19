/**
 * Second review of the workflow channel (WF2-1 to WF2-7): hostile field names, compaction only against a copy read
 * back from Gmail and only a batch at a time, floors from a fast clock, per-account keys and clean headers. Synthetic
 * data and test keys only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RETENTION_MS,
  type JsonValue,
  type WorkflowRecord,
} from '../../src/host/providers/google/workflow-merge';
import { buildCopyMessage } from '../../src/host/providers/google/workflow-message';
import { channelKey } from '../../src/host/providers/google/workflow-seal';
import { COMPACT_BATCH } from '../../src/host/providers/google/workflow-state';
import {
  parseThreadValue,
  threadKey,
  threadValue,
  workflowFacts,
} from '../../src/host/providers/google/workflow-facts';
import { rig, type Rig } from './harness';
import { appLabel, device, plant, sealedCopy, testKey } from './workflow-rig';

const DAY = 86_400_000;
const done = threadValue({ status: 'done' });

const rec = (key: string, at: number, value: JsonValue): WorkflowRecord => ({
  key,
  stamp: { at, gen: 0, device: 'device-x' },
  value,
});

function plantCopies(r: Rig, n: number): void {
  for (let i = 0; i < n; i++) {
    const records = [rec(threadKey(`p${i}`), r.clock.now() + i, done)];
    plant(r, sealedCopy(r, { v: 2, device: 'device-x', writtenAt: 1, records }).raw);
  }
}

const liveCopies = (r: Rig) =>
  r.emu.mailbox.select({ labelIds: [appLabel(r)], q: '', includeSpamTrash: false }).map(m => m.id);

const reasons = (lines: { event: string; fields: Record<string, unknown> }[]) =>
  lines
    .filter(l => l.event === 'sync.gmail.request_refused')
    .map(l => (l.fields.error as { reason: string }).reason);

/** Flips one character inside the armoured sealed blob, as a copy damaged on its way in would be. */
const flipArmour = (raw: string) =>
  raw.replace(
    /(-----BEGIN APLOS WORKFLOW-----\r\n.{40})(.)/,
    (_m, head: string, c: string) => head + (c === 'A' ? 'B' : 'A'),
  );

test('WF2-1 inherited field names are refused as unknown, never called or thrown on', () => {
  for (const name of ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty']) {
    const value = JSON.parse(`{"status":"done","${name}":null}`) as JsonValue;
    assert.equal(parseThreadValue(value), undefined, name);
    const facts = workflowFacts({
      accountId: 'acct',
      records: [rec(threadKey('t1'), 1, value)],
      known: new Set(['t1']),
      local: new Map(),
    });
    assert.deepEqual([facts.writes.length, facts.invalid], [0, 1], name);
  }
});

test('WF2-2 compact trusts only a written copy it read back from Gmail', async () => {
  const r = await rig();
  plantCopies(r, 2);
  const a = device(r, 'device-a', { mangleInsert: flipArmour });
  await a.round();
  await a.channel.write([{ key: threadKey('t9'), value: done }], a.ctx());
  let since = a.governor.calls.length;
  assert.equal(await a.channel.compact(a.ctx()), 0, 'the copy Gmail holds does not open');
  assert.deepEqual(a.methods(since), ['gmail.messages.get'], 'one raw download, no trash');
  assert.ok(reasons(a.log.lines).includes('workflowCopy.damaged'));
  assert.equal(await a.channel.compact(a.ctx()), 0, 'nothing is ever compacted against it');
  assert.equal(liveCopies(r).length, 3);

  a.options.mangleInsert = undefined;
  await a.channel.write([{ key: threadKey('t8'), value: done }], a.ctx());
  since = a.governor.calls.length;
  assert.equal(await a.channel.compact(a.ctx()), 3, 'a copy that read back supersedes the rest');
  assert.equal(a.methods(since).filter(m => m === 'gmail.messages.get').length, 1);
  since = a.governor.calls.length;
  await a.channel.compact(a.ctx());
  assert.deepEqual(a.methods(since), [], 'read back once per written copy');
  const b = device(r, 'device-b');
  assert.deepEqual(
    (await b.round()).records.map(x => x.key),
    [threadKey('p0'), threadKey('p1'), threadKey('t8'), threadKey('t9')],
  );
});

test('WF2-3 compact trashes at most a batch per call, and a first full read is paged over rounds', async () => {
  const r = await rig();
  plantCopies(r, COMPACT_BATCH + 5);
  const a = device(r, 'device-a', { limits: { listPage: 100 } });
  await a.round();
  await a.channel.write([{ key: threadKey('t9'), value: done }], a.ctx());
  const since = a.governor.calls.length;
  assert.equal(await a.channel.compact(a.ctx()), COMPACT_BATCH);
  assert.ok(a.units(since) <= 60 + 25 * 20, `one compact step: ${a.units(since)} units`);
  assert.equal(await a.channel.compact(a.ctx()), 5, 'the rest go next call');
  assert.equal(await a.channel.compact(a.ctx()), 0);
  assert.equal(liveCopies(r).length, 1);

  plantCopies(r, 201);
  const b = device(r, 'device-b');
  await b.round();
  assert.equal(b.channel.view().length, 200, 'the default first read stops at 200 copies');
  assert.equal(b.syncState.cursor, undefined, 'and is not complete yet');
  await b.round();
  assert.equal(b.channel.view().length, 202);
});

test('WF2-4 a device whose clock runs months fast cannot hide records or compact with its floor', async () => {
  const r = await rig();
  const fast = device(r, 'device-f', { skewMs: RETENTION_MS + 30 * DAY });
  await fast.channel.write([{ key: threadKey('t2'), value: done }], fast.ctx());
  // An honest device writes a Later before it has read the fast copy: its stamp is below the fast floor.
  const b = device(r, 'device-b');
  const later = threadValue({ status: 'later', laterUntil: r.clock.now() + DAY });
  await b.channel.write([{ key: threadKey('t1'), value: later }], b.ctx());

  const c = device(r, 'device-c');
  await c.round();
  assert.deepEqual(
    c.channel.view().map(x => x.key),
    [threadKey('t1'), threadKey('t2')],
    'the Later stays visible',
  );
  await fast.round();
  await fast.channel.write([{ key: threadKey('t3'), value: done }], fast.ctx());
  assert.equal(await fast.channel.compact(fast.ctx()), 0, 'its floor would not be honoured');
  assert.ok(reasons(fast.log.lines).includes('workflowCopy.clock'));
  assert.equal(liveCopies(r).length, 3);
});

test('WF2-6 the channel key and kid differ per account; the device header is a hash, not the id', () => {
  const data = testKey('shared');
  const mine = channelKey(data, 'me@example.test');
  assert.equal(channelKey(data, ' ME@example.test ').kid, mine.kid, 'the address is normalised');
  assert.notEqual(channelKey(data, 'you@example.test').kid, mine.kid);
  assert.ok(!channelKey(data, 'you@example.test').key.equals(mine.key));

  const raw = buildCopyMessage(
    { deviceId: 'kainos-laptop.local', writtenAt: 1, data: 'APLOS-WF2.a.b.c' },
    'me@example.test',
  );
  assert.ok(!raw.includes('kainos-laptop'), 'a host-like device id never reaches the mailbox');
  assert.match(raw, /\r\nX-Aplos-Device: d-[0-9a-f]{24}\r\n/);
});

test('WF2-7 an address that could end a header is refused', () => {
  const copy = { deviceId: 'device-a', writtenAt: 1, data: 'APLOS-WF2.a.b.c' };
  for (const address of [
    'me@example.test\r\nBcc: someone@example.test',
    'me@example.test\n',
    'Me <me@example.test>',
    'me example@example.test',
  ])
    assert.throws(() => buildCopyMessage(copy, address), /Invalid account address/, address);
  assert.doesNotThrow(() => buildCopyMessage(copy, "o'brien+aplos@example.test"));
});
