/**
 * The Gmail workflow channel (plan 20 PV3, D17, D18): two simulated devices on the emulator, the sealing, the merge and
 * the store facts. Synthetic data and test keys only; nothing here reaches a live account.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PausedError, type WorkflowCopy } from '@aplos/engine/ports';
import {
  canonical,
  type WorkflowPayload,
  type WorkflowRecord,
} from '../../src/host/providers/google/workflow-merge';
import { channelKey, open, seal } from '../../src/host/providers/google/workflow-seal';
import { createWorkflowStateChannel } from '../../src/host/providers/google/workflow-state';
import {
  threadKey,
  threadValue,
  workflowCommit,
  workflowFacts,
} from '../../src/host/providers/google/workflow-facts';
import { CaptureLog, rig, type Rig } from './harness';
import { appLabel, device, keysOf, plant, sealedCopy, testKey, type Device } from './workflow-rig';

const winner = (records: WorkflowRecord[], key: string) => records.find(r => r.key === key);
const valueOf = (d: Device, key: string) => winner(d.channel.view(), key)?.value;
const viewText = (d: Device) => canonical(d.channel.view() as never);

async function pair(options: Parameters<typeof rig>[0] = {}) {
  const r = await rig(options);
  return { r, a: device(r, 'device-a'), b: device(r, 'device-b', { reverseLists: true }) };
}

/** Every copy Gmail holds under the app label, Trash excluded. */
const liveCopies = (r: Rig) =>
  r.emu.mailbox.select({ labelIds: [appLabel(r)], q: '', includeSpamTrash: false }).length;

test('D17 two devices converge to identical state in any fetch order, ties to the lower device id', async () => {
  const { r, a, b } = await pair();
  // Concurrent: neither has read the other. B's clock reads A's edit time, so t1 ties on time and goes to device-a.
  const wa = await a.channel.write(
    [{ key: threadKey('t1'), value: threadValue({ status: 'done' }) }],
    a.ctx(),
  );
  b.options.skewMs = wa.records[0].stamp.at - r.clock.now();
  const wb = await b.channel.write(
    [
      { key: threadKey('t1'), value: threadValue({ status: 'later', laterUntil: 5 }) },
      { key: threadKey('t2'), value: threadValue({ todo: 'call back' }) },
    ],
    b.ctx(),
  );
  assert.equal(wb.records[0].stamp.at, wa.records[0].stamp.at);
  b.options.skewMs = 0;
  await r.clock.advance(1_000);
  await a.channel.write([{ key: 'lease:device-a', value: { until: 1_800_000 } }], a.ctx());
  for (let i = 0; i < 2; i++) {
    await a.round();
    await b.round();
  }
  assert.equal(viewText(a), viewText(b), 'both devices hold the same merged view');
  assert.deepEqual(valueOf(a, threadKey('t1')), { status: 'done' }, 'time tie -> lower device id');
  assert.deepEqual(valueOf(b, threadKey('t2')), { todo: 'call back' });
  assert.deepEqual(
    valueOf(b, 'lease:device-a'),
    { until: 1_800_000 },
    'the lease rides the channel',
  );

  // A third device starting cold, reading every copy in reverse order, lands on the same view.
  const c = device(r, 'device-c', { reverseLists: true });
  await c.round();
  assert.equal(viewText(c), viewText(a));
});

test('D17 merge is order independent: every permutation of the same copies gives one view', async () => {
  const r = await rig();
  const payloads: WorkflowPayload[] = [
    payload('device-a', [rec('thread:x', 10, 0, 'device-a', { status: 'done' })]),
    payload('device-b', [
      rec('thread:x', 10, 0, 'device-b', { status: 'later' }),
      rec('thread:y', 3, 0, 'device-b', { todo: 'b' }),
    ]),
    payload('device-c', [
      rec('thread:x', 9, 7, 'device-c', { status: 'new' }),
      rec('thread:y', 3, 0, 'device-b', { todo: 'b' }),
      rec('thread:z', 1, 0, 'device-c', { status: 'done' }),
    ]),
    payload('device-d', [rec('thread:y', 3, 1, 'device-d', { todo: 'd' })]),
  ];
  const copies: WorkflowCopy[] = payloads.map((p, i) => ({
    remoteId: `m${i}`,
    deviceId: p.device,
    writtenAt: p.writtenAt,
    data: sealedCopy(r, p).data,
  }));
  const views = new Set<string>();
  for (const order of permutations(copies)) {
    const channel = createWorkflowStateChannel({
      transport: noTransport,
      keys: keysOf('shared'),
      device: 'device-z',
      address: r.account.address,
    });
    // One copy per call, the way a slow round trickles them in.
    for (const copy of order) await channel.ingest([copy], new CaptureLog());
    views.add(canonical(channel.view() as never));
  }
  assert.equal(views.size, 1, 'one view for all 24 orders');
  const view = JSON.parse([...views][0]) as WorkflowRecord[];
  assert.deepEqual(winner(view, 'thread:x')?.stamp.device, 'device-a');
  assert.deepEqual(winner(view, 'thread:y')?.value, { todo: 'd' });
});

