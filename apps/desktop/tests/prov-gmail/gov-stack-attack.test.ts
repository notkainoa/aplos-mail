/**
 * prov-gov adversarial checks against the real stack: the store (SQLite on a temp file), the `Governor` and `ActorHost`
 * from `packages/engine/src/sync`, the Gmail adapter (`pace: false`, so the governor alone paces), the Gmail emulator
 * with the kit's fault injector, and one fake clock. Every count comes from the emulator's own request log. Each test
 * names the check it tries to break; a failing test here is a finding, not a flaky test.
 *
 * Wiring follows prov-gmail-e2e (the factory's `connect` is still a stub, so a test connect stands in for it).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GMAIL_BUDGET } from '../../src/host/providers/google/adapter';
import {
  ACCOUNT,
  MINUTE,
  HOUR,
  mailWorld,
  Mac,
  boot,
  runUntil,
  settle,
  accountRow,
  stateOf,
  localInbox,
  localInboxMessages,
  serverInbox,
  gmailOnly,
  refusals,
  methodsOf,
  diff,
  peakWindow,
  queueArchive,
  opRows,
  synced,
} from './gov-stack-rig';

// ---- the attacks ----

test('prov-gov-attack-01 op flush: a throttle on an archive requeues it and it reaches Gmail after the cooldown', async () => {
  const { mail, mac, engine } = await synced(120);
  try {
    const target = [...localInboxMessages(engine.store)].sort()[0];
    queueArchive(engine.store, 'archive-1', target);
    // One per-minute refusal on the flush's single `messages.modify`, exactly what Gmail answers under load.
    mail.faults.failNext(
      { apiMethod: 'gmail.users.messages.modify' },
      { status: 429, reason: 'rateLimitExceeded', message: 'User-rate limit exceeded' },
    );
    const logAt = mac.log.length;
    engine.host.opsChanged(ACCOUNT);
    await runUntil(
      mail.clock,
      () => refusals(mac.log.slice(logAt)).length > 0,
      'the refused modify',
      5 * MINUTE,
      50,
    );
    await mail.clock.advance(1_000);
    const afterRefusal = opRows(engine.store);
    // A throttle is the governor's pause, not the op's failure: the op waits, still replayed, and goes after the pause.
    await runUntil(
      mail.clock,
      () => !mail.emu.mailbox.getMessage(target)!.labelIds.includes('INBOX'),
      'the archive at Gmail',
      20 * MINUTE,
    ).catch(() => {});
    const atGmail = !mail.emu.mailbox.getMessage(target)!.labelIds.includes('INBOX');
    assert.ok(
      atGmail &&
        afterRefusal.every(
          r => r.state === 'queued' || r.state === 'inflight' || r.state === 'synced',
        ),
      `after one 429 the op row was ${JSON.stringify(afterRefusal)}; archive at Gmail 20 min later: ${atGmail}`,
    );
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

test('prov-gov-attack-02 fence: a local archive is not flipped back by a server search that raced its flush', async () => {
  const { mail, mac, engine } = await synced(150);
  try {
    // Search hits come back newest first; the newest Inbox thread's newest message is in the search's first batch.
    const newest = mail.emu.mailbox
      .select({ labelIds: ['INBOX'] })
      .map(m => mail.emu.mailbox.getMessage(m.id)!)
      .sort((a, b) => b.internalDate - a.internalDate)[0];
    assert.ok(localInboxMessages(engine.store).has(newest.id));
    // 1. The user archives it (local effect plus op, one local commit); the flush has not started yet.
    queueArchive(engine.store, 'archive-race', newest.id);
    assert.ok(!localInboxMessages(engine.store).has(newest.id), 'archived locally');
    // 2. The user presses Enter on a server search (25 hits: two or three metadata batches).
    const sentAt = mac.sent.length;
    const search = engine.host.search(ACCOUNT, { text: 'in:inbox', limit: 25 });
    search.catch(() => {});
    await runUntil(
      mail.clock,
      () => mac.sent.slice(sentAt).some(s => s.url.pathname === '/batch/gmail/v1'),
      'the first search batch',
      MINUTE,
      10,
    );
    // 3. The op hint arrives while the first batch (which holds the message, still in INBOX at Gmail) is in flight.
    engine.host.opsChanged(ACCOUNT);
    await settle(mail.clock, search);
    await runUntil(
      mail.clock,
      () => opRows(engine.store).every(r => r.state === 'synced'),
      'the flush',
      5 * MINUTE,
      50,
    );
    await mail.clock.advance(1_000);
    const order = methodsOf(
      gmailOnly(mac.log).filter(
        e => e.at >= mail.clock.now() - 2 * MINUTE && e.batch === undefined,
      ),
    );
    assert.ok(
      !mail.emu.mailbox.getMessage(newest.id)!.labelIds.includes('INBOX'),
      'archived at Gmail',
    );
    const flipped = localInboxMessages(engine.store).has(newest.id);
    // How long the user sees it back in the Inbox: until a later history pass reports the archive.
    const flippedAt = mail.clock.now();
    await runUntil(
      mail.clock,
      () => !localInboxMessages(engine.store).has(newest.id),
      'the next history pass',
      30 * MINUTE,
    ).catch(() => {});
    const healedAfter = mail.clock.now() - flippedAt;
    assert.ok(
      !flipped,
      `the archived message is back in the local Inbox after the search commit for ${Math.round(healedAfter / 1000)} s (calls: ${order.join(' ')})`,
    );
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

async function resyncLosses(splitRound: boolean): Promise<{ lost: string[]; fired: number }> {
  const { mail, mac, engine } = await synced(300);
  try {
    assert.deepEqual(localInbox(engine.store), serverInbox(mail), 'in step before the attack');
    for (let i = 0; i < 3; i++) {
      mail.emu.mailbox.addMessage({
        from: 'News <news@mail.example.test>',
        subject: `While away ${i}`,
        text: 'Synthetic.',
        labelIds: ['INBOX', 'UNREAD'],
      });
    }
    mail.emu.mailbox.expireHistory();
    if (splitRound) {
      mail.faults.failNext(
        { apiMethod: 'gmail.users.messages.get', after: 1 },
        { status: 429, reason: 'rateLimitExceeded', message: 'User-rate limit exceeded' },
      );
    }
    const before = stateOf(engine.store, 'window:inbox')!.generation;
    await runUntil(
      mail.clock,
      () => {
        const w = stateOf(engine.store, 'window:inbox');
        return w !== undefined && w.generation !== before && w.phase === 'done';
      },
      'the resync round',
      30 * MINUTE,
    );
    await mail.clock.advance(2 * MINUTE);
    return {
      lost: diff(serverInbox(mail), localInbox(engine.store)),
      fired: mail.faults.fired.length,
    };
  } finally {
    await engine.kill();
    mac.cleanup();
  }
}

test('prov-gov-attack-03a control: the same bounded resync in one step loses nothing', async () => {
  const { lost } = await resyncLosses(false);
  assert.deepEqual(lost, []);
});

test('prov-gov-attack-03 sweep: a bounded resync that spans two steps keeps every Inbox message it listed', async () => {
  const { mail, mac, engine } = await synced(300);
  try {
    assert.deepEqual(localInbox(engine.store), serverInbox(mail), 'in step before the attack');
    // A week away: three new Inbox threads arrive and the history cursor expires (404), so a bounded resync runs.
    for (let i = 0; i < 3; i++) {
      mail.emu.mailbox.addMessage({
        from: 'News <news@mail.example.test>',
        subject: `While away ${i}`,
        text: 'Synthetic.',
        labelIds: ['INBOX', 'UNREAD'],
      });
    }
    mail.emu.mailbox.expireHistory();
    // One part of the resync's metadata batch is refused (after the round's one `format=minimal` get), as Gmail does
    // now and then: the round stops after its first step and finishes in a second one.
    mail.faults.failNext(
      { apiMethod: 'gmail.users.messages.get', after: 1 },
      { status: 429, reason: 'rateLimitExceeded', message: 'User-rate limit exceeded' },
    );
    const before = stateOf(engine.store, 'window:inbox')!.generation;
    await runUntil(
      mail.clock,
      () => {
        const w = stateOf(engine.store, 'window:inbox');
        return w !== undefined && w.generation !== before && w.phase === 'done';
      },
      'the resync round',
      30 * MINUTE,
    );
    await mail.clock.advance(2 * MINUTE);
    const fired = mail.faults.fired.length;
    const lost = diff(serverInbox(mail), localInbox(engine.store));
    assert.equal(fired, 1, 'the injected refusal fired');
    assert.deepEqual(
      lost,
      [],
      `${lost.length} Inbox threads Gmail still has were swept out of the local Inbox`,
    );
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

test('prov-gov-attack-04 baseline: a cursor reset before the first 50 threads still sets baseline_done_at', async () => {
  const mail = mailWorld(200);
  const mac = new Mac(mail, 'mac-a');
  const engine = await boot(mac);
  try {
    // The first window's list fails twice with 503 (three governor tries each), so it backs off past the first poll.
    mail.faults.failNext(
      { apiMethod: 'gmail.users.messages.list' },
      { status: 503, reason: 'backendError', message: 'Backend Error' },
      { times: 6 },
    );
    await engine.host.start(ACCOUNT);
    await runUntil(
      mail.clock,
      () => stateOf(engine.store, 'history')?.cursor != null,
      'the cursor (P0)',
      5 * MINUTE,
      50,
    );
    // Meanwhile a burst of 160 new Inbox messages lands (a list digest, an import on the web): more than one pass fetches.
    for (let i = 0; i < 160; i++) {
      mail.emu.mailbox.addMessage({
        from: `Burst ${i} <burst${i}@mail.example.test>`,
        subject: `Burst ${i}`,
        text: 'Synthetic.',
        labelIds: ['INBOX', 'UNREAD'],
      });
    }
    await runUntil(
      mail.clock,
      () => accountRow(engine.store).baseline_done_at !== null,
      'baseline_done_at',
      30 * MINUTE,
    ).catch(() => {});
    const row = accountRow(engine.store);
    const window = stateOf(engine.store, 'window:inbox');
    assert.notEqual(
      row.baseline_done_at,
      null,
      `30 min after start: baseline_done_at null, status ${row.status}, window:inbox phase ${window?.phase}, sent:recent ${stateOf(engine.store, 'sent:recent') ? 'seeded' : 'never seeded'}, local threads ${localInbox(engine.store).size}`,
    );
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

// Known and accepted until `sync/lease.ts` lands (plan 20 PV3): with no lease input both Macs run as primary. ARCH 6.5
// calls the lease soft ("if two devices both act as primary, AIMD and cooldowns absorb it"), and a secondary default
// with no lease would leave every Mac without backfill and prefetch (primary-only lanes). Kept as a todo so it turns
// green, and is noticed, once the lease supplies the role.
test(
  'prov-gov-attack-05 two devices with no lease input stay under the combined primary + secondary target',
  { todo: 'needs the primary-device lease (sync/lease.ts, PV3)' },
  async t => {
    const mail = mailWorld(2_000);
    const macA = new Mac(mail, 'mac-a');
    const macB = new Mac(mail, 'mac-b');
    // No lease module yet: neither Mac is told its role, as on a real install today.
    const a = await boot(macA);
    const b = await boot(macB);
    try {
      const emuAt = mail.emu.log.length;
      await a.host.start(ACCOUNT);
      await b.host.start(ACCOUNT);
      // Both first syncs run side by side for 20 minutes (window, then backfill).
      const startedAt = mail.clock.now();
      await runUntil(
        mail.clock,
        () => mail.clock.now() >= startedAt + 20 * MINUTE,
        '20 minutes',
        HOUR,
        1_000,
      );
      const all = mail.emu.log.slice(emuAt);
      const roles = [a.host.status(ACCOUNT)?.lease?.role, b.host.status(ACCOUNT)?.lease?.role];
      const combined = peakWindow(all);
      t.diagnostic(
        `roles ${roles.join('/')}; combined peak ${combined}; refusals ${refusals(all).length}`,
      );
      const cap = GMAIL_BUDGET.target.primary + GMAIL_BUDGET.target.secondary;
      assert.ok(
        roles.includes('secondary') && combined <= cap,
        `roles ${roles.join('/')} (no Mac runs as secondary), combined peak ${combined} vs ${cap}, refusals ${refusals(all).length}`,
      );
    } finally {
      await a.kill();
      await b.kill();
      macA.cleanup();
      macB.cleanup();
    }
  },
);
