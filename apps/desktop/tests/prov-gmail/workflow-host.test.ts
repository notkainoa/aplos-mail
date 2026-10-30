/**
 * The Gmail workflow channel on the real stack (plan 20 PV3, ARCH 6.5): two `Mac`s on one emulated account, the
 * engine's `ActorHost` running the lease over the sealed-copy channel, the adapter's `workflow` round behind the
 * governor, and `workflow-host.ts`'s facts commit. Synthetic data and test keys only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GMAIL_BUDGET } from '../../src/host/providers/google/adapter';
import { APP_LABEL } from '../../src/host/providers/google/workflow';
import { buildCopyMessage } from '../../src/host/providers/google/workflow-message';
import type { WorkflowPayload } from '../../src/host/providers/google/workflow-merge';
import { channelKey, seal } from '../../src/host/providers/google/workflow-seal';
import { rig } from './harness';
import { device, testKey } from './workflow-rig';
import {
  ACCOUNT,
  Mac,
  MINUTE,
  accountRow,
  boot,
  localInbox,
  mailWorld,
  runUntil,
  settle,
  stateOf,
} from './gov-stack-rig';

type Engine = Awaited<ReturnType<typeof boot>>;

const leaseOf = (engine: Engine) => engine.host.status(ACCOUNT)?.lease;

/** Gmail API requests a Mac actually sent (oauth and other hosts excluded). */
const gmailSent = (mac: Mac) => mac.sent.filter(s => s.url.pathname.startsWith('/gmail/'));

/**
 * The channel reads a Mac sent: the gated `history.list` on the app label, or the full `messages.list` of it. Every
 * workflow round, whoever runs it, makes exactly one of these once the label exists.
 */
const channelReads = (mac: Mac, mail: ReturnType<typeof mailWorld>) => {
  const label = mail.emu.mailbox.labelIdByName(APP_LABEL);
  if (!label) return [];
  return gmailSent(mac).filter(
    s =>
      (s.url.pathname.endsWith('/history') && s.url.searchParams.get('labelId') === label) ||
      (s.url.pathname.endsWith('/messages') &&
        s.url.searchParams.getAll('labelIds').includes(label)),
  );
};

/** Raw downloads of one message (how a round fetches a copy), sent alone or inside a batch. */
const downloads = (mac: Mac, id: string) => {
  const get = new RegExp(`/messages/${id}\\?\\S*format=raw`, 'g');
  return mac.sent
    .map(s => `${s.url.pathname}${s.url.search}\n${s.body ?? ''}`)
    .reduce((n, text) => n + (text.match(get)?.length ?? 0), 0);
};

/** A sealed copy from another device carrying `records`, planted under the app label. */
function plantCopy(
  mail: ReturnType<typeof mailWorld>,
  records: WorkflowPayload['records'],
): string {
  const payload: WorkflowPayload = {
    v: 2,
    device: 'device-x',
    writtenAt: mail.clock.now(),
    records,
  };
  const raw = buildCopyMessage(
    {
      deviceId: 'device-x',
      writtenAt: payload.writtenAt,
      data: seal(payload, channelKey(testKey('shared'), mail.address), mail.address),
    },
    mail.address,
  );
  return mail.emu.mailbox.addRaw(Buffer.from(raw), { labelIds: [appLabel(mail)] }).id;
}

const workflowStatus = (engine: Engine, tid: string) =>
  engine.store.read(q =>
    q.get<{ status: string }>(
      `SELECT w.status FROM thread_workflow w JOIN threads t ON t.id = w.thread_id
       WHERE t.account_id = ? AND t.remote_id = ?`,
      ACCOUNT,
      tid,
    ),
  )?.status;

/** The app label's id in the mailbox, created when missing (as a writer would). */
const appLabel = (mail: ReturnType<typeof mailWorld>) =>
  mail.emu.mailbox.labelIdByName(APP_LABEL) ??
  mail.emu.mailbox.createLabel(APP_LABEL, {
    labelListVisibility: 'labelHide',
    messageListVisibility: 'hide',
  }).id;

