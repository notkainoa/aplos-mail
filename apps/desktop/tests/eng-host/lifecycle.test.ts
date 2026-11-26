import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activationPolicy,
  createProcessState,
  createQuitGate,
  closeThenRelease,
  drain,
  quitWarning,
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

test('the data lock is released only when the engine confirmed it closed: a stuck or failed close leaves it held', async () => {
  const timers = {
    set: (run: () => void, ms: number) => setTimeout(run, ms / 100),
    clear: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
  };
  let released = 0;
  const release = () => void released++;
  assert.equal(await closeThenRelease(Promise.resolve(), 3000, timers, release), true);
  assert.equal(released, 1, 'the engine closed: the lock is let go');
  assert.equal(await closeThenRelease(new Promise(() => {}), 3000, timers, release), false);
  assert.equal(released, 1, 'the engine is stuck: the lock stays held until this process is gone');
  assert.equal(
    await closeThenRelease(Promise.reject(new Error('close failed')), 3000, timers, release),
    false,
  );
  assert.equal(released, 1, 'the close failed: the lock stays held');
  // A close that finishes just after the wait does not release it later either.
  let finish: () => void = () => {};
  const late = new Promise<void>(resolve => (finish = resolve));
  assert.equal(await closeThenRelease(late, 3000, timers, release), false);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, 1);
});

test('the quit gate asks once at a time, and a confirm that rejects or throws still lets the quit go ahead', async () => {
  const settle = () => new Promise(resolve => setImmediate(resolve));
  let release: (go: boolean) => void = () => {};
  let asked = 0;
  let begun = 0;
  const gate = createQuitGate(
    () => {
      asked++;
      return new Promise<boolean>(resolve => (release = resolve));
    },
    () => void begun++,
  );
  gate.request();
  gate.request();
  assert.equal(asked, 1, 'a second ⌘Q while the question is open is ignored');
  release(false);
  await settle();
  assert.equal(begun, 0, '"Keep running" does not quit');
  gate.request();
  assert.equal(asked, 2, 'and the gate is open again');
  release(true);
  await settle();
  assert.equal(begun, 1);

  for (const failing of [
    () => Promise.reject(new Error('dialog failed')),
    () => {
      throw new Error('boom');
    },
  ]) {
    let quits = 0;
    const broken = createQuitGate(failing as () => Promise<boolean>, () => void quits++);
    broken.request();
    await settle();
    broken.request();
    await settle();
    assert.equal(quits, 2, 'a failing confirm is a yes, and does not stick the gate');
  }
});

test('a quit that throws when it begins is not an unhandled rejection and the gate asks again', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    let asked = 0;
    const gate = createQuitGate(
      async () => {
        asked++;
        return true;
      },
      () => {
        throw new Error('window close failed');
      },
    );
    gate.request();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    gate.request();
    assert.equal(asked, 2);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
