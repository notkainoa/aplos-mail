/**
 * prov-gmail on the engine's real store (`store-rig.ts`): the two gaps the stand-in store hid. G-A: nothing retried a
 * quarantined message. G-B: Inbox mail that a history reset delivered arrived as resync or backfill and never counted
 * as new mail. Synthetic data only (example.test), fake clock, the emulator's fetch only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { googleError, type FaultHook } from '@aplos/emulators';
import {
  MAX_ATTEMPTS,
  MAX_RETRIES,
  RETRY_KEY,
  RETRY_SCOPE,
  dueRetries,
  readSchedule,
} from '../../src/host/providers/google/failures';
import { LAST_SEEN_KEY } from '../../src/host/providers/google/sync';
import { rig, type Rig } from './harness';

const phaseOf = (r: Rig, scope: 'window:inbox' | 'backfill:inbox' | 'sent:recent') =>
  r.store.states.get(scope)?.phase;
/** The window and every other list scope that exists have finished. */
const settled = (r: Rig) => () =>
  phaseOf(r, 'window:inbox') === 'done' &&
  (['backfill:inbox', 'sent:recent'] as const).every(
    scope => !r.store.states.has(scope) || phaseOf(r, scope) === 'done',
  );
const historyPoll = (r: Rig) => r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 1 });
const MINUTE = 60_000;

/** Answers 500 to every metadata get of the ids in `poison`. */
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

/** One sync pass as the actor runs it: a history poll, then whatever quiet retry the plan made due. */
async function pass(r: Rig, gapMs = MINUTE): Promise<void> {
  await r.clock.advance(gapMs);
  await historyPoll(r);
  await r.drive({ scopes: [RETRY_SCOPE], maxSteps: 3 });
}

/** A synced account with one message that fails until `poison` forgets it, quarantined after its third poll. */
async function quarantined() {
  const poison = new Set<string>();
  const r = await rig({ threads: 120, emulator: { faults: poisonHook(poison) } });
  await r.drive({ until: settled(r), maxSteps: 400 });
  await r.clock.advance(MINUTE);
  const bad = newMail(r, 'Synthetic poison');
  poison.add(bad.id);
  for (let poll = 1; poll <= MAX_ATTEMPTS; poll++) await pass(r, 6 * MINUTE);
  const tries = () => r.metadataGets().filter(id => id === bad.id).length;
  assert.equal(tries(), MAX_ATTEMPTS, 'quarantined after its third failed poll');
  assert.ok(r.store.memory.has(RETRY_KEY), 'and scheduled for a retry');
  return { r, bad, poison, tries };
}

test('G-A a quarantined message is retried after a back-off counted in sync passes, and arrives without notifying', async () => {
  const { r, bad, poison, tries } = await quarantined();
  poison.delete(bad.id); // the outage ends
  await pass(r);
  assert.equal(tries(), MAX_ATTEMPTS, 'one pass later is too early');
  assert.ok(!r.store.rows.has(bad.id));
  await pass(r);
  assert.equal(tries(), MAX_ATTEMPTS + 1, 'two passes later it is tried once');
  assert.ok(r.store.rows.get(bad.id)?.folders.has('INBOX'), 'and now in the local Inbox');
  assert.ok(!r.store.memory.has(RETRY_KEY), 'the schedule is empty again');
  const retry = r.store.commits.filter(c => c.step.scope === RETRY_SCOPE);
  assert.equal(retry.length, 1);
  assert.equal(retry[0].step.origin, 'backfill', 'a retry is quiet');
  assert.ok(!r.store.newMail().includes(bad.id), 'a retried message is never new mail');
  for (let i = 0; i < 5; i++) await pass(r);
  assert.equal(tries(), MAX_ATTEMPTS + 1, 'and never tried again');
});

