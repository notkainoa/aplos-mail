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
import { testKey } from './workflow-rig';
import {
  ACCOUNT,
  Mac,
  MINUTE,
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

/** The app label's id in the mailbox, created when missing (as a writer would). */
const appLabel = (mail: ReturnType<typeof mailWorld>) =>
  mail.emu.mailbox.labelIdByName(APP_LABEL) ??
  mail.emu.mailbox.createLabel(APP_LABEL, {
    labelListVisibility: 'labelHide',
    messageListVisibility: 'hide',
  }).id;

test('the lease rides the real channel: one Mac wins, the other stays secondary and runs no workflow round', async () => {
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
    // Let every in-flight round land; then, while the holder is live, mac-b's actor runs none.
    await mail.clock.advance(30_000);
    const bRounds = engineB.workflowRounds.length;
    await mail.clock.advance(2 * MINUTE);
    assert.equal(
      engineB.workflowRounds.length,
      bRounds,
      "the round stays the primary's while a holder is live",
    );
  } finally {
    await settle(mail.clock, engineA.kill());
    await settle(mail.clock, engineB.kill());
    a.cleanup();
    b.cleanup();
  }
});

test('the actor runs the workflow round at most once a minute, and charges it through the governor', async () => {
  const mail = mailWorld(4);
  const a = new Mac(mail, 'mac-a');
  const engineA = await boot(a, undefined, { workflow: true });
  try {
    await engineA.host.start(ACCOUNT);
    await runUntil(
      mail.clock,
      () => engineA.workflowRounds.length >= 1,
      'the first workflow round',
      10 * MINUTE,
    );
    // Inside the minute: no second round, however often the actor wakes.
    const rounds = engineA.workflowRounds.length;
    await mail.clock.advance(30_000);
    assert.equal(engineA.workflowRounds.length, rounds, 'no second round inside the minute');
    // Past it: exactly one more — and every request it made went through the account's budget.
    await runUntil(
      mail.clock,
      () => engineA.workflowRounds.length === rounds + 1,
      'the next cadence round',
      2 * MINUTE,
    );
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
      () => engineA.workflowRounds.length >= 1,
      'the first workflow round',
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
    const payload: WorkflowPayload = {
      v: 2,
      device: 'device-x',
      writtenAt: mail.clock.now(),
      records: [
        {
          key: `thread:${tid}`,
          stamp: { at: mail.clock.now(), gen: 0, device: 'device-x' },
          value: { status: 'done', todo: 'pay the invoice' },
        },
      ],
    };
    const raw = buildCopyMessage(
      {
        deviceId: 'device-x',
        writtenAt: payload.writtenAt,
        data: seal(payload, channelKey(testKey('shared'), mail.address), mail.address),
      },
      mail.address,
    );
    mail.emu.mailbox.addRaw(Buffer.from(raw), { labelIds: [appLabel(mail)] });
    // The next channel read ingests it, and the merged handler commits the fact.
    await runUntil(
      mail.clock,
      () =>
        engineA.store.read(q =>
          q.get<{ status: string }>(
            `SELECT w.status FROM thread_workflow w JOIN threads t ON t.id = w.thread_id
             WHERE t.account_id = ? AND t.remote_id = ?`,
            ACCOUNT,
            tid,
          ),
        )?.status === 'done',
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
