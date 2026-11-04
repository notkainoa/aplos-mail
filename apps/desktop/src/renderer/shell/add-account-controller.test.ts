// The Add account dialog's logic: Esc ladder, Return per mode, the landed toast, and ending a wait on unmount.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectPorts } from '../onboarding/connect';
import { createAddAccountController } from './add-account-controller';

interface Calls {
  discover: string[];
  connect: unknown[];
  cancel: string[];
  closed: number;
  toasts: string[];
}

interface RigOptions {
  /** `discover` throws instead of answering. */
  readonly discoverThrows?: boolean;
  /** `discover` waits for `release()` before answering. */
  readonly holdDiscover?: boolean;
  /** `connect` rejects with this reason code instead of answering with an id. */
  readonly connectFails?: string;
}

function rig(provider = 'google', options: RigOptions = {}) {
  const calls: Calls = { discover: [], connect: [], cancel: [], closed: 0, toasts: [] };
  const pending: Array<(id: string) => void> = [];
  let release = () => {};
  const held = new Promise<void>(resolve => void (release = resolve));
  const ports = {
    discover: async (input: { address: string }) => {
      calls.discover.push(input.address);
      if (options.holdDiscover) await held;
      if (options.discoverThrows) throw new Error('offline');
      return { provider };
    },
    connect: (input: unknown) => {
      calls.connect.push(input);
      if (options.connectFails) return Promise.reject({ reasonCode: options.connectFails });
      return new Promise<{ connectId: string }>(resolve =>
        pending.push(id => resolve({ connectId: id })),
      );
    },
    cancelConnect: async (input: { connectId: string }) => {
      calls.cancel.push(input.connectId);
      return {};
    },
  } as unknown as ConnectPorts;
  const controller = createAddAccountController(ports, {
    closeSheet: () => void (calls.closed += 1),
    pushToast: toast => void calls.toasts.push(toast.message),
  });
  return { calls, controller, release, answer: (id: string) => pending.shift()?.(id) };
}
type Rig = ReturnType<typeof rig>;

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

async function typed(r: Rig) {
  r.controller.dispatch({ type: 'edit', address: 'alex@gmail.com' });
  r.controller.enter();
  await settle();
}

async function waitingWithId(r: Rig, id = 'c1') {
  await typed(r);
  r.controller.enter();
  r.answer(id);
  await settle();
}

test('Esc cancels a wait first, and does not close', async () => {
  const r = rig();
  await waitingWithId(r);
  assert.equal(r.controller.getState().mode, 'waiting');
  r.controller.esc();
  await settle();
  assert.equal(r.controller.getState().mode, 'choose');
  assert.deepEqual(r.calls.cancel, ['c1']);
  assert.equal(r.calls.closed, 0);
});

test('Esc then clears a typed address, and only then closes', async () => {
  const r = rig();
  await typed(r);
  assert.equal(r.controller.getState().mode, 'typed');
  r.controller.esc();
  assert.equal(r.controller.getState().mode, 'choose');
  assert.equal(r.controller.getState().address, '');
  assert.equal(r.calls.closed, 0);
  r.controller.esc();
  assert.equal(r.calls.closed, 1);
});

test('Esc clears a half-typed field before it closes', () => {
  const r = rig();
  r.controller.dispatch({ type: 'edit', address: 'al' });
  r.controller.esc();
  assert.equal(r.controller.getState().address, '');
  assert.equal(r.calls.closed, 0);
});

test('Return finds the provider once, however many times it arrives', async () => {
  const r = rig();
  r.controller.dispatch({ type: 'edit', address: 'alex@gmail.com' });
  r.controller.enter();
  r.controller.enter();
  await settle();
  assert.deepEqual(r.calls.discover, ['alex@gmail.com']);
  assert.equal(r.controller.getState().mode, 'typed');
});

test('Return in the typed state connects once with the address, and never discovers again', async () => {
  const r = rig();
  await typed(r);
  r.controller.enter();
  r.controller.enter();
  assert.equal(r.calls.discover.length, 1);
  assert.equal(r.calls.connect.length, 1);
  assert.deepEqual(r.calls.connect[0], { provider: 'google', loginHint: 'alex@gmail.com' });
});

test('Return after a failure tries again with the same hint; the Google row has none', async () => {
  const r = rig();
  await waitingWithId(r);
  r.controller.frame({ connectId: 'c1', state: 'failed', reasonCode: 'auth.denied' });
  assert.equal(r.controller.getState().mode, 'failed');
  r.controller.enter();
  assert.equal(r.calls.connect.length, 2);
  assert.deepEqual(r.calls.connect[1], { provider: 'google', loginHint: 'alex@gmail.com' });
  const g = rig();
  g.controller.chooseGoogle();
  assert.deepEqual(g.calls.connect[0], { provider: 'google' });
});