test('G-A a message that keeps failing is retried a bounded number of times, with doubling gaps, never in a tight loop', async () => {
  const { r, bad, tries } = await quarantined();
  const retryPasses: number[] = [];
  let seen = tries();
  for (let n = 1; n <= 40; n++) {
    const stepsBefore = r.store.commits.filter(c => c.step.scope === RETRY_SCOPE).length;
    await pass(r);
    const steps = r.store.commits.filter(c => c.step.scope === RETRY_SCOPE).length - stepsBefore;
    assert.ok(steps <= 1, `pass ${n}: ${steps} retry steps, at most one per pass`);
    if (tries() > seen) retryPasses.push(n);
    seen = tries();
  }
  assert.equal(
    tries(),
    MAX_ATTEMPTS + MAX_RETRIES,
    'exactly MAX_RETRIES retries, then it is left alone',
  );
  const gaps = retryPasses.slice(1).map((p, i) => p - retryPasses[i]);
  assert.deepEqual(
    gaps,
    [4, 8],
    `retries at passes ${retryPasses.join(', ')}: the back-off doubles`,
  );
  const schedule = readSchedule(r.store.memory);
  assert.deepEqual(schedule.items, {}, 'given up: nothing scheduled any more');
  assert.deepEqual(schedule.exhausted, [bad.id], 'and it is remembered as out of retries');
  assert.equal(
    r.store.failures([bad.id]).get(bad.id),
    1 + MAX_RETRIES,
    "the engine's own record counts every failed attempt",
  );
  assert.ok(!r.store.rows.has(bad.id));
});

test('RV-5 G-A a retry that meets a pause costs the message nothing and is due again one pass later', async () => {
  const { r, bad, poison, tries } = await quarantined();
  poison.delete(bad.id);
  await pass(r); // pass 1 after quarantine
  await r.clock.advance(MINUTE);
  await historyPoll(r); // pass 2: the retry is due
  r.governor.pauseAfter = 0;
  await r.drive({ scopes: [RETRY_SCOPE], maxSteps: 1 });
  r.governor.pauseAfter = undefined;
  assert.equal(tries(), MAX_ATTEMPTS, 'nothing went out');
  const schedule = readSchedule(r.store.memory);
  const item = schedule.items[bad.id];
  assert.equal(item.tries, 0, 'a pause is not a failure');
  assert.equal(item.due, schedule.pass + 1, 'due again on the next pass, not at once');
  assert.deepEqual(dueRetries(schedule), [], 'so no retry is due before another pass');
  await pass(r);
  assert.equal(tries(), MAX_ATTEMPTS + 1);
  assert.ok(r.store.rows.get(bad.id)?.folders.has('INBOX'));
});

test('G-B Inbox mail that a history reset delivers is new mail, and the initial sync and the resync are not', async () => {
  const r = await rig({ threads: 120 });
  await r.drive({ until: settled(r), maxSteps: 400 });
  assert.ok(r.store.baselineAt !== undefined, 'the baseline is done');
  assert.deepEqual(r.store.newMail(), [], 'the first window and its backfill never notify');
  await r.clock.advance(MINUTE);
  await historyPoll(r);
  const lastSeen = r.store.states.get('history')!.updatedAt;

  // Away for a while: two new Inbox mails, then the cursor expires.
  await r.clock.advance(5 * MINUTE);
  const fresh = [newMail(r, 'Synthetic one'), newMail(r, 'Synthetic two')];
  r.emu.mailbox.expireHistory();
  await historyPoll(r);
  assert.equal(r.store.commits.at(-1)!.result.reset, 'cursorExpired');
  assert.equal(
    r.store.memory.get(LAST_SEEN_KEY),
    String(lastSeen),
    'the reset remembers when it last saw the Inbox',
  );

  const before = r.metadataGets().length;
  await r.drive({
    trigger: 'reset',
    until: () => phaseOf(r, 'window:inbox') === 'done',
    maxSteps: 20,
  });
  assert.ok(!r.store.memory.has(LAST_SEEN_KEY), 'the marker is cleared once delivered');
  for (const m of fresh) assert.ok(r.store.rows.get(m.id)?.folders.has('INBOX'));
  assert.deepEqual(
    new Set(r.store.newMail(lastSeen)),
    new Set(fresh.map(m => m.id)),
    'exactly the mail newer than the last sync is new mail',
  );
  assert.deepEqual(
    r.store.newMail().filter(id => !fresh.some(m => m.id === id)),
    [],
    'nothing older notifies',
  );
  const fetched = r.metadataGets().slice(before);
  assert.equal(new Set(fetched).size, fetched.length, 'the resync does not fetch it a second time');
  const resync = r.store.commits.filter(c => c.step.scope === 'window:inbox').at(-1)!;
  assert.equal(resync.step.origin, 'resync', 'the resync itself stays quiet');
});

