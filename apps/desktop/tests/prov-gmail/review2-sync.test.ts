/**
 * prov-gmail review 2, sync defects on the Gmail emulator: a cursor reset still delivers Inbox mail beyond the resync's
 * 50 threads (through the re-seeded backfill, at bounded cost); one message that always fails is quarantined instead
 * of pinning the history cursor or holding the Inbox window open; and an Inbox gain undone later on the same history
 * page fetches nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { googleError, type FaultHook } from '@aplos/emulators';
import { FAILURES_KEY } from '../../src/host/providers/google/failures';
import { gmailLog, rig, type Rig } from './harness';

const phaseOf = (r: Rig, scope: 'window:inbox' | 'backfill:inbox' | 'sent:recent') =>
  r.store.states.get(scope)?.phase;
const windowDone = (r: Rig) => () => phaseOf(r, 'window:inbox') === 'done';
/** The window and every other list scope that exists have finished, so nothing but history spends units afterwards. */
const settled = (r: Rig) => () =>
  windowDone(r)() &&
  (['backfill:inbox', 'sent:recent'] as const).every(
    scope => !r.store.states.has(scope) || phaseOf(r, scope) === 'done',
  );
const unitsSince = (r: Rig, since: number) =>
  r.emu.log.filter(e => e.at >= since).reduce((sum, e) => sum + e.units, 0);
const gets = (r: Rig, since: number) =>
  gmailLog(r.emu, since).filter(e => /(messages|threads)\.get$/.test(e.apiMethod));
const historyPoll = (r: Rig) => r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 1 });

/** Answers 500 to every metadata get of the ids (message or thread) in `poison`. */
function poisonHook(poison: Set<string>): FaultHook {
  return {
    intercept(request) {
      const id = /\/(?:messages|threads)\/([0-9a-f]+)$/.exec(request.path)?.[1];
      if (!id || !poison.has(id)) return undefined;
      return { kind: 'respond', response: googleError(500, 'backendError') };
    },
  };
}

function newMail(r: Rig, subject: string) {
  return r.emu.mailbox.addMessage({
    from: 'Hello <hello@quillonlabs.example.test>',
    to: [r.account.address],
    subject,
    text: 'x',
    labelIds: ['INBOX', 'UNREAD'],
  });
}

test('review2-sync D10 a changeCapExceeded reset still brings every new Inbox thread in, through the re-seeded backfill, at bounded cost', async t => {
  const r = await rig({ threads: 600 });
  await r.drive({ until: settled(r), maxSteps: 400 });
  await r.clock.advance(60_000);
  // Offline for a week: 170 new Inbox threads, more than the change cap (150) and the resync (50).
  const fresh = Array.from({ length: 170 }, (_, i) => newMail(r, `Synthetic news ${i}`));
  const start = r.clock.now();
  const metadataBefore = r.metadataGets().length;

  await historyPoll(r);
  assert.equal(r.store.commits.at(-1)!.result.reset, 'changeCapExceeded');
  await r.drive({ trigger: 'reset', until: windowDone(r), maxSteps: 20 });
  const resyncFetches = gets(r, start).length;
  assert.ok(resyncFetches <= 51, `${resyncFetches} fetches: the resync stays bounded (D10)`);
  assert.equal(phaseOf(r, 'backfill:inbox'), undefined, 'the resync re-seeded backfill:inbox');

  await r.drive({
    until: () => phaseOf(r, 'backfill:inbox') === 'done',
    scopes: ['backfill:inbox'],
    maxSteps: 50,
  });
  assert.equal(phaseOf(r, 'backfill:inbox'), 'done');
  const inbox = r.store.threadsIn('INBOX');
  const missing = fresh.filter(m => !r.store.rows.get(m.id)?.folders.has('INBOX'));
  assert.equal(
    missing.length,
    0,
    `${missing.length} of the 170 new messages not in the local Inbox`,
  );
  for (const m of fresh) assert.ok(inbox.has(m.threadId), 'each new thread is in the local Inbox');

  const units = unitsSince(r, start);
  const fetched = r.metadataGets().slice(metadataBefore);
  t.diagnostic(`reset + backfill: ${units} units, ${fetched.length} metadata gets`);
  assert.deepEqual(
    new Set(fetched),
    new Set(fresh.map(m => m.id)),
    'only the new mail is fetched, each once: stored mail is skipped',
  );
  assert.equal(fetched.length, fresh.length);
  // 170 metadata gets (20 each), one date probe (20), the history page and a handful of 5-unit list pages.
  assert.ok(units < 170 * 20 + 150, `${units} units`);
});

