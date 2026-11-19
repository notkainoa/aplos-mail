/**
 * prov-gov adversarial checks against the real stack, continued: 401 storms, daily stops, never-resent writes, in-flight
 * concurrency, notifications and restart churn. Same rig as gov-stack-attack.test.ts (`gov-stack-rig.ts`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NotSentError, PausedError } from '@aplos/engine/ports';
import { GMAIL_BUDGET } from '../../src/host/providers/google/adapter';
import { googleError } from '../../src/host/providers/google/classify';
import {
  ACCOUNT,
  MINUTE,
  HOUR,
  API,
  mailWorld,
  Mac,
  boot,
  runUntil,
  settle,
  accountRow,
  stateOf,
  statusOf,
  refusals,
  methodsOf,
  peakWindow,
  synced,
  localInbox,
  gmailOnly,
} from './gov-stack-rig';

test('prov-gov-attack-06 401 storm: no loop, no token call while blocked (also across a restart), reconnect is not blocked by its own block, no resync', async () => {
  const { mail, mac, engine: first } = await synced(120);
  let engine = first;
  try {
    // Gmail refuses every call with 401 (the grant was revoked server side, the token endpoint still answers).
    mail.faults.failNext(
      { service: 'gmail' },
      { status: 401, reason: 'authError', message: 'Invalid Credentials' },
      { times: 100 },
    );
    const logAt = mac.log.length;
    assert.equal(engine.host.request(ACCOUNT, { manual: true }).ok, true);
    await runUntil(
      mail.clock,
      () => statusOf(engine)?.state === 'needsReauth',
      'needsReauth',
      10 * MINUTE,
      50,
    );
    const storm = mac.log.slice(logAt);
    assert.deepEqual(
      methodsOf(storm),
      ['history.list', 'oauth.token', 'history.list'],
      'one 401, one forced refresh, one re-send, then the block',
    );

    // A day of manual syncs (plain and forced), wakes, op hints and interactive calls: nothing leaves.
    const blockedAt = mac.log.length;
    const someThread = [...localInbox(engine.store)][0];
    for (let i = 0; i < 24; i++) {
      assert.equal(engine.host.request(ACCOUNT, { manual: true }).ok, false);
      assert.equal(engine.host.request(ACCOUNT, { manual: true, force: true }).ok, false);
      engine.host.wake('network');
      engine.host.opsChanged(ACCOUNT);
      await assert.rejects(
        settle(mail.clock, engine.host.openThread(ACCOUNT, someThread)),
        PausedError,
      );
      await assert.rejects(
        settle(mail.clock, engine.host.search(ACCOUNT, { text: 'hello', limit: 25 })),
        PausedError,
      );
      await mail.clock.advance(HOUR);
    }
    assert.equal(mac.log.length, blockedAt, 'zero Gmail and zero token calls while auth-blocked');

    // Restart: the block survives and still nothing leaves (the access token is long expired by now).
    await engine.kill();
    engine = await boot(mac);
    await engine.host.start(ACCOUNT);
    await mail.clock.advance(2 * HOUR);
    assert.equal(mac.log.length, blockedAt, 'zero calls after a restart while auth-blocked');
    assert.equal(statusOf(engine)?.state, 'needsReauth');

    // Reconnect through the blocked account's own governor: the consent is not refused by the block.
    mail.faults.clear();
    const result = await settle(
      mail.clock,
      engine.host.connect(ACCOUNT, 'google', {
        mode: 'reconnect',
        loginHint: mail.address,
        expectedSubject: mail.subject,
      }),
    );
    const reconnectAt = mac.log.length;
    await engine.host.reconnected(ACCOUNT, result);
    await runUntil(
      mail.clock,
      () => statusOf(engine)?.state === 'ok',
      'status ok',
      10 * MINUTE,
      50,
    );
    await mail.clock.advance(3 * MINUTE);
    const after = methodsOf(mac.log.slice(reconnectAt).filter(e => e.apiMethod !== 'gmail.batch'));
    for (const resync of [
      'messages.list',
      'threads.list',
      'threads.get',
      'messages.get',
      'getProfile',
    ]) {
      assert.ok(!after.includes(resync), `no ${resync} after the reconnect: ${after.join(' ')}`);
    }
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

test('prov-gov-attack-07 quotaExceeded: interactive calls and a restart make zero requests until Pacific midnight', async () => {
  const { mail, mac, engine: first } = await synced(120);
  let engine = first;
  try {
    mail.emu.setDailyLimit('quotaExceeded');
    const resetsAt = mail.emu.dailyLimit()!.resetsAt;
    const logAt = mac.log.length;
    engine.host.request(ACCOUNT, { manual: true });
    await runUntil(
      mail.clock,
      () => statusOf(engine)?.state === 'paused',
      'the daily stop',
      10 * MINUTE,
      50,
    );
    assert.equal(mac.log.length, logAt + 1, 'one refused request');
    const stopAt = mac.log.length;
    const thread = [...localInbox(engine.store)][0];
    await assert.rejects(settle(mail.clock, engine.host.openThread(ACCOUNT, thread)), PausedError);
    await assert.rejects(
      settle(mail.clock, engine.host.search(ACCOUNT, { text: 'hello', limit: 25 })),
      PausedError,
    );
    for (let i = 0; i < 10; i++) {
      engine.host.request(ACCOUNT, { manual: true, force: true });
      engine.host.wake('focus');
      await mail.clock.advance(10 * MINUTE);
    }
    // Restart mid-stop.
    await engine.kill();
    engine = await boot(mac);
    await engine.host.start(ACCOUNT);
    assert.equal(statusOf(engine)?.state, 'paused', 'the restarted account shows the daily stop');
    await mail.clock.advanceTo(resetsAt - 1_000);
    assert.equal(
      mac.log.length,
      stopAt,
      `zero requests until midnight; saw ${methodsOf(mac.log.slice(stopAt)).join(' ')}`,
    );
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

test('prov-gov-attack-08 sends and writes are never re-sent: 503, lost reply, reset, concurrent 401s', async () => {
  const mail = mailWorld(5);
  const mac = new Mac(mail, 'mac-a');
  const engine = await boot(mac);
  try {
    const governor = engine.governor;
    governor.setBudgets(ACCOUNT, [GMAIL_BUDGET]);
    governor.setRole(ACCOUNT, 'primary');
    const raw = Buffer.from(
      `To: someone@example.test\r\nSubject: hi\r\n\r\nSynthetic.\r\n`,
    ).toString('base64url');
    const send = (kind: 'send' | 'write') =>
      governor.run(
        ACCOUNT,
        { budget: 'gmail', lane: 'interactive', kind, method: 'gmail.messages.send', cost: 100 },
        async io => {
          const response = await mac.fetch(`${API}/messages/send`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${io.accessToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ raw }),
            signal: io.signal,
          });
          const text = await response.text();
          if (!response.ok)
            throw googleError({
              method: 'gmail.messages.send',
              kind,
              now: mail.clock.now(),
              status: response.status,
              body: text,
            });
          return text;
        },
      );
    const sends = () => mac.log.filter(e => e.apiMethod === 'gmail.users.messages.send').length;
    for (const kind of ['send', 'write'] as const) {
      for (const fault of ['503', 'dropAfter', 'drop'] as const) {
        const before = sends();
        if (fault === '503')
          mail.faults.failNext(
            { apiMethod: 'gmail.users.messages.send' },
            { status: 503, reason: 'backendError' },
          );
        if (fault === 'dropAfter')
          mail.faults.dropAfterNext({ apiMethod: 'gmail.users.messages.send' });
        if (fault === 'drop') mail.faults.dropNext({ apiMethod: 'gmail.users.messages.send' });
        await assert.rejects(settle(mail.clock, send(kind)));
        await mail.clock.advance(MINUTE);
        assert.equal(
          sends() - before,
          1,
          `${kind} after ${fault} was sent ${sends() - before} times`,
        );
      }
    }
    // A drop before any reply is proof it never left only for a NotSentError; anything after the bytes left is uncertain.
    mail.faults.dropAfterNext({ apiMethod: 'gmail.users.messages.send' });
    const lost = await settle(mail.clock, send('send')).catch((e: unknown) => e);
    assert.ok(!(lost instanceof NotSentError), 'a lost reply is never reported as not sent');
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

test('prov-gov-attack-09 in flight: "Retry now" after a concurrency 429 never puts a second request beside one still in flight', async () => {
  const mail = mailWorld(5);
  const mac = new Mac(mail, 'mac-a');
  const engine = await boot(mac);
  try {
    const governor = engine.governor;
    governor.setBudgets(ACCOUNT, [GMAIL_BUDGET]);
    governor.setRole(ACCOUNT, 'primary');
    mail.emu.settings.latencyMs = 5_000;
    const raw = Buffer.from(
      `To: someone@example.test\r\nSubject: big\r\n\r\nSynthetic.\r\n`,
    ).toString('base64url');
    // A send is in flight (a slow upload; a pause never aborts a send).
    const sending = governor.run(
      ACCOUNT,
      {
        budget: 'gmail',
        lane: 'interactive',
        kind: 'send',
        method: 'gmail.messages.send',
        cost: 100,
      },
      async io => {
        const response = await mac.fetch(`${API}/messages/send`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${io.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ raw }),
          signal: io.signal,
        });
        return response.text();
      },
    );
    sending.catch(() => {});
    await mail.clock.advance(500);
    assert.equal(mail.emu.inFlight(), 1);
    // A metadata batch that finished just before the send was admitted reports its part's concurrency 429 now
    // (`GmailClient.batch` observes refused parts after `run` resolves).
    governor.observe(ACCOUNT, 'gmail', {
      class: 'throttle',
      provider: 'gmail',
      method: 'gmail.messages.get',
      reason: 'rateLimitExceeded',
      status: 429,
      concurrency: true,
    });
    assert.equal(governor.inspect(ACCOUNT, 'gmail').inFlightLimit, 1);
    // The user presses "Retry now".
    assert.equal(governor.retryNow(ACCOUNT, 'gmail').ok, true);
    const read = governor.run(
      ACCOUNT,
      { budget: 'gmail', lane: 'interactive', kind: 'read', method: 'gmail.getProfile', cost: 1 },
      async io => {
        const response = await mac.fetch(`${API}/profile?fields=historyId`, {
          headers: { authorization: `Bearer ${io.accessToken}` },
          signal: io.signal,
        });
        return response.text();
      },
    );
    read.catch(() => {});
    await mail.clock.advance(100);
    const peak = Math.max(
      ...gmailOnly(mac.log)
        .filter(e => e.batch === undefined)
        .map(e => e.inFlight),
    );
    await settle(mail.clock, Promise.allSettled([sending, read]));
    assert.ok(peak <= 1, `${peak} Gmail requests in flight at once (inFlight limit 1)`);
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

// The backfill half holds. The other half depends on eng-time's notification rule: an old message moved back to the
// Inbox elsewhere is a real Inbox change and has to commit with the history page that reports it (`incremental`), and
// F3 has no per-message "new arrival" fact to tell it from new mail (port gap). Kept as a todo until eng-time's rule exists.
test(
  'prov-gov-attack-10 notifications: backfill pages commit coarse and no incremental commit brings in old mail',
  { todo: 'depends on eng-time notification rule and a port fact for regained mail' },
  async () => {
    const mail = mailWorld(800);
    const mac = new Mac(mail, 'mac-a');
    const engine = await boot(mac);
    try {
      const start = mail.clock.now();
      await engine.host.start(ACCOUNT);
      await runUntil(
        mail.clock,
        () => accountRow(engine.store).baseline_done_at !== null,
        'baseline',
      );
      // Mail keeps arriving during the window and backfill; and on the web the user moves one old archived message back to
      // the Inbox (it is not on this device).
      const archivedOld = mail.emu.mailbox
        .listMessages()
        .filter(
          m =>
            !m.labelIds.includes('INBOX') &&
            !m.labelIds.includes('DRAFT') &&
            !m.labelIds.includes('SENT'),
        )
        .sort((x, y) => x.internalDate - y.internalDate)[0];
      for (let i = 0; i < 5; i++) {
        mail.emu.mailbox.addMessage({
          from: 'News <news@mail.example.test>',
          subject: `Live ${i}`,
          text: 'Synthetic.',
          labelIds: ['INBOX', 'UNREAD'],
        });
        await mail.clock.advance(MINUTE);
      }
      if (archivedOld) mail.emu.mailbox.modifyMessages([archivedOld.id], ['INBOX'], []);
      await runUntil(
        mail.clock,
        () =>
          stateOf(engine.store, 'backfill:inbox')?.phase === 'done' &&
          stateOf(engine.store, 'sent:recent')?.phase === 'done',
        'backfill and Sent',
      );
      await mail.clock.advance(3 * MINUTE);
      const syncCommits = engine.commits.filter(c => c.origin === 'sync');
      const backfill = syncCommits.filter(c => c.step === 'backfill');
      assert.ok(backfill.length > 0, 'there were backfill pages');
      assert.ok(
        backfill.every(c => c.changes === 'coarse'),
        'every backfill page is one coarse change',
      );
      const baseline = accountRow(engine.store).baseline_done_at!;
      // eng-time notifies for `incremental` commits after the baseline (F3 StepOrigin); any message older than the start
      // in such a commit would be announced as new mail.
      const oldInIncremental = syncCommits
        .filter(c => c.step === 'incremental')
        .flatMap(c => c.messages)
        .filter(m => m.internalDate < start);
      const noStep = syncCommits.filter(c => c.step === undefined && c.messages.length);
      assert.equal(baseline >= start, true);
      assert.deepEqual(
        oldInIncremental.map(m => m.remoteId),
        [],
        `incremental commits after the baseline carried ${oldInIncremental.length} messages older than the first sync (${noStep.length} step-less sync commits with messages)`,
      );
    } finally {
      await engine.kill();
      mac.cleanup();
    }
  },
);

test('prov-gov-attack-11 restart churn: killing the engine every 20 s through a heavy sync never re-spends the minute', async t => {
  const mail = mailWorld(1_500);
  const mac = new Mac(mail, 'mac-a');
  let engine = await boot(mac);
  try {
    const logAt = mac.log.length;
    await engine.host.start(ACCOUNT);
    await runUntil(
      mail.clock,
      () => accountRow(engine.store).baseline_done_at !== null,
      'baseline',
    );
    // Thirty restarts, 20 s apart, while the window and backfill run at full rate.
    for (let i = 0; i < 30; i++) {
      await mail.clock.advance(20_000);
      await engine.kill();
      engine = await boot(mac);
      await engine.host.start(ACCOUNT);
    }
    await mail.clock.advance(2 * MINUTE);
    const log = mac.log.slice(logAt);
    const peak = peakWindow(log);
    t.diagnostic(`peak ${peak}, refusals ${refusals(log).length}, requests ${log.length}`);
    assert.ok(
      peak <= GMAIL_BUDGET.target.primary,
      `peak ${peak} units in a 60 s window across restarts`,
    );
    assert.equal(
      refusals(log).filter(e => e.batch === undefined).length,
      0,
      'no per-minute refusal of a whole request',
    );
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});