test('D17 a stale duplicate copy never shadows a newer one, cold or warm', async () => {
  const { r, a, b } = await pair();
  await a.channel.write(
    [{ key: threadKey('t1'), value: threadValue({ status: 'done' }) }],
    a.ctx(),
  );
  const first = r.emu.mailbox.rawOf(winnerId(r));
  await r.clock.advance(60_000);
  await a.channel.write(
    [{ key: threadKey('t1'), value: threadValue({ status: 'later' }) }],
    a.ctx(),
  );
  await r.clock.advance(60_000);
  // The first copy comes back as the newest message (an interrupted trash, a restore): newest by date, oldest by content.
  plant(r, first.toString('latin1'));
  await b.round();
  assert.deepEqual(valueOf(b, threadKey('t1')), { status: 'later' }, 'cold read');

  await r.clock.advance(60_000);
  plant(r, first.toString('latin1'));
  const since = b.governor.calls.length;
  const read = await b.round();
  assert.deepEqual(read.changed, [], 'the stale copy changes nothing');
  assert.deepEqual(valueOf(b, threadKey('t1')), { status: 'later' }, 'warm read');
  assert.equal(
    b.methods(since).filter(m => m === 'gmail.messages.get').length,
    1,
    'only the new id',
  );
});

test('D18 a full read pages past 50 copies', async () => {
  const r = await rig();
  for (let i = 0; i < 120; i++) {
    const p = payload('device-a', [
      rec(`thread:n${i}`, 100 + i, 0, 'device-a', { status: 'done' }),
    ]);
    plant(r, sealedCopy(r, p).raw);
  }
  const b = device(r, 'device-b');
  await b.round();
  assert.equal(b.channel.view().length, 120);
  assert.ok(b.methods().filter(m => m === 'gmail.messages.list').length >= 2, 'paged');
});

test('a round a pause cuts short loses no copy: the next round hands over what was already downloaded', async () => {
  const r = await rig();
  for (let i = 0; i < 12; i++) {
    const p = payload('device-a', [rec(`thread:p${i}`, 10 + i, 0, 'device-a', { status: 'done' })]);
    plant(r, sealedCopy(r, p).raw);
  }
  const b = device(r, 'device-b');
  // labels.list, getProfile, messages.list and the first batch of 10 go out; the second batch is refused.
  b.governor.pauseAfter = 4;
  await assert.rejects(b.round(), PausedError);
  assert.equal(b.syncState.cursor, undefined, 'nothing committed');
  await r.clock.advance(61_000);
  const read = await b.round();
  assert.equal(read.records.length, 12);
  assert.equal(
    b.methods().filter(m => m === 'gmail.messages.get').length,
    2,
    'two batches in all: the first was not downloaded again',
  );
});

