import assert from 'node:assert/strict';
import test from 'node:test';
import type { PushedToast } from './index';
import {
  listenUpdates,
  readyVersion,
  UPDATE_TOAST_ID,
  type UpdateBridge,
  type UpdateCalls,
  type UpdateState,
} from './updateNotice';

const ready = (version = '0.3.0', dismissed = false): UpdateState => ({
  status: { state: 'ready', version },
  dismissed,
});

function setup(initial: UpdateState = { status: { state: 'idle' } }) {
  const log: string[] = [];
  const pushed: PushedToast[] = [];
  const dismissed: string[] = [];
  const subscriptions: Array<{ only?: readonly string[] }> = [];
  let listener: Parameters<UpdateBridge['subscribe']>[0] | undefined;
  let unsubscribed = 0;
  const bridge: UpdateBridge = {
    subscribe(l, options) {
      subscriptions.push({ only: options?.only });
      listener = l;
      return () => void (unsubscribed += 1);
    },
  };
  const fail = { restart: false };
  const calls: UpdateCalls = {
    status: async () => initial,
    restart: async () => {
      log.push('restart');
      if (fail.restart) throw new Error('no');
    },
    later: async () => void log.push('later'),
  };
  const stop = listenUpdates(bridge, calls, {
    push: t => void pushed.push(t),
    dismiss: id => void dismissed.push(id),
  });
  return {
    stop,
    log,
    pushed,
    dismissed,
    subscriptions,
    fail,
    send: (payload: unknown, type = 'update') => listener?.({ type, payload }),
    unsubscribed: () => unsubscribed,
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('only a ready, undismissed update with a version counts', () => {
  assert.equal(readyVersion(ready()), '0.3.0');
  assert.equal(readyVersion(ready('0.3.0', true)), undefined);
  assert.equal(readyVersion({ status: { state: 'downloading', version: '0.3.0' } }), undefined);
  assert.equal(readyVersion({ status: { state: 'ready' } }), undefined);
  assert.equal(readyVersion(undefined), undefined);
});

test('it listens typed for update events only', () => {
  const t = setup();
  assert.deepEqual(t.subscriptions, [{ only: ['update'] }]);
});

test('a ready update event shows one persistent notice with Restart and Later', () => {
  const t = setup();
  t.send(ready('0.3.1'));
  assert.equal(t.pushed.length, 1);
  const toast = t.pushed[0]!;
  assert.equal(toast.id, UPDATE_TOAST_ID);
  assert.equal(toast.persistent, true);
  assert.match(toast.message, /Update ready/);
  assert.match(toast.message, /0\.3\.1/);
  assert.deepEqual(
    toast.actions?.map(a => a.id),
    ['restart', 'later'],
  );
});

test('Restart and Later call main; nothing else does', async () => {
  const t = setup();
  t.send(ready());
  t.pushed[0]!.onAction?.('later');
  t.pushed[0]!.onAction?.('restart');
  await tick();
  assert.deepEqual(t.log, ['later', 'restart']);
});

test('a failed restart says so instead of staying silent', async () => {
  const t = setup();
  t.fail.restart = true;
  t.send(ready());
  t.pushed[0]!.onAction?.('restart');
  await tick();
  assert.equal(t.pushed.at(-1)?.kind, 'error');
});

test('Later, a newer download or an error clears the notice', () => {
  const t = setup();
  t.send(ready('0.3.0', true));
  t.send({ status: { state: 'downloading', version: '0.3.2' } });
  t.send({ status: { state: 'error', message: 'offline' } });
  assert.equal(t.pushed.length, 0);
  assert.deepEqual(t.dismissed, [UPDATE_TOAST_ID, UPDATE_TOAST_ID, UPDATE_TOAST_ID]);
});

test('other events and malformed payloads are ignored', () => {
  const t = setup();
  t.send(ready(), 'navigate');
  t.send(null);
  t.send('ready');
  assert.equal(t.pushed.length, 0);
});

test('an update that finished before the window listened still shows', async () => {
  const t = setup(ready('0.3.0'));
  await tick();
  assert.equal(t.pushed.length, 1);
});

test('after stop nothing shows and the subscription is released', async () => {
  const t = setup(ready());
  t.stop();
  await tick();
  t.send(ready());
  assert.equal(t.pushed.length, 0);
  assert.equal(t.unsubscribed(), 1);
});

test('without a bridge it still reads the current state', async () => {
  const pushed: PushedToast[] = [];
  listenUpdates(
    undefined,
    { status: async () => ready(), restart: async () => 0, later: async () => 0 },
    { push: t => void pushed.push(t), dismiss: () => undefined },
  );
  await tick();
  assert.equal(pushed.length, 1);
});

test('a slow first status answer never overrides a newer update event', async () => {
  const t = setup(ready());
  // Later arrives before the window's first `status` answer, which still says ready.
  t.send(ready('0.3.0', true));
  await tick();
  assert.equal(t.pushed.length, 0);
  assert.ok(t.dismissed.includes(UPDATE_TOAST_ID));
});