test('the lease rides the real channel: one Mac wins, the other stays secondary and reads only on its lease round', async () => {
  const mail = mailWorld(4);
  const a = new Mac(mail, 'mac-a');
  const b = new Mac(mail, 'mac-b');
  const engineA = await boot(a, undefined, { workflow: true });
  const engineB = await boot(b, undefined, { workflow: true });
  try {
    await engineA.host.start(ACCOUNT);
    await engineB.host.start(ACCOUNT);
    // The lease loops tick over the emulator: candidacies, then mac-a wins the lower-id tie.
    await runUntil(
      mail.clock,
      () => leaseOf(engineA)?.role === 'primary' && leaseOf(engineA)?.holder === 'mac-a',
      'mac-a takes the lease',
      20 * MINUTE,
    );
    await settle(mail.clock, engineA.host.claimLease(ACCOUNT));
    assert.equal(leaseOf(engineA)?.pinned, true, 'the pin published');
    await runUntil(
      mail.clock,
      () => leaseOf(engineB)?.holder === 'mac-a',
      'mac-b sees the holder',
      20 * MINUTE,
    );
    assert.equal(leaseOf(engineB)?.role, 'secondary');
    assert.equal(
      engineB.governor.inspect(ACCOUNT, 'gmail').target,
      GMAIL_BUDGET.target.secondary,
      'mac-b runs under the secondary target',
    );
    assert.equal(
      engineA.governor.inspect(ACCOUNT, 'gmail').target,
      GMAIL_BUDGET.target.primary,
      'mac-a runs under the primary target',
    );
    assert.ok(stateOf(engineA.store, 'workflow'), 'the round committed the workflow cursor');
    // Let every in-flight round land; then mac-b reads the channel once a minute at most, on its lease round.
    await mail.clock.advance(30_000);
    const bReads = channelReads(b, mail).length;
    await mail.clock.advance(3 * MINUTE);
    assert.ok(channelReads(b, mail).length - bReads <= 3, 'one channel reader on the secondary');
  } finally {
    await settle(mail.clock, engineA.kill());
    await settle(mail.clock, engineB.kill());
    a.cleanup();
    b.cleanup();
  }
});

test('one channel reader: over 10 idle minutes the primary reads the channel at most once a minute, through the governor', async () => {
  const mail = mailWorld(4);
  const a = new Mac(mail, 'mac-a');
  const engineA = await boot(a, undefined, { workflow: true });
  try {
    await engineA.host.start(ACCOUNT);
    await runUntil(
      mail.clock,
      () => leaseOf(engineA)?.role === 'primary' && channelReads(a, mail).length >= 1,
      'the lease and a gated channel read',
      10 * MINUTE,
    );
    await mail.clock.advance(MINUTE);
    const reads = channelReads(a, mail).length;
    await mail.clock.advance(10 * MINUTE);
    const idle = channelReads(a, mail).length - reads;
    assert.ok(idle <= 10, `${idle} channel reads in 10 idle minutes`);
    assert.ok(idle >= 9, 'the lease round still reads every minute');
    assert.ok(
      engineA.governor.inspect(ACCOUNT, 'gmail').used > 0,
      'the round charged through the governor',
    );
    assert.ok(
      a.log.some(e => e.apiMethod === 'gmail.users.messages.insert' && e.units > 0),
      'claim copies went through messages.insert — only the workflow channel inserts',
    );
  } finally {
    await settle(mail.clock, engineA.kill());
    a.cleanup();
  }
});

test('a throttle pauses the account: no Gmail request goes out — sync, workflow round or lease tick', async () => {
  const mail = mailWorld(4);
  const a = new Mac(mail, 'mac-a');
  const engineA = await boot(a, undefined, { workflow: true });
  try {
    await engineA.host.start(ACCOUNT);
    await runUntil(
      mail.clock,
      () => channelReads(a, mail).length >= 1,
      'the first channel read',
      10 * MINUTE,
    );
    // A few minutes of 429s: the first refusal pauses the account; everything after is refused with no I/O.
    const now = mail.clock.now();
    mail.faults.storm({
      from: now,
      to: now + 3 * MINUTE,
      reason: 'rateLimitExceeded',
      retryAfterSeconds: 60,
      match: { service: 'gmail' },
    });
    await runUntil(
      mail.clock,
      () => engineA.host.status(ACCOUNT)?.status.state === 'paused',
      'the pause',
      2 * MINUTE,
    );
    const sent = gmailSent(a).length;
    await mail.clock.advance(50_000);
    assert.equal(
      gmailSent(a).length,
      sent,
      'zero Gmail requests while paused — the governor refuses before any I/O',
    );
    // The storm ends: the account resumes (the round and the lease both read again).
    mail.faults.clear();
    await runUntil(
      mail.clock,
      () => engineA.host.status(ACCOUNT)?.status.state === 'ok',
      'the resume',
      3 * MINUTE,
    );
    assert.ok(gmailSent(a).length > sent, 'requests flow again after the pause');
  } finally {
    await settle(mail.clock, engineA.kill());
    a.cleanup();
  }
});