test('G-B a reset before the first window is done sets no new-mail marker', async () => {
  const r = await rig({ threads: 600 });
  await r.drive({ scopes: ['history'], maxSteps: 1 }); // P0
  await r.drive({ scopes: ['window:inbox'], maxSteps: 1 }); // part of the first window
  assert.notEqual(phaseOf(r, 'window:inbox'), 'done');
  await r.clock.advance(MINUTE);
  newMail(r, 'Synthetic early');
  r.emu.mailbox.expireHistory();
  await historyPoll(r);
  assert.equal(r.store.commits.at(-1)!.result.reset, 'cursorExpired');
  assert.ok(!r.store.memory.has(LAST_SEEN_KEY));
  await r.drive({ trigger: 'reset', until: settled(r), maxSteps: 400 });
  assert.deepEqual(r.store.newMail(), [], 'the initial sync never notifies, reset or not');
});

const windowDone = (r: Rig) => () => phaseOf(r, 'window:inbox') === 'done';

/** A synced account past its baseline whose metadata gets of the ids in `poison` answer 500, one history poll in. */
async function synced(poison: Set<string>): Promise<Rig> {
  const r = await rig({ threads: 120, emulator: { faults: poisonHook(poison) } });
  await r.drive({ until: settled(r), maxSteps: 400 });
  await r.clock.advance(MINUTE);
  await historyPoll(r);
  return r;
}

/** Away for a while: two new Inbox mails (the second one poisoned), then the cursor expires and a poll resets. */
async function resetWithFlakyArrival(r: Rig, poison: Set<string>) {
  await r.clock.advance(5 * MINUTE);
  const fine = newMail(r, 'Synthetic fine');
  const flaky = newMail(r, 'Synthetic flaky');
  poison.add(flaky.id);
  r.emu.mailbox.expireHistory();
  await historyPoll(r);
  assert.equal(r.store.commits.at(-1)!.result.reset, 'cursorExpired');
  assert.ok(r.store.memory.has(LAST_SEEN_KEY));
  return { fine, flaky };
}

/** The message leaves the Inbox and comes back: a history page that makes the next poll fetch it (D3). */
function regainInbox(r: Rig, id: string): void {
  r.emu.mailbox.modifyMessages([id], [], ['INBOX']);
  r.emu.mailbox.modifyMessages([id], ['INBOX'], []);
}

test('RV-1 an arrival whose fetch fails in the post-reset check keeps the marker and is new mail once it fetches', async () => {
  const poison = new Set<string>();
  const r = await synced(poison);
  const { fine, flaky } = await resetWithFlakyArrival(r, poison);
  const marker = r.store.memory.get(LAST_SEEN_KEY);
  await r.drive({ trigger: 'reset', scopes: ['history'], maxSteps: 1 });
  assert.equal(r.store.memory.get(LAST_SEEN_KEY), marker, 'the marker is kept');
  assert.ok(!r.store.states.get('history')?.cursor, 'the cursor is not re-seeded yet');
  assert.ok(!r.store.rows.has(fine.id) && !r.store.rows.has(flaky.id), 'nothing is delivered');
  const [p0] = r.adapter.plan({
    account: r.account,
    states: [...r.store.states.values()],
    trigger: 'poll',
    env: r.env(),
    memory: r.store.memory,
  });
  assert.equal(p0.origin, 'incremental');
  assert.ok((p0.notBefore ?? 0) > r.clock.now(), 'the next check waits for the poll cadence');

  poison.delete(flaky.id);
  await r.clock.advance(MINUTE);
  await r.drive({ trigger: 'poll', until: windowDone(r), maxSteps: 20 });
  assert.ok(!r.store.memory.has(LAST_SEEN_KEY), 'the marker is cleared once delivered');
  assert.deepEqual(new Set(r.store.newMail()), new Set([fine.id, flaky.id]), 'both are new mail');
});