test('D17 an idle round costs one history.list (2 units); 3 copies idle stay under 10', async () => {
  const { r, a, b } = await pair();
  const cold = device(r, 'device-c');
  const empty = await cold.round();
  assert.ok(empty.costUnits <= 2, `no label yet: ${empty.costUnits}`);

  for (const d of [a, b, a])
    await d.channel.write(
      [{ key: threadKey(d.id), value: threadValue({ status: 'done' }) }],
      d.ctx(),
    );
  await b.round();
  assert.equal(liveCopies(r), 3);
  for (let i = 0; i < 3; i++) {
    await r.clock.advance(300_000);
    const since = b.governor.calls.length;
    const read = await b.round();
    assert.deepEqual(b.methods(since), ['gmail.history.list']);
    assert.equal(b.units(since), 2);
    assert.equal(read.costUnits, 2);
  }

  // A label change with nothing new to read (A trashes what its last copy supersedes) still costs only the gate.
  await a.round();
  await a.channel.write([{ key: threadKey('t9'), value: threadValue({ status: 'new' }) }], a.ctx());
  await b.round();
  assert.ok((await a.channel.compact(a.ctx())) > 0);
  const since = b.governor.calls.length;
  await b.round();
  assert.equal(b.units(since), 2, 'trashed copies are not re-read');
  assert.equal(liveCopies(r), 1);
});

test('corrupted, foreign and undecryptable copies are skipped, logged without secrets, and never poison a round', async () => {
  const { r, a } = await pair();
  const secret = 'secret-todo-text-7c1f';
  await a.channel.write([{ key: threadKey('good'), value: threadValue({ todo: 'ok' }) }], a.ctx());
  const label = appLabel(r);
  const foreign = plant(
    r,
    'From: friend@example.test\r\nTo: me@example.test\r\nSubject: filed by hand\r\n\r\nhello',
  );
  const marker = (blob: string) =>
    sealedCopy(r, payload('device-x', [])).raw.replace(
      /-----BEGIN APLOS WORKFLOW-----[\s\S]*-----END/,
      `-----BEGIN APLOS WORKFLOW-----\r\n${blob}\r\n-----END`,
    );
  plant(r, marker('APLOS-WF2.AAAA.BBBB.CCCC'));
  plant(r, marker('APLOS-WF9.something.newer'));
  const p = payload('device-x', [rec(threadKey('evil'), 1, 0, 'device-x', { todo: secret })]);
  plant(r, sealedCopy(r, p, { keySeed: 'other-key' }).raw);
  plant(r, sealedCopy(r, p, { address: 'someone-else@example.test' }).raw);
  plant(
    r,
    sealedCopy(r, { v: 2, device: 'device-x', writtenAt: 1, records: [{ key: 7 }] } as never).raw,
  );
  const flipped = sealedCopy(r, p).raw.replace(
    /(-----BEGIN APLOS WORKFLOW-----\r\n.{40})(.)/,
    (_m, head, c) => head + (c === 'A' ? 'B' : 'A'),
  );
  plant(r, flipped);

  const b = device(r, 'device-b');
  const read = await b.round();
  assert.deepEqual(
    read.records.map(x => x.key),
    [threadKey('good')],
    'only the good copy is merged',
  );
  assert.equal(read.skipped, 6);
  const reasons = b.log.lines
    .filter(l => l.event === 'sync.gmail.request_refused')
    .map(l => (l.fields.error as { reason: string }).reason)
    .sort();
  // Another account's copy is under another channel key (the address is in the derivation), so it reads as wrongKey.
  assert.deepEqual(reasons, [
    'workflowCopy.damaged',
    'workflowCopy.damaged',
    'workflowCopy.foreign',
    'workflowCopy.format',
    'workflowCopy.invalid',
    'workflowCopy.wrongKey',
    'workflowCopy.wrongKey',
  ]);
  const logged = JSON.stringify(b.log.lines);
  for (const leak of [
    secret,
    Buffer.from(testKey('shared')).toString('base64'),
    Buffer.from(testKey('shared')).toString('hex'),
    'APLOS-WF2.',
    foreign,
  ])
    assert.ok(!logged.includes(leak), `log leaks ${leak.slice(0, 12)}`);

  const since = b.governor.calls.length;
  await b.round();
  assert.equal(b.units(since), 2, 'skipped copies are not downloaded again');

  // Compaction never trashes what it could not read, nor user mail under the label, even when asked directly.
  await b.transport.compact([foreign], b.ctx());
  await b.channel.write(
    [{ key: threadKey('good'), value: threadValue({ todo: 'newer' }) }],
    b.ctx(),
  );
  await b.channel.compact(b.ctx());
  assert.ok(!r.emu.mailbox.getMessage(foreign)!.labelIds.includes('TRASH'));
  assert.equal(liveCopies(r), 8, 'only the superseded good copy went to Trash');
  assert.ok(r.emu.mailbox.select({ labelIds: [label], q: '', includeSpamTrash: false }).length > 1);
});

