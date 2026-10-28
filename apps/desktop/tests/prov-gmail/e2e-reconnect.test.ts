/**
 * prov-gmail end to end, continued: the weekly reconnect and two devices on one account. Same rig as e2e.test.ts
 * (`e2e-rig.ts`): the real store, governor and `ActorHost`, the Gmail adapter and the emulator on one fake clock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '@aplos/engine/ports';
import {
  ACCOUNT,
  MINUTE,
  HOUR,
  DAY,
  PRIMARY_TARGET,
  SECONDARY_TARGET,
  OTHER_USER,
  mailWorld,
  Mac,
  boot,
  runUntil,
  settle,
  sql,
  accountRow,
  stateOf,
  windowDone,
  statusOf,
  refusals,
  methodsOf,
  peakWindow,
  queueArchive,
  openOps,
  threadIds,
} from './e2e-rig';

test('prov-gmail-T26/T62 prov-gov-T49/T53/T54 weekly reconnect: invalid_grant, queued archives, wrong account refused, flush with zero resync', async () => {
  const mail = mailWorld(200);
  mail.emu.addUser(OTHER_USER);
  const mac = new Mac(mail, 'mac-a');
  let engine = await boot(mac);
  try {
    const reconnectBy = accountRow(engine.store).refresh_expires_at!;
    assert.equal(
      reconnectBy,
      mail.clock.now() + 7 * DAY,
      'Testing mode: the grant dies 7 days after consent',
    );
    await engine.host.start(ACCOUNT);
    await runUntil(
      mail.clock,
      () => stateOf(engine.store, 'sent:recent')?.phase === 'done',
      'the first sync',
    );
    const baseline = accountRow(engine.store).baseline_done_at;

    // The Mac is shut for most of the week, then runs on battery with no window (5-minute polls, an hourly token
    // refresh) through the last hours of the grant, until the refresh is refused.
    // Mail keeps arriving meanwhile, so the history cursor moves on with each poll (a quiet mailbox is not this test).
    await engine.kill();
    for (let day = 1; day <= 6; day++) {
      await mail.clock.advanceTo(reconnectBy - 7 * DAY + day * DAY);
      mail.emu.mailbox.addMessage({
        from: 'Daily Digest <digest@mail.example.test>',
        to: [mail.address],
        subject: `Digest ${day}`,
        text: 'A synthetic digest.',
        labelIds: ['INBOX', 'UNREAD'],
      });
    }
    await mail.clock.advanceTo(reconnectBy - 3 * HOUR);
    engine = await boot(mac);
    mail.env = { ...mail.env, windowVisible: false, onBattery: true };
    await engine.host.start(ACCOUNT);
    await runUntil(
      mail.clock,
      () => statusOf(engine)?.state === 'needsReauth',
      'needsReauth',
      6 * HOUR,
      MINUTE,
    );
    const dead = mac.log.filter(e => e.service === 'oauth' && e.status === 400);
    assert.equal(dead.length, 1, 'one refused refresh');
    assert.equal(dead[0].reason, 'invalid_grant');
    assert.ok(dead[0].at >= reconnectBy);
    assert.equal(mac.log.at(-1), dead[0], 'nothing after the refused refresh');
    assert.equal(accountRow(engine.store).status_reason_code, 'auth.testingModeExpiry');

    // Ten archives made while expired queue locally; 24 hours of manual syncs, wakes and op hints send nothing.
    const inbox = sql<{ id: string }>(
      engine.store,
      `SELECT m.remote_id AS id FROM message_folders mf JOIN messages m ON m.id = mf.message_id JOIN folders f ON f.id = mf.folder_id
      WHERE m.account_id = ? AND f.remote_id = 'INBOX' ORDER BY m.remote_id LIMIT 10`,
      ACCOUNT,
    ).map(r => r.id);
    assert.equal(inbox.length, 10);
    inbox.forEach((id, i) => queueArchive(engine.store, `archive-${i}`, id));
    const logAt = mac.log.length;
    for (let i = 0; i < 24; i++) {
      assert.equal(engine.host.request(ACCOUNT, { manual: true }).ok, false);
      engine.host.opsChanged(ACCOUNT);
      engine.host.wake('network');
      await mail.clock.advance(HOUR);
    }
    assert.equal(mac.log.length, logAt, 'zero Gmail and zero token-endpoint calls while expired');
    assert.equal(openOps(engine.store).length, 10, 'the archives wait, in order');
    const cursor = stateOf(engine.store, 'history')!.cursor;

    // D25: consent as another Google account is refused and changes nothing.
    const vaultBefore = mac.vault.refreshToken;
    mail.pick = OTHER_USER.email;
    await assert.rejects(
      settle(
        mail.clock,
        engine.host.connect(ACCOUNT, 'google', {
          mode: 'reconnect',
          loginHint: mail.address,
          expectedSubject: mail.subject,
        }),
      ),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.error.class === 'auth' &&
        error.error.reason === 'wrongAccount',
    );
    mail.pick = undefined;
    assert.equal(mac.vault.refreshToken, vaultBefore, 'the foreign grant is not kept');
    assert.equal(accountRow(engine.store).remote_subject, mail.subject);
    assert.equal(accountRow(engine.store).refresh_expires_at, reconnectBy);
    assert.equal(statusOf(engine)?.state, 'needsReauth');
    await mail.clock.advance(MINUTE);
    assert.deepEqual(
      methodsOf(mac.log.slice(logAt)),
      ['oauth.token'],
      "only the refused account's code exchange",
    );
    assert.equal(openOps(engine.store).length, 10, 'no flush after a refused reconnect');

    // The same account through the consent screen with login_hint: reconnected() flushes and resumes, no resync.
    const exchangeAt = mac.log.length;
    const result = await settle(
      mail.clock,
      engine.host.connect(ACCOUNT, 'google', {
        mode: 'reconnect',
        loginHint: mail.address,
        expectedSubject: mail.subject,
      }),
    );
    assert.equal(result.identity.subject, mail.subject);
    const resumeAt = mail.clock.now();
    await engine.host.reconnected(ACCOUNT, result);
    await runUntil(
      mail.clock,
      () =>
        openOps(engine.store).length === 0 && stateOf(engine.store, 'history')?.cursor !== cursor,
      'flush and a history pass',
      10 * MINUTE,
      50,
    );
    await mail.clock.advance(2 * MINUTE);
    const after = mac.log.slice(exchangeAt);
    const calls = methodsOf(after.filter(e => e.apiMethod !== 'gmail.batch'));
    assert.equal(calls[0], 'oauth.token', 'the code exchange');
    assert.equal(
      calls[1],
      'messages.batchModify',
      'the queued archives go first, as one batchModify',
    );
    assert.equal(calls.filter(c => c === 'messages.batchModify').length, 1);
    assert.equal(calls[2], 'history.list', 'then history from the stored cursor');
    for (const resync of [
      'messages.list',
      'threads.list',
      'threads.get',
      'messages.get',
      'getProfile',
    ]) {
      assert.ok(!calls.includes(resync), `no ${resync} after the reconnect: ${calls.join(' ')}`);
    }
    const batch = mac.sent.find(
      s => s.at >= resumeAt && s.url.pathname.endsWith('/messages/batchModify'),
    )!;
    const body = JSON.parse(batch.body!) as { ids: string[]; removeLabelIds?: string[] };
    assert.deepEqual([...body.ids].sort(), [...inbox].sort());
    assert.deepEqual(body.removeLabelIds, ['INBOX']);
    for (const id of inbox)
      assert.ok(
        !mail.emu.mailbox.getMessage(id)!.labelIds.includes('INBOX'),
        `${id} archived at Gmail`,
      );
    const row = accountRow(engine.store);
    assert.equal(row.baseline_done_at, baseline, 'baseline_done_at unchanged');
    assert.equal(row.remote_subject, mail.subject);
    assert.ok(
      row.refresh_expires_at! >= resumeAt + 7 * DAY - MINUTE,
      'reconnectBy moves a week on',
    );
    assert.equal(statusOf(engine)?.state, 'ok');
    assert.equal(refusals(after).length, 0);
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

test('prov-gov-T39 prov-gmail-T57 two devices on one account stay under 6,000 combined in every window', async t => {
  const mail = mailWorld(600);
  const macA = new Mac(mail, 'mac-a');
  const macB = new Mac(mail, 'mac-b');
  const a = await boot(macA, 'primary');
  const b = await boot(macB, 'secondary');
  try {
    const start = mail.clock.now();
    const emuAt = mail.emu.log.length;
    const [aAt, bAt] = [macA.log.length, macB.log.length];
    await a.host.start(ACCOUNT);
    await b.host.start(ACCOUNT);
    // The secondary opens what it has while the primary runs its first sync: interactive load on both at once.
    await runUntil(
      mail.clock,
      () => accountRow(b.store).baseline_done_at !== null,
      "the secondary's baseline",
    );
    const toOpen = [...threadIds(b.store)].slice(0, 40);
    const opens = Promise.all(toOpen.map(id => b.host.openThread(ACCOUNT, id)));
    await settle(mail.clock, opens);
    await runUntil(mail.clock, () => windowDone(a.store), "the primary's first window");
    await runUntil(
      mail.clock,
      () => mail.clock.now() >= start + 30 * MINUTE,
      '30 minutes',
      HOUR,
      1_000,
    );

    const all = mail.emu.log.slice(emuAt);
    const logA = macA.log.slice(aAt);
    const logB = macB.log.slice(bAt);
    assert.equal(
      logA.length + logB.length,
      all.length,
      'every request is attributed to one device',
    );
    const combined = peakWindow(all);
    const peakA = peakWindow(logA);
    const peakB = peakWindow(logB);
    t.diagnostic(`peaks: combined ${combined}, primary ${peakA}, secondary ${peakB}`);
    assert.equal(refusals(all).length, 0, 'zero refusals');
    assert.ok(combined <= 6_000, `combined peak ${combined}`);
    assert.ok(peakA <= PRIMARY_TARGET, `primary peak ${peakA}`);
    assert.ok(peakB <= SECONDARY_TARGET, `secondary peak ${peakB}`);
    assert.ok(peakA > SECONDARY_TARGET, 'the primary really used its larger share');
    // The secondary drops backfill: it keeps its baseline and polls, and never runs the rest of the window.
    assert.notEqual(stateOf(b.store, 'window:inbox')?.phase, 'done');
    assert.equal(b.host.status(ACCOUNT)?.lease?.role, 'secondary');
  } finally {
    await a.kill();
    await b.kill();
    macA.cleanup();
    macB.cleanup();
  }
});