test('Return does nothing while waiting', async () => {
  const r = rig();
  await waitingWithId(r);
  r.controller.enter();
  assert.equal(r.calls.connect.length, 1);
});

test('a landed connect toasts "Account added" once and closes once', async () => {
  const r = rig();
  await waitingWithId(r);
  r.controller.frame({ connectId: 'c1', state: 'connected' });
  r.controller.frame({ connectId: 'c1', state: 'connected' });
  assert.deepEqual(r.calls.toasts, ['Account added']);
  assert.equal(r.calls.closed, 1);
});

test('an answer for a flow the owner already left never toasts or closes', async () => {
  const r = rig();
  await waitingWithId(r);
  r.controller.esc();
  r.controller.frame({ connectId: 'c1', state: 'connected' });
  assert.deepEqual(r.calls.toasts, []);
  assert.equal(r.calls.closed, 0);
});

test('unmounting while the connect id is still on its way cancels it when it arrives, once', async () => {
  const r = rig();
  await typed(r);
  r.controller.enter();
  r.controller.dispose();
  assert.deepEqual(r.calls.cancel, []);
  r.answer('late');
  await settle();
  assert.deepEqual(r.calls.cancel, ['late']);
});

test('unmounting after the id is known cancels it once', async () => {
  const r = rig();
  await waitingWithId(r);
  r.controller.dispose();
  r.controller.dispose();
  await settle();
  assert.deepEqual(r.calls.cancel, ['c1']);
});

test('unmounting when nothing is waiting cancels nothing', async () => {
  const r = rig();
  await typed(r);
  r.controller.dispose();
  await settle();
  assert.deepEqual(r.calls.cancel, []);
});

test('subscribers hear each state change', async () => {
  const r = rig();
  let heard = 0;
  const off = r.controller.subscribe(() => void (heard += 1));
  r.controller.dispatch({ type: 'edit', address: 'a' });
  off();
  r.controller.dispatch({ type: 'edit', address: 'ab' });
  assert.equal(heard, 1);
});

test('a connected frame that beats the connect id is kept, and lands when the id arrives', async () => {
  const r = rig();
  await typed(r);
  r.controller.enter();
  r.controller.frame({ connectId: 'c1', state: 'connected' });
  assert.equal(r.controller.getState().mode, 'waiting');
  assert.deepEqual(r.calls.toasts, []);
  r.answer('c1');
  await settle();
  assert.equal(r.controller.getState().mode, 'connected');
  assert.deepEqual(r.calls.toasts, ['Account added']);
  assert.equal(r.calls.closed, 1);
});

test('a connect that cannot start fails with its reason and offers a retry', async () => {
  const r = rig('google', { connectFails: 'auth.denied' });
  await typed(r);
  r.controller.enter();
  await settle();
  const state = r.controller.getState();
  assert.equal(state.mode, 'failed');
  assert.equal(state.failure, 'auth.denied');
  assert.equal(r.calls.closed, 0);
  r.controller.enter();
  assert.equal(r.calls.connect.length, 2);
});

test('an address Aplos does not support says so, and so does one it could not check', async () => {
  const other = rig('other');
  other.controller.dispatch({ type: 'edit', address: 'alex@example.org' });
  other.controller.enter();
  await settle();
  assert.equal(other.controller.getState().mode, 'choose');
  assert.equal(other.controller.getState().notice, 'unsupported');
  const offline = rig('google', { discoverThrows: true });
  offline.controller.dispatch({ type: 'edit', address: 'alex@gmail.com' });
  offline.controller.enter();
  await settle();
  assert.equal(offline.controller.getState().mode, 'choose');
  assert.equal(offline.controller.getState().notice, 'unchecked');
});

test('editing while the provider is being found drops the late answer', async () => {
  const r = rig('google', { holdDiscover: true });
  r.controller.dispatch({ type: 'edit', address: 'alex@gmail.com' });
  r.controller.enter();
  assert.equal(r.controller.getState().mode, 'discovering');
  r.controller.dispatch({ type: 'edit', address: 'sam@gmail.com' });
  r.release();
  await settle();
  const state = r.controller.getState();
  assert.equal(state.mode, 'choose');
  assert.equal(state.address, 'sam@gmail.com');
  assert.equal(state.notice, null);
});

test('field Return and the sheet default arriving together act once, at each step', async () => {
  const r = rig();
  // The field's onSubmit and the registered `sheet.default` both call enter() for one key press.
  const bothKeys = () => {
    r.controller.enter();
    r.controller.enter();
  };
  r.controller.dispatch({ type: 'edit', address: 'alex@gmail.com' });
  bothKeys();
  await settle();
  assert.deepEqual(r.calls.discover, ['alex@gmail.com']);
  assert.equal(r.controller.getState().mode, 'typed');
  bothKeys();
  assert.equal(r.calls.connect.length, 1);
  assert.equal(r.controller.getState().mode, 'waiting');
});