test('a quit publishes the dead claim and the other Mac takes the lease; a restart keeps it', async () => {
  const mail = mailWorld(4);
  const a = new Mac(mail, 'mac-a');
  const b = new Mac(mail, 'mac-b');
  const engineA = await boot(a, undefined, { workflow: true });
  const engineB = await boot(b, undefined, { workflow: true });
  try {
    await engineA.host.start(ACCOUNT);
    await engineB.host.start(ACCOUNT);
    await runUntil(
      mail.clock,
      () => leaseOf(engineA)?.role === 'primary',
      'mac-a takes the lease',
      20 * MINUTE,
    );
    // A restart: the published claim stays live, and the restarted actor's new controller reports it.
    await engineA.host.stop(ACCOUNT, 'restart');
    await engineA.host.start(ACCOUNT);
    assert.equal(leaseOf(engineA)?.role, 'primary', 'the lease input survives the restart');
    await runUntil(
      mail.clock,
      () => leaseOf(engineA)?.holder === 'mac-a',
      'mac-a primary again',
      20 * MINUTE,
    );
    assert.equal(leaseOf(engineB)?.role, 'secondary', 'mac-b stays secondary');
    // A quit publishes the expired claim; mac-b's next round sees the lease free and takes it.
    // The dead claim waits in the governor like any request, and a quit waits for it LEASE_STOP_WAIT_MS at most:
    // quit once the restarted Mac's first full read has left the enrichment lane's share of the minute.
    await mail.clock.advance(2 * MINUTE);
    await settle(mail.clock, engineA.host.stop(ACCOUNT, 'quit'));
    await runUntil(
      mail.clock,
      () => leaseOf(engineB)?.role === 'primary' && leaseOf(engineB)?.holder === 'mac-b',
      'mac-b takes over',
      20 * MINUTE,
    );
    assert.equal(
      engineB.governor.inspect(ACCOUNT, 'gmail').target,
      GMAIL_BUDGET.target.primary,
      'mac-b runs under the primary target now',
    );
  } finally {
    await settle(mail.clock, engineA.kill());
    await settle(mail.clock, engineB.kill());
    a.cleanup();
    b.cleanup();
  }
});

test('a thread record on the channel becomes a thread_workflow row through onWorkflowMerged', async () => {
  const mail = mailWorld(4);
  const a = new Mac(mail, 'mac-a');
  const engineA = await boot(a, undefined, { workflow: true });
  try {
    await engineA.host.start(ACCOUNT);
    // The device syncs its INBOX threads first (secondary lanes run: window + history).
    await runUntil(mail.clock, () => localInbox(engineA.store).size > 0, 'the first threads');
    const tid = [...localInbox(engineA.store)][0];
    // Another device publishes a `thread:` record for it: a sealed copy under the app label.
    plantCopy(mail, [
      {
        key: `thread:${tid}`,
        stamp: { at: mail.clock.now(), gen: 0, device: 'device-x' },
        value: { status: 'done', todo: 'pay the invoice' },
      },
    ]);
    // The next channel read ingests it, and the merged handler commits the fact.
    await runUntil(
      mail.clock,
      () => workflowStatus(engineA, tid) === 'done',
      'the workflow fact',
      10 * MINUTE,
    );
    const row = engineA.store.read(q =>
      q.get<{ status: string; todo: string; edit_device: string }>(
        `SELECT w.status, w.todo, w.edit_device FROM thread_workflow w JOIN threads t ON t.id = w.thread_id
         WHERE t.account_id = ? AND t.remote_id = ?`,
        ACCOUNT,
        tid,
      ),
    );
    assert.deepEqual(
      { ...row },
      { status: 'done', todo: 'pay the invoice', edit_device: 'device-x' },
    );
  } finally {
    await settle(mail.clock, engineA.kill());
    a.cleanup();
  }
});

test('a fresh Mac reads the channel only after its baseline, and downloads each copy once', async () => {
  const mail = mailWorld(4);
  const copies = [0, 1, 2].map(i =>
    plantCopy(mail, [
      {
        key: `thread:planted-${i}`,
        stamp: { at: mail.clock.now(), gen: i, device: 'device-x' },
        value: { status: 'later', laterUntil: 9 },
      },
    ]),
  );
  const a = new Mac(mail, 'mac-a');
  const engineA = await boot(a, undefined, { workflow: true });
  try {
    await engineA.host.start(ACCOUNT);
    await runUntil(
      mail.clock,
      () => leaseOf(engineA)?.role === 'primary',
      'mac-a takes the lease',
      20 * MINUTE,
    );
    await mail.clock.advance(2 * MINUTE);
    for (const id of copies) assert.equal(downloads(a, id), 1, `copy ${id} downloaded once`);
    const baselineAt = accountRow(engineA.store).baseline_done_at!;
    const first = channelReads(a, mail)[0];
    assert.ok(first.at >= baselineAt, 'the first channel read waits for the baseline sync');
  } finally {
    await settle(mail.clock, engineA.kill());
    a.cleanup();
  }
});

