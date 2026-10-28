/**
 * prov-gmail end to end on the Gmail emulator: the real store (SQLite on a temp file, opened as the store's own tests
 * open it), the real governor and `ActorHost` from `packages/engine/src/sync`, the Gmail adapter, the emulator's OAuth
 * behind a test `TokenSource` (no vault) and one fake clock. Nothing is stubbed between the actor and the emulator, and
 * every count below is read from the emulator's own request log; the fetch spy only adds what the log leaves out on
 * purpose (ids and query strings).
 *
 * `connect` is still a `NotInThisLaneError` stub in the adapter (the OAuth host is not built yet), so the factory here
 * wraps `createGoogleProvider` and supplies a test connect: the emulator's consent with `login_hint`, the code exchange
 * on the `oauth` budget through the connect-mode governor, and the D25 `sub` check.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT,
  MINUTE,
  HOUR,
  PRIMARY_TARGET,
  mailWorld,
  Mac,
  boot,
  runUntil,
  settle,
  sql,
  accountRow,
  stateOf,
  threadCount,
  messageIds,
  threadIds,
  localInbox,
  serverInbox,
  windowDone,
  statusOf,
  gmailCalls,
  refusals,
  methodsOf,
  peakWindow,
  metadataFetches,
} from './e2e-rig';

// ---- the scenarios ----

test('prov-gmail-T04/T05/T11/T34 prov-gov-T11 D1 inverted end to end: a 600-thread first window through the governor', async () => {
  const mail = mailWorld(600);
  const mac = new Mac(mail, 'mac-a');
  const engine = await boot(mac);
  try {
    const start = mail.clock.now();
    const since = mac.log.length;
    await engine.host.start(ACCOUNT);

    // AM-4: baseline_done_at is set by the commit that holds the first ~50 threads, well inside 15 s.
    await runUntil(
      mail.clock,
      () => accountRow(engine.store).baseline_done_at !== null,
      'the baseline',
    );
    const atBaseline = threadCount(engine.store);
    assert.ok(
      atBaseline >= 50 && atBaseline <= 100,
      `${atBaseline} threads when baseline_done_at was set`,
    );
    assert.ok(
      accountRow(engine.store).baseline_done_at! - start < 15_000,
      'first 50 threads in under 15 s',
    );

    await runUntil(mail.clock, () => windowDone(engine.store), 'the first window');
    const window = mac.log.slice(since);
    assert.equal(refusals(window).length, 0, 'zero 403/429 in the whole first window');
    const peak = peakWindow(window);
    assert.ok(
      peak <= PRIMARY_TARGET,
      `peak ${peak} units in a 60 s window, target ${PRIMARY_TARGET}`,
    );
    assert.deepEqual(
      localInbox(engine.store),
      serverInbox(mail),
      'the local Inbox is the server Inbox',
    );
    // Sent (P3) starts right after the window, so the account shows `backfilling` or `ok`, never a refusal.
    assert.ok(['ok', 'backfilling'].includes(statusOf(engine)!.state), statusOf(engine)!.state);

    // Every thread row is partial (metadata only) until it is opened.
    const complete = () =>
      sql<{ n: number }>(
        engine.store,
        'SELECT COUNT(*) AS n FROM threads WHERE account_id = ? AND complete = 1',
        ACCOUNT,
      )[0].n;
    assert.equal(complete(), 0, 'no thread is complete before it is opened');

    // AM-1: a thread not known to have exactly one message opens with one threads.get full. Sent (P3) finishes
    // first, so the only other traffic is the history poll.
    await runUntil(
      mail.clock,
      () => stateOf(engine.store, 'sent:recent')?.phase === 'done',
      'Sent to finish',
    );
    assert.equal(refusals(mac.log).length, 0);
    assert.ok(peakWindow(mac.log) <= PRIMARY_TARGET);
    const pick = sql<{ id: string; count: number | null }>(
      engine.store,
      'SELECT remote_id AS id, remote_count AS count FROM threads WHERE account_id = ? AND (remote_count IS NULL OR remote_count > 1) LIMIT 1',
      ACCOUNT,
    )[0];
    const openAt = mail.clock.now();
    const logAt = mac.log.length;
    const sentAt = mac.sent.length;
    const opened = await settle(
      mail.clock,
      engine.host.openThread(
        ACCOUNT,
        pick.id,
        pick.count === null ? {} : { knownCount: pick.count },
      ),
    );
    // History polls may run beside the open; everything else in the log is the open itself.
    const openCalls = gmailCalls(mac.log.slice(logAt), openAt).filter(
      e => e.apiMethod !== 'gmail.users.history.list',
    );
    assert.deepEqual(methodsOf(openCalls), ['threads.get']);
    const openSent = mac.sent
      .slice(sentAt)
      .filter(s => s.url.pathname.endsWith(`/threads/${pick.id}`));
    assert.equal(openSent.length, 1);
    assert.equal(openSent[0].url.searchParams.get('format'), 'full');
    assert.ok(opened.messages.length >= 1);
    assert.equal(complete(), 1, 'the opened thread is complete; every other one stays partial');
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

test('prov-gmail-T13 prov-gov-T21/T33/T41 kill mid-backfill and restart; then prov-gmail-T39 2,000 threads archived elsewhere', async t => {
  // 2,800 threads: about 2,070 in the Inbox, so the window stops at its 500-thread cap and backfill:inbox has work.
  const mail = mailWorld(2_800);
  const mac = new Mac(mail, 'mac-a');
  let engine = await boot(mac);
  try {
    await t.test(
      'prov-gmail-T13 prov-gov-T21/T33 a kill mid-backfill resumes from the stored page; spend and cooldown survive',
      async () => {
        await engine.host.start(ACCOUNT);
        // Mid-backfill: at least one backfill page committed with entries still to fetch.
        await runUntil(
          mail.clock,
          () => {
            const s = stateOf(engine.store, 'backfill:inbox');
            return s?.phase === 'running' && s.pending !== null;
          },
          'a committed backfill:inbox page',
        );
        // A per-minute refusal right before the kill, so there is a cooldown to carry over.
        // (A long first sync may already have met one: batches grow past 10 parts after quiet minutes, and the
        // emulator refuses a part of a big batch now and then, as Gmail does.)
        const natural = refusals(mac.log).length;
        t.diagnostic(`refusals before the provoked one: ${natural}`);
        const provokedAt = mail.clock.now();
        mail.emu.settings.unitsPerMinute = 1;
        await runUntil(
          mail.clock,
          () => refusals(mac.log.filter(e => e.at >= provokedAt)).length > 0,
          'a throttle refusal',
          5 * MINUTE,
          50,
        );
        mail.emu.settings.unitsPerMinute = 6_000;
        const refusedAt = mail.clock.now();
        const before = engine.governor.snapshot(ACCOUNT).find(s => s.budget === 'gmail')!;
        assert.ok(
          before.cooldownUntil !== undefined && before.cooldownUntil > mail.clock.now(),
          'the refusal started a cooldown',
        );
        // Units the emulator charged in the minute before the kill: the restarted governor must not spend them again.
        const killAt = mail.clock.now();
        const chargedThisMinute = mac.log
          .filter(e => e.at > killAt - MINUTE)
          .reduce((sum, e) => sum + e.units, 0);
        const stored = stateOf(engine.store, 'backfill:inbox')!;
        const committedMessages = messageIds(engine.store);
        const committedThreads = threadIds(engine.store);
        await engine.kill();

        engine = await boot(mac);
        const sentAt = mac.sent.length;
        const logAt = mac.log.length;
        await engine.host.start(ACCOUNT);
        // Restored before the first request: the cooldown exactly, and a spend that covers what the minute already used.
        const after = engine.governor.snapshot(ACCOUNT).find(s => s.budget === 'gmail')!;
        assert.equal(after.cooldownUntil, before.cooldownUntil);
        assert.equal(after.cooldownStep, before.cooldownStep);
        assert.equal(after.target, before.target);
        assert.ok(
          after.windowSpent >= chargedThisMinute,
          `restored spend ${after.windowSpent} >= ${chargedThisMinute} charged`,
        );
        assert.equal(after.windowAt, before.windowAt);
        assert.equal(statusOf(engine)?.state, 'paused', 'the restarted account shows the pause');

        // Zero requests until the restored cooldown ends, then the backfill resumes where it stopped.
        await mail.clock.advanceTo(before.cooldownUntil! - 1);
        assert.equal(
          mac.log.length,
          logAt,
          'nothing reaches Gmail (or the token endpoint) during the restored cooldown',
        );
        await runUntil(
          mail.clock,
          () => stateOf(engine.store, 'backfill:inbox')?.phase === 'done',
          'the backfill to finish',
          2 * HOUR,
        );
        const resumed = metadataFetches(mac.sent.slice(sentAt));
        const pending = JSON.parse(stored.pending!) as string[];
        // The stored page's pending entries are what the backfill fetched after the restart: none lost, none twice.
        const resumedSet = new Set(resumed);
        assert.deepEqual(
          pending.filter(entry => !resumedSet.has(entry)),
          [],
          'every stored pending entry is fetched',
        );
        // Only a part Gmail refused (a big batch's occasional 429) is fetched again, once, after the cooldown.
        const after429 = refusals(mac.log.slice(logAt));
        assert.ok(
          after429.every(e => e.batch !== undefined && e.reason === 'rateLimitExceeded'),
          'only batch-part refusals',
        );
        assert.ok(
          resumed.length - resumedSet.size <= after429.length,
          'nothing answered is fetched twice after the restart',
        );
        const lists = mac.sent
          .slice(sentAt)
          .filter(
            s =>
              s.url.pathname.endsWith('/messages') &&
              s.url.searchParams.get('labelIds') === 'INBOX',
          );
        // The next Inbox page listed is the stored one; the backfill never lists the Inbox from the top again.
        assert.ok(lists.length > 0);
        assert.equal(
          lists[0].url.searchParams.get('pageToken'),
          stored.page_token,
          'the first Inbox list is the stored page',
        );
        assert.ok(
          lists.every(list => list.url.searchParams.get('pageToken')),
          'no Inbox list from the top',
        );
        for (const entry of resumed) {
          const thread = entry.startsWith('thread:') ? entry.slice(7) : undefined;
          assert.ok(
            thread ? !committedThreads.has(thread) : !committedMessages.has(entry),
            `committed ${entry} fetched again`,
          );
        }
        assert.deepEqual(
          localInbox(engine.store),
          serverInbox(mail),
          'thread counts match the server',
        );
        // The restart never re-spent the minute.
        t.diagnostic(`batch-part refusals after the restart: ${after429.length}`);
        assert.ok(peakWindow(mac.log.filter(e => e.at > refusedAt)) <= PRIMARY_TARGET);
      },
    );

    await t.test(
      'prov-gmail-T39 prov-gov-T59 2,000 threads archived elsewhere: the next pass costs under 2,500 units',
      async () => {
        await runUntil(
          mail.clock,
          () =>
            stateOf(engine.store, 'sent:recent')?.phase === 'done' &&
            stateOf(engine.store, 'backfill:inbox')?.phase === 'done',
          'Sent and backfill to finish',
        );
        // Let a poll pass so the next one is purely the archive.
        await mail.clock.advance(2 * MINUTE);
        const archived = mail.emu.mailbox.archiveThreads(2_000);
        assert.equal(archived.length, 2_000);
        const since = mail.clock.now();
        const logAt = mac.log.length;
        const cursor = () => stateOf(engine.store, 'history')?.cursor;
        const target = String(mail.emu.mailbox.history.currentId);
        await runUntil(mail.clock, () => cursor() === target, 'history to catch up', 10 * MINUTE);
        const pass = mac.log.slice(logAt);
        const units = pass.reduce((sum, e) => sum + e.units, 0);
        t.diagnostic(
          `2,000-thread archive: ${units} units over ${gmailCalls(pass, since).length} requests`,
        );
        assert.ok(units < 2_500, `${units} units`);
        assert.equal(
          gmailCalls(pass).filter(e => /(messages|threads)\.get$/.test(e.apiMethod)).length,
          0,
          'label-only changes fetch nothing',
        );
        assert.deepEqual(
          localInbox(engine.store),
          serverInbox(mail),
          'the local Inbox matches the emulator',
        );
        assert.equal(refusals(pass).length, 0);
      },
    );
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

test('prov-gmail-T23 prov-gov-T19/T29 quotaExceeded: one request, paused until Pacific midnight, manual sync refused, resumes after', async () => {
  const mail = mailWorld(120);
  const mac = new Mac(mail, 'mac-a');
  const engine = await boot(mac);
  try {
    await engine.host.start(ACCOUNT);
    await runUntil(
      mail.clock,
      () => stateOf(engine.store, 'sent:recent')?.phase === 'done',
      'the first sync',
    );
    mail.emu.setDailyLimit('quotaExceeded');
    const resetsAt = mail.emu.dailyLimit()!.resetsAt;
    // The fake clock starts 2026-10-27 09:00 PDT: the next Pacific midnight is 07:00 UTC on the 28th.
    assert.equal(resetsAt, Date.UTC(2026, 9, 28, 7, 0, 0));
    const logAt = mac.log.length;
    assert.equal(engine.host.request(ACCOUNT, { manual: true }).ok, true);
    await runUntil(mail.clock, () => statusOf(engine)?.state === 'paused', 'the daily stop');
    const stop = mac.log.slice(logAt);
    assert.deepEqual(methodsOf(stop), ['history.list'], 'exactly one request');
    assert.equal(stop[0].reason, 'quotaExceeded');
    assert.deepEqual(statusOf(engine), {
      state: 'paused',
      until: resetsAt,
      class: 'daily',
      reason: 'quotaExceeded',
    });
    assert.equal(accountRow(engine.store).status_reason_code, 'quota.daily');

    // Ten hours of manual syncs (plain and "Retry now") and wakes: every one refused with zero requests.
    for (let i = 0; i < 30; i++) {
      const plain = engine.host.request(ACCOUNT, { manual: true });
      const forced = engine.host.request(ACCOUNT, { manual: true, force: true });
      for (const admission of [plain, forced]) {
        assert.equal(admission.ok, false);
        if (!admission.ok) {
          assert.equal(admission.cls, 'daily');
          assert.equal(admission.until, resetsAt);
        }
      }
      engine.host.wake('wake');
      await mail.clock.advance(20 * MINUTE);
    }
    await mail.clock.advanceTo(resetsAt - 1_000);
    assert.equal(mac.log.length, logAt + 1, 'still the one request just before midnight');

    // After midnight Pacific the account resumes on its own.
    await runUntil(
      mail.clock,
      () => gmailCalls(mac.log, resetsAt).some(e => e.status > 0),
      'the first answer after midnight',
      10 * MINUTE,
    );
    const first = gmailCalls(mac.log, resetsAt)[0];
    assert.ok(first.at >= resetsAt);
    assert.equal(first.status, 200);
    await runUntil(mail.clock, () => statusOf(engine)?.state === 'ok', 'status ok', 10 * MINUTE);
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});
