/**
 * Holds, prefetch on intent, the status slot, counts, the clock and streams. Node, no DOM:
 * `cd apps/desktop && npx tsx --test src/renderer/data/layer.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultNow } from '@aplos/contract-fixture';
import { motions } from '../ui/generated/motion';
import { ClockStore, harnessClock, truncateNow } from './clock';
import type { Account, Counts, ProgressFrame } from './contract-shapes';
import { createHarness } from './harness';
import { HOLD_CAP_MS, HOLD_RELEASE_MS } from './holds';
import { HARNESS_NOW_MS, HOLD_TIMING, PREFETCH_TIMING } from './index';
import { createManualTimers } from './scheduler';
import { countsFor, pickStatus, ZERO_COUNTS } from './session';

test('hold timing comes from the generated hold motion', () => {
  assert.equal(HOLD_RELEASE_MS, motions.hold.durations.base);
  assert.equal(HOLD_CAP_MS, motions.hold.durations.cap);
  assert.equal(HOLD_RELEASE_MS, HOLD_TIMING.releaseAfterLastKeyMs);
  assert.equal(HOLD_CAP_MS, HOLD_TIMING.capMs);
});

test('prefetch waits 80 ms of focus or 120 ms of hover, and cancels on move', async () => {
  const h = createHarness();
  try {
    await h.settle();
    const intent = h.layer.prefetch();
    h.clearCalls();
    intent.focus('t1', ['t0', 't2']);
    h.timers.advance(PREFETCH_TIMING.focusMs - 1);
    assert.equal(h.callsOf('MessageBody/prefetch').length, 0);
    h.timers.advance(1);
    assert.deepEqual(
      h.callsOf('MessageBody/prefetch').map(c => c.args),
      [{ threadIds: ['t1', 't0', 't2'] }],
    );
    intent.hover('t5', ['t4', 't6']);
    assert.deepEqual(h.callsOf('MessageBody/prefetch')[1]!.args, {
      threadIds: ['t1', 't0', 't2'],
      cancel: true,
    });
    h.timers.advance(PREFETCH_TIMING.hoverMs - 1);
    assert.equal(h.callsOf('MessageBody/prefetch').length, 2);
    intent.focus('t8', ['t7']);
    h.timers.advance(PREFETCH_TIMING.focusMs);
    assert.deepEqual(h.callsOf('MessageBody/prefetch')[2]!.args, { threadIds: ['t8', 't7'] });
    intent.cancel();
    assert.deepEqual(h.callsOf('MessageBody/prefetch')[3]!.args, {
      threadIds: ['t8', 't7'],
      cancel: true,
    });
    await h.settle();
  } finally {
    h.close();
  }
});

async function demoAccounts(): Promise<Account[]> {
  const h = createHarness();
  try {
    return (await h.truth.api.account.get({})).list;
  } finally {
    h.close();
  }
}

test('the status slot picks the most urgent account in the recorded order', async () => {
  const [work, personal] = await demoAccounts();
  assert.ok(work && personal);
  const now = defaultNow;
  const withStatus = (
    a: Account,
    status: Account['health']['status'],
    extra: Partial<Account['health']> = {},
  ) => ({
    ...a,
    demo: false,
    health: { ...a.health, ...extra, status },
  });
  const ok = (a: Account) => withStatus(a, { state: 'ok' });
  assert.equal(pickStatus([], undefined, now), undefined);
  const paused = withStatus(work, {
    state: 'paused',
    until: now + 60_000,
    class: 'rate',
    reason: 'rate',
  });
  const reauth = withStatus(
    personal,
    { state: 'needsReauth', reason: 'expired' },
    { reasonCode: 'auth.expired' },
  );
  const both = pickStatus([paused, reauth], undefined, now)!;
  assert.equal(both.status.state, 'needsReauth');
  assert.equal(both.reasonCode, 'auth.expired');
  assert.equal(
    pickStatus([paused, reauth], work.id, now)!.status.state,
    'paused',
    'one account in scope',
  );
  const offline = withStatus(work, { state: 'offline' });
  assert.equal(pickStatus([offline, ok(personal)], undefined, now)!.status.state, 'offline');
  const soon = withStatus(personal, { state: 'ok' }, { reconnectBy: now + 3_600_000 });
  const syncing = withStatus(work, { state: 'syncing' });
  const slot = pickStatus([syncing, soon], undefined, now)!;
  assert.equal(slot.reconnectSoon, true, 'reconnect soon beats syncing');
  assert.equal(slot.account!.id, personal.id);
  const demo = { ...ok(work), demo: true };
  assert.equal(pickStatus([demo], undefined, now)!.demo, true);
  assert.equal(
    pickStatus([demo, syncing], undefined, now)!.status.state,
    'syncing',
    'demo yields to syncing',
  );
  const future = withStatus(work, { state: 'quarantined' } as never);
  const unknown = pickStatus([future, ok(personal)], undefined, now)!;
  assert.equal(
    unknown.status.state,
    'error',
    'an unknown state from a newer engine counts as error',
  );
});

test('with several accounts due to reconnect, the status slot names the earliest deadline', async () => {
  const [work, personal] = await demoAccounts();
  assert.ok(work && personal);
  const now = defaultNow;
  const due = (a: Account, reconnectBy: number): Account => ({
    ...a,
    demo: false,
    health: { ...a.health, reconnectBy, status: { state: 'ok' } },
  });
  const later = due(work, now + 20 * 3_600_000);
  const sooner = due(personal, now + 2 * 3_600_000);
  assert.equal(pickStatus([later, sooner], undefined, now)!.account!.id, personal.id);
  assert.equal(pickStatus([sooner, later], undefined, now)!.account!.id, personal.id);
  const outside = due(work, now + 30 * 3_600_000);
  assert.equal(pickStatus([outside, later], undefined, now)!.account!.id, later.id);
});

test('counts hide while any account in scope is in its first sync', async () => {
  const [work, personal] = await demoAccounts();
  const counts: Counts = {
    all: { ...ZERO_COUNTS, home: 7, handledToday: 3 },
    accounts: { [work!.id]: { ...ZERO_COUNTS, home: 5 } },
    folders: { f1: 2 },
  };
  const done = (a: Account) => ({ ...a, baselineDoneAt: defaultNow });
  const fresh = (a: Account) => {
    const rest = { ...a };
    delete rest.baselineDoneAt;
    return rest;
  };
  assert.equal(countsFor(undefined, [], undefined).hidden, true, 'hidden until counts answer');
  const all = countsFor(counts, [done(work!), done(personal!)], undefined);
  assert.equal(all.hidden, false);
  assert.equal(all.counts.home, 7);
  assert.deepEqual(all.folders, { f1: 2 });
  assert.equal(countsFor(counts, [done(work!), fresh(personal!)], undefined).hidden, true);
  const one = countsFor(counts, [done(work!), fresh(personal!)], work!.id);
  assert.equal(one.hidden, false, 'the other account does not hide this one');
  assert.equal(one.counts.home, 5);
});

test('the clock: an injected clock wins, then the engine clock, ticking on boundaries', async () => {
  const timers = createManualTimers(Date.UTC(2026, 9, 29, 16, 59, 30));
  const clock = new ClockStore(timers);
  assert.equal(clock.now(), timers.now(), 'the wall clock by default');
  clock.engineNow(defaultNow);
  assert.equal(clock.now(), defaultNow);
  clock.setClock(harnessClock);
  assert.equal(clock.now(), HARNESS_NOW_MS);
  clock.setClock(null);
  assert.equal(clock.now(), defaultNow);
  let ticks = 0;
  const stop = clock.subscribe('minute', () => ticks++);
  timers.advance(60_000 - (defaultNow % 60_000) - 1);
  assert.equal(ticks, 0);
  timers.advance(1);
  assert.equal(ticks, 1, 'ticks on the minute boundary');
  assert.equal(clock.snapshot('minute'), truncateNow(clock.now(), 'minute'));
  stop();
  timers.advance(120_000);
  assert.equal(ticks, 1);

  const h = createHarness();
  try {
    await h.settle();
    assert.equal(h.layer.clock.now(), defaultNow, 'Session.now sets the engine clock');
    await h.control.setClock({ now: defaultNow + 3_600_000 });
    await h.settle();
    assert.equal(h.layer.clock.now(), defaultNow + 3_600_000, 'a clock host event moves it');
  } finally {
    h.close();
  }
});

test('stream frames are batched per animation frame and a live run replays from its start', async () => {
  const h = createHarness();
  try {
    await h.settle();
    const { runId } = await h.layer.api.ask.run({ question: 'When is the design review?' });
    const early = h.layer.bus.open('progress', { runId });
    let notified = 0;
    early.subscribe(() => notified++);
    await h.control.advanceClock({ ms: 5_000 });
    const before = early.getSnapshot().frames.length;
    h.scheduler.flush();
    const after = early.getSnapshot().frames as readonly ProgressFrame[];
    assert.ok(after.length > before, 'frames land in the flush');
    assert.ok(after.every(f => f.runId === runId));
    const late = h.layer.bus.open('progress', { runId });
    assert.deepEqual(
      late.getSnapshot().frames,
      after,
      'a late subscriber sees the run from its start',
    );
    assert.ok(notified >= 1);
  } finally {
    h.close();
  }
});

test('the session, connection and singletons read and follow state frames', async () => {
  const h = createHarness();
  try {
    await h.settle();
    assert.equal(h.layer.session.connection.state, 'ready');
    h.layer.session.want('accounts');
    h.layer.session.want('settings');
    await h.settle();
    assert.ok(h.layer.session.accounts.length >= 1);
    const id = h.layer.session.accounts[0]!.id;
    await h.control.setAccountStatus({ accountId: id, status: { state: 'offline' } });
    await h.control.advanceClock({ ms: 200 });
    await h.settle();
    assert.equal(h.layer.session.accounts.find(a => a.id === id)!.health.status.state, 'offline');
    await h.control.park({
      reasonCode: 'crashLoop',
      message: 'Aplos stopped after repeated problems.',
    });
    await h.settle();
    assert.equal(h.layer.session.connection.state, 'parked');
    assert.equal(h.layer.session.connection.reasonCode, 'crashLoop');
  } finally {
    h.close();
  }
});