test('the wrong key, another account or a flipped bit never yields plaintext', () => {
  const plain = {
    v: 2,
    device: 'device-a',
    writtenAt: 1,
    records: [{ key: 'k', stamp: { at: 1, gen: 0, device: 'device-a' }, value: 'private words' }],
  };
  const key = channelKey(testKey('shared'), 'me@example.test');
  const other = channelKey(testKey('other'), 'me@example.test');
  const sealed = seal(plain, key, 'me@example.test');
  assert.ok(!sealed.includes('private'), 'the sealed form carries no plaintext');
  assert.deepEqual(open(sealed, key, 'ME@example.test'), { ok: true, plain });

  const attempts = [
    open(sealed, other, 'me@example.test'),
    open(sealed.replace(key.kid, other.kid), other, 'me@example.test'),
    open(sealed, key, 'you@example.test'),
    open(
      `${sealed.slice(0, -3)}${sealed.at(-3) === 'A' ? 'B' : 'A'}${sealed.slice(-2)}`,
      key,
      'me@example.test',
    ),
    open(sealed.slice(0, -10), key, 'me@example.test'),
  ];
  assert.deepEqual(
    attempts.map(x => (x.ok ? 'OPENED' : x.reason)),
    ['wrongKey', 'damaged', 'damaged', 'damaged', 'damaged'],
  );
  for (const x of attempts) assert.ok(!('plain' in x));
});

test('with the data key locked, copies wait and open once it is back', async () => {
  const { a, b } = await pair();
  await a.channel.write(
    [{ key: threadKey('t1'), value: threadValue({ status: 'done' }) }],
    a.ctx(),
  );
  b.keys.off = true;
  const locked = await b.round();
  assert.equal(locked.waiting, 1);
  assert.deepEqual(locked.records, []);
  await assert.rejects(
    b.channel.write([{ key: 'x', value: 1 }], b.ctx()),
    /data key is unavailable/,
  );
  b.keys.off = false;
  const back = await b.round();
  assert.deepEqual(
    back.changed.map(x => x.key),
    [threadKey('t1')],
  );
});

test('a later write wins even from a device whose clock is an hour behind (logical clock)', async () => {
  const r = await rig();
  const a = device(r, 'device-a');
  const slow = device(r, 'device-b', { skewMs: -3_600_000 });
  await a.channel.write(
    [{ key: threadKey('t1'), value: threadValue({ status: 'done' }) }],
    a.ctx(),
  );
  await slow.round();
  await slow.channel.write(
    [{ key: threadKey('t1'), value: threadValue({ status: 'new' }) }],
    slow.ctx(),
  );
  await a.round();
  assert.deepEqual(valueOf(a, threadKey('t1')), { status: 'new' });
  assert.equal(viewText(a), viewText(slow));
});

test('an uncertain insert retried with the same copy lands once', async () => {
  const r = await rig();
  const a = device(r, 'device-a', { dropNextInsert: true });
  const ctx = a.ctx();
  const copy = {
    deviceId: 'device-a',
    writtenAt: r.clock.now(),
    data: sealedCopy(r, payload('device-a', [])).data,
  };
  await assert.rejects(a.transport.put(copy, ctx));
  assert.equal(liveCopies(r), 1, 'Gmail applied the insert');
  const id = await a.transport.put(copy, ctx);
  assert.equal(liveCopies(r), 1, 'the retry found it instead of inserting again');
  assert.ok(r.emu.mailbox.getMessage(id));
  assert.equal(a.methods().filter(m => m === 'gmail.messages.insert').length, 1);
});