test('review2-sync a message whose fetch always fails is quarantined after 3 polls; the history cursor moves on and healthy mail arrives', async () => {
  const poison = new Set<string>();
  const r = await rig({ threads: 120, emulator: { faults: poisonHook(poison) } });
  await r.drive({ until: windowDone(r), maxSteps: 100 });
  await r.clock.advance(60_000);
  const bad = newMail(r, 'Synthetic poison');
  poison.add(bad.id);
  const healthy = [1, 2, 3].map(i => newMail(r, `Synthetic healthy ${i}`));

  await historyPoll(r);
  for (const m of healthy) assert.ok(r.store.rows.get(m.id)?.folders.has('INBOX'));
  for (let poll = 2; poll <= 3; poll++) {
    assert.notEqual(
      r.store.states.get('history')!.cursor,
      String(r.emu.mailbox.history.currentId),
      'the cursor waits while the message may still succeed',
    );
    // One failure counts per entry per 5 minutes, so a short outage cannot quarantine a healthy message.
    await r.clock.advance(6 * 60_000);
    await historyPoll(r);
  }
  const history = r.store.states.get('history')!;
  assert.equal(history.cursor, String(r.emu.mailbox.history.currentId), 'cursor advanced');
  assert.equal(history.pending, undefined);
  const quarantined = r.store.commits.flatMap(c => c.result.quarantine ?? []).map(q => q.item);
  assert.deepEqual(quarantined, [bad.id]);
  assert.equal(r.metadataGets().filter(id => id === bad.id).length, 3, 'tried exactly 3 times');
  assert.ok(!r.store.memory.has(FAILURES_KEY), 'the failure count is cleared once quarantined');
  assert.ok(
    r.log.lines.some(l => l.event === 'sync.gmail.request_refused' && l.fields.attempt === 3),
    'the quarantine is logged with its attempt count',
  );

  // New mail after it syncs normally, and the quarantined message is not tried again.
  const later = newMail(r, 'Synthetic later');
  await r.clock.advance(60_000);
  await historyPoll(r);
  assert.ok(r.store.rows.get(later.id)?.folders.has('INBOX'), 'new mail arrives');
  assert.equal(r.metadataGets().filter(id => id === bad.id).length, 3);
});

test('review2-sync a message whose fetch always fails does not hold the Inbox window open; the rest syncs and Sent can start', async () => {
  const poison = new Set<string>();
  const r = await rig({ threads: 120, emulator: { faults: poisonHook(poison) } });
  const inboxThreads = r.emu.mailbox.selectThreads({ labelIds: ['INBOX'] }).map(th => th.id);
  const badThread = inboxThreads[0];
  poison.add(badThread);
  for (const id of r.emu.mailbox.threadMessageIds(badThread)) poison.add(id);

  for (let round = 0; round < 6 && phaseOf(r, 'window:inbox') !== 'done'; round++) {
    await r.drive({ until: windowDone(r), maxSteps: 60 });
    await r.clock.advance(6 * 60_000);
  }
  assert.equal(phaseOf(r, 'window:inbox'), 'done', 'the window round ends');
  const quarantined = r.store.commits.flatMap(c => c.result.quarantine ?? []).map(q => q.item);
  assert.equal(quarantined.length, 1);
  assert.ok(poison.has(quarantined[0]));
  const local = r.store.threadsIn('INBOX');
  for (const id of inboxThreads.slice(1)) assert.ok(local.has(id), 'every healthy Inbox thread');
  assert.ok(!r.store.memory.has(FAILURES_KEY));
  const steps = r.adapter.plan({
    account: r.account,
    states: [...r.store.states.values()],
    trigger: 'poll',
    env: r.env(),
    memory: r.store.memory,
  });
  assert.ok(
    steps.some(s => s.scope === 'sent:recent'),
    'Sent (which waits for the window) is planned',
  );
});

test('review2-sync D3 an unknown thread that gains INBOX and loses it later on the same page is not fetched', async () => {
  const r = await rig({ threads: 600 });
  await r.drive({ until: windowDone(r), maxSteps: 300 });
  await r.clock.advance(60_000);
  const knownThreads = new Set([...r.store.rows.values()].map(row => row.facts.remoteThreadId));
  const inboxNow = new Set(r.emu.mailbox.selectThreads({ labelIds: ['INBOX'] }).map(th => th.id));
  const outside = r.emu.mailbox
    .threadIds()
    .filter(id => !knownThreads.has(id) && !inboxNow.has(id));
  const [flicker, kept] = outside;
  r.emu.mailbox.relabel({ threadIds: [flicker] }, ['INBOX'], []);
  r.emu.mailbox.relabel({ threadIds: [kept] }, ['INBOX'], []);
  r.emu.mailbox.relabel({ threadIds: [flicker] }, [], ['INBOX']);
  const start = r.clock.now();
  await historyPoll(r);
  assert.equal(
    r.store.states.get('history')!.cursor,
    String(r.emu.mailbox.history.currentId),
    'one page',
  );
  const fetched = gets(r, start);
  assert.equal(fetched.length, 1, 'only the thread that kept INBOX is fetched');
  assert.ok(
    ![...r.store.rows.values()].some(row => row.facts.remoteThreadId === flicker),
    'no row for the thread that never net-gained INBOX',
  );
  assert.ok(r.store.threadsIn('INBOX').has(kept));
});
