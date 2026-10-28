import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activationPolicy,
  createProcessState,
  drain,
  pendingWork,
  quitWarning,
  startsWindowless,
} from '../../src/host/lifecycle';

test('three engine exits within 60 s park the app; a slow trickle does not', () => {
  const fast = createProcessState();
  assert.equal(fast.state, 'starting');
  fast.engineReady();
  assert.equal(fast.state, 'ready');
  assert.equal(fast.noteEngineExit(0), false);
  assert.equal(fast.noteEngineExit(20_000), false);
  assert.equal(fast.noteEngineExit(40_000), true);
  assert.equal(fast.state, 'parked');
  fast.engineReady();
  assert.equal(fast.state, 'parked');
  fast.tryAgain();
  assert.equal(fast.state, 'starting');

  const slow = createProcessState();
  assert.equal(slow.noteEngineExit(0), false);
  assert.equal(slow.noteEngineExit(30_000), false);
  assert.equal(slow.noteEngineExit(61_000), false);
  assert.equal(slow.state, 'starting');
});

test('pendingWork counts scheduled sends, reminders and unconfirmed sends from the state', () => {
  const sample = {
    drafts: [
      { pendingSendAt: '2026-11-01T09:00:00.000Z' },
      { pendingSendAt: '2026-11-01T08:00:00.000Z' },
      { pendingSendAt: '2026-11-01T07:00:00.000Z', sendAttemptAt: '2026-11-01T06:59:00.000Z' },
      {},
    ],
    threads: [
      { reminderAt: '2026-11-02T09:00:00.000Z' },
      { reminderAt: '2026-10-30T09:00:00.000Z', reminderFired: true },
      {},
    ],
  };
  const pending = pendingWork(sample);
  assert.deepEqual(pending, {
    scheduledSends: 2,
    reminders: 1,
    uncertain: 1,
    nextAt: Date.parse('2026-11-01T08:00:00.000Z'),
  });
  assert.deepEqual(pendingWork(undefined), { scheduledSends: 0, reminders: 0, uncertain: 0 });
  assert.equal(quitWarning(pendingWork({ drafts: [], threads: [] })), undefined);
});

test('the quit warning lists what will not happen', () => {
  const warning = quitWarning(
    { scheduledSends: 2, reminders: 1, uncertain: 0, nextAt: 0 },
    () => 'soon',
  );
  assert.equal(
    warning?.message,
    '2 scheduled sends and 1 reminder will not happen while Aplos is quit',
  );
  assert.match(warning?.detail ?? '', /due soon/);
  const one = quitWarning({ scheduledSends: 1, reminders: 0, uncertain: 2 });
  assert.match(one?.message ?? '', /^1 scheduled send will not happen/);
  assert.match(one?.detail ?? '', /2 sends not yet confirmed/);
});

test('resident policy: accessory with no window, regular with one, always accessory in test mode', () => {
  assert.equal(activationPolicy(0, false), 'accessory');
  assert.equal(activationPolicy(2, false), 'regular');
  assert.equal(activationPolicy(2, true), 'accessory');
  assert.equal(startsWindowless({ atLogin: true }), true);
  assert.equal(startsWindowless({ atLogin: false }), false);
});

test('the quit drain waits at most 3 s for a stuck close', async () => {
  const timers = {
    set: (run: () => void, ms: number) => setTimeout(run, ms / 100),
    clear: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
  };
  const started = Date.now();
  await drain(new Promise(() => {}), 3000, timers);
  assert.ok(Date.now() - started < 1000);
  await drain(Promise.reject(new Error('close failed')), 3000, timers);
});