test('round facts commit once: replays and other devices map to the same op id', async () => {
  const { r, a, b } = await pair({ threads: 4 });
  await r.drive({ scopes: ['history', 'window:inbox'] });
  const threads = [...r.store.threadsIn('INBOX')].sort();
  assert.ok(threads.length >= 2);
  await a.channel.write(
    [
      { key: threadKey(threads[0]), value: threadValue({ status: 'done', todo: 'pay' }) },
      {
        key: threadKey('not-downloaded-yet'),
        value: threadValue({ status: 'later', laterUntil: 9 }),
      },
      { key: threadKey(threads[1]), value: { status: 'bogus' } },
    ],
    a.ctx(),
  );
  const read = await b.round();
  const facts = workflowFacts({
    accountId: r.account.id,
    records: read.changed,
    known: await r.store.lookup.knownThreads(read.changed.map(x => x.key.slice('thread:'.length))),
    local: new Map(),
  });
  assert.equal(facts.writes.length, 1);
  assert.equal(facts.deferred, 1, 'an unknown thread waits instead of failing the commit');
  assert.equal(facts.invalid, 1, 'an ill-typed value never reaches the store');
  const commit = workflowCommit(r.account.id, facts)!;
  assert.equal(r.store.raw.commit(commit).replayed, false);
  assert.equal(r.store.raw.commit(commit).replayed, true, 'the replayed round is a no-op');

  const row = r.store.raw.read(q =>
    q.get<{ status: string; todo: string; edit_device: string }>(
      'SELECT w.status, w.todo, w.edit_device FROM thread_workflow w JOIN threads t ON t.id = w.thread_id WHERE t.remote_id = ?',
      threads[0],
    ),
  );
  assert.deepEqual({ ...row }, { status: 'done', todo: 'pay', edit_device: 'device-a' });

  // A cold device rebuilding the same facts produces the same op id; one whose stored edit is newer writes nothing.
  const c = device(r, 'device-c', { reverseLists: true });
  const again = await c.round();
  const known = await r.store.lookup.knownThreads(threads);
  const rebuilt = workflowCommit(
    r.account.id,
    workflowFacts({ accountId: r.account.id, records: again.records, known, local: new Map() }),
  );
  assert.equal(rebuilt?.opId, commit.opId);
  const stamp = winner(again.records, threadKey(threads[0]))!.stamp;
  const newer = workflowFacts({
    accountId: r.account.id,
    records: again.records,
    known,
    local: new Map([[threads[0], { ...stamp, at: stamp.at + 1 }]]),
  });
  assert.equal(newer.writes.length, 0, 'a newer local edit is never overwritten');
});

// ---- helpers ----

function rec(
  key: string,
  at: number,
  gen: number,
  dev: string,
  value: WorkflowRecord['value'],
): WorkflowRecord {
  return { key, stamp: { at, gen, device: dev }, value };
}

function payload(dev: string, records: WorkflowRecord[]): WorkflowPayload {
  return { v: 2, device: dev, writtenAt: 1, records };
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest]),
  );
}

/** The newest message under the app label. */
function winnerId(r: Rig): string {
  return r.emu.mailbox.select({ labelIds: [appLabel(r)], q: '', includeSpamTrash: false })[0].id;
}

const noTransport = {
  round: () => Promise.reject(new Error('not used')),
  put: () => Promise.reject(new Error('not used')),
  compact: () => Promise.reject(new Error('not used')),
  readBack: () => Promise.reject(new Error('not used')),
  receivedAt: () => Promise.reject(new Error('not used')),
};

test('a failed put leaves nothing local-only in the view: a lease claim no peer can see never shows as held', async () => {
  const { a, b } = await pair();
  await a.channel.write(
    [{ key: threadKey('t1'), value: threadValue({ status: 'done' }) }],
    a.ctx(),
  );
  // Gmail refuses the insert outright (not an uncertain write): the copy never exists.
  const put = a.transport.put.bind(a.transport);
  a.transport.put = async () => {
    throw new Error('insert refused');
  };
  await assert.rejects(
    a.channel.write(
      [{ key: 'lease:device-a', value: { until: 1_800_000, pinned: true } }],
      a.ctx(),
    ),
  );
  assert.equal(valueOf(a, 'lease:device-a'), undefined, 'the unsent claim is not in the view');
  assert.deepEqual(valueOf(a, threadKey('t1')), { status: 'done' });
  // The next successful write does not carry the failed record along either.
  a.transport.put = put;
  await a.channel.write([{ key: threadKey('t2'), value: threadValue({ todo: 'x' }) }], a.ctx());
  await b.round();
  assert.equal(valueOf(b, 'lease:device-a'), undefined);
  assert.deepEqual(valueOf(b, threadKey('t2')), { todo: 'x' });
});