test('RV-1 an arrival that keeps failing in the post-reset check is quarantined, so it cannot pin the cursor', async () => {
  const poison = new Set<string>();
  const r = await synced(poison);
  const { fine, flaky } = await resetWithFlakyArrival(r, poison);
  let checks = 0;
  while (!r.store.states.get('history')?.cursor && checks < 10) {
    await r.drive({ trigger: checks ? 'poll' : 'reset', scopes: ['history'], maxSteps: 1 });
    await r.clock.advance(6 * MINUTE);
    checks++;
  }
  assert.equal(checks, MAX_ATTEMPTS, 'the check that quarantines it re-seeds the cursor');
  assert.equal(r.store.failures([flaky.id]).get(flaky.id), 1, "the engine's record has it");
  assert.ok(readSchedule(r.store.memory).items[flaky.id], 'and it is scheduled for a retry');
  assert.ok(!r.store.memory.has(LAST_SEEN_KEY));
  assert.deepEqual(r.store.newMail(), [fine.id], 'the rest is new mail');
});

test('RV-2 a reset after a pass that left a fetch pending remembers the last pass that reached the head', async () => {
  const poison = new Set<string>();
  const r = await synced(poison);
  const headAt = r.store.states.get('history')!.updatedAt;
  await r.clock.advance(MINUTE);
  const flaky = newMail(r, 'Synthetic flaky');
  poison.add(flaky.id);
  await r.clock.advance(MINUTE);
  await historyPoll(r);
  const stalled = r.store.states.get('history')!;
  assert.deepEqual(stalled.pending, [flaky.id], 'the pass did not reach the head');
  assert.ok(stalled.updatedAt > flaky.internalDate);

  await r.clock.advance(MINUTE);
  r.emu.mailbox.expireHistory();
  await historyPoll(r);
  assert.equal(r.store.commits.at(-1)!.result.reset, 'cursorExpired');
  assert.equal(r.store.memory.get(LAST_SEEN_KEY), String(headAt), 'not the stalled pass');
  poison.delete(flaky.id);
  await r.drive({ trigger: 'reset', until: windowDone(r), maxSteps: 20 });
  assert.deepEqual(r.store.newMail(), [flaky.id], 'the mail it never fetched is new mail');
});

test('RV-3 a message out of retries earns no fresh ones when history quarantines it again', async () => {
  const { r, bad, tries } = await quarantined();
  for (let n = 0; n < 20; n++) await pass(r);
  assert.equal(tries(), MAX_ATTEMPTS + MAX_RETRIES, 'out of retries');
  regainInbox(r, bad.id);
  for (let poll = 1; poll <= MAX_ATTEMPTS; poll++) await pass(r, 6 * MINUTE);
  assert.equal(tries(), 2 * MAX_ATTEMPTS + MAX_RETRIES, 'history tried it until it quarantined it');
  const retriesBefore = r.store.commits.filter(c => c.step.scope === RETRY_SCOPE).length;
  for (let n = 0; n < 20; n++) await pass(r);
  assert.equal(tries(), 2 * MAX_ATTEMPTS + MAX_RETRIES, 'and nothing retries it again');
  assert.equal(r.store.commits.filter(c => c.step.scope === RETRY_SCOPE).length, retriesBefore);
  assert.deepEqual(readSchedule(r.store.memory).items, {});
});

test('RV-3 a scheduled message that history fetches successfully leaves the retry schedule', async () => {
  const { r, bad, poison, tries } = await quarantined();
  poison.delete(bad.id);
  regainInbox(r, bad.id);
  await r.clock.advance(MINUTE);
  await historyPoll(r);
  assert.ok(r.store.rows.get(bad.id)?.folders.has('INBOX'), 'history fetched it');
  assert.ok(!r.store.memory.has(RETRY_KEY), 'nothing is scheduled any more');
  for (let n = 0; n < 5; n++) await pass(r);
  assert.equal(tries(), MAX_ATTEMPTS + 1, 'and the retry step never fetches it again');
});

test(
  "RV-4 a successful retry clears the engine's failure record",
  {
    todo: 'StepResult cannot clear a sync_failures row yet: needs a port field (eng-contract, prov-gov)',
  },
  async () => {
    const { r, bad, poison } = await quarantined();
    poison.delete(bad.id);
    await pass(r);
    await pass(r);
    assert.ok(r.store.rows.get(bad.id)?.folders.has('INBOX'), 'the retry fetched it');
    assert.equal(r.store.failures([bad.id]).get(bad.id), undefined, 'and the record is gone');
  },
);