test('a record for a thread that is not stored yet is applied once the thread arrives', async () => {
  const mail = mailWorld(6);
  // A thread outside the first window: archived, so a fresh Mac does not store it at first.
  const [tid] = mail.emu.mailbox.archiveThreads(1);
  plantCopy(mail, [
    {
      key: `thread:${tid}`,
      stamp: { at: mail.clock.now(), gen: 0, device: 'device-x' },
      value: { status: 'done' },
    },
  ]);
  const a = new Mac(mail, 'mac-a');
  const engineA = await boot(a, undefined, { workflow: true });
  try {
    await engineA.host.start(ACCOUNT);
    await runUntil(
      mail.clock,
      () => channelReads(a, mail).length >= 1,
      'the first channel read',
      20 * MINUTE,
    );
    await mail.clock.advance(MINUTE);
    assert.ok(!localInbox(engineA.store).has(tid), 'the thread is not stored yet');
    assert.equal(workflowStatus(engineA, tid), undefined);
    // The thread comes back to the inbox: history stores it, and a later read applies the deferred record.
    mail.emu.mailbox.modifyThread(tid, ['INBOX'], []);
    await runUntil(
      mail.clock,
      () => workflowStatus(engineA, tid) === 'done',
      'the deferred workflow fact',
      10 * MINUTE,
    );
  } finally {
    await settle(mail.clock, engineA.kill());
    a.cleanup();
  }
});

test('a channel read whose merge fails keeps the copies it downloaded and merges them on the next read', async () => {
  const r = await rig();
  const a = device(r, 'device-a');
  const b = device(r, 'device-b');
  await a.channel.write([{ key: 'thread:t-held', value: { status: 'done' } }], a.ctx());
  const dataKey = b.keys.dataKey;
  b.keys.dataKey = async () => {
    throw new Error('keychain busy');
  };
  await assert.rejects(b.round(), /keychain busy/);
  b.keys.dataKey = dataKey;
  // The transport marked the copy seen, so this read downloads nothing new: the held copy is merged now.
  const before = b.governor.calls.length;
  const read = await b.channel.read(b.syncState, b.ctx());
  assert.ok(
    read.changed.some(x => x.key === 'thread:t-held'),
    'the held copy merged',
  );
  assert.ok(!b.methods(before).includes('gmail.messages.get'), 'not downloaded again');
});

test('a lease write reports this device clock offset from Gmail receive time, for the clock gate', async () => {
  const r = await rig();
  const slow = device(r, 'device-a', { skewMs: -12 * MINUTE });
  const fine = device(r, 'device-b');
  const off = await slow.channel.write([{ key: 'lease:device-a', value: { v: 1 } }], slow.ctx());
  const ok = await fine.channel.write([{ key: 'lease:device-b', value: { v: 1 } }], fine.ctx());
  for (const end of [off.clockOffset!.lowMs, off.clockOffset!.highMs])
    assert.ok(Math.abs(end + 12 * MINUTE) < 5_000, `measured ${end}`);
  for (const end of [ok.clockOffset!.lowMs, ok.clockOffset!.highMs])
    assert.ok(Math.abs(end) < 5_000, `measured ${end}`);
  assert.ok(fine.methods().includes('gmail.messages.get'), 'one minimal get for the receive time');
});

test('the primary compacts the copies its renewals supersede: the label stays small over an idle hour', async () => {
  const mail = mailWorld(4);
  const a = new Mac(mail, 'mac-a');
  const engineA = await boot(a, undefined, { workflow: true });
  const live = () =>
    mail.emu.mailbox.select({ labelIds: [appLabel(mail)], q: '', includeSpamTrash: false }).length;
  try {
    await engineA.host.start(ACCOUNT);
    await runUntil(
      mail.clock,
      () => leaseOf(engineA)?.role === 'primary',
      'the lease',
      10 * MINUTE,
    );
    await mail.clock.advance(60 * MINUTE);
    assert.equal(leaseOf(engineA)?.role, 'primary');
    assert.ok(live() <= 2, `${live()} copies under the label after an hour of renewals`);
  } finally {
    await settle(mail.clock, engineA.kill());
    a.cleanup();
  }
});
