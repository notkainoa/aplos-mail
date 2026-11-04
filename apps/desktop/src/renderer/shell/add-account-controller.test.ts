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

function rig(provider = 'google') {
  const calls: Calls = { discover: [], connect: [], cancel: [], closed: 0, toasts: [] };
  const pending: Array<(id: string) => void> = [];
  const ports = {
    discover: async (input: { address: string }) => {
      calls.discover.push(input.address);
      return { provider };
    },
    connect: (input: unknown) => {
      calls.connect.push(input);
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
  return { calls, controller, answer: (id: string) => pending.shift()?.(id) };
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
