// The Accounts step's connect flow (DESIGN 7.11 step 2; Appendix C F9, F12).
// Run: cd apps/desktop && npx tsx --test tests/ui-onboard/connect.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  accountsEsc,
  accountsFocus,
  accountsMain,
  initialAccounts,
  isLateFrame,
  looksLikeAddress,
  reduceAccounts,
  runAccountsEffect,
  shownMode,
  type AccountsEvent,
  type AccountsState,
  type ConnectPorts,
} from '../../src/renderer/onboarding/connect';

function run(events: readonly AccountsEvent[], start: AccountsState = initialAccounts()) {
  let state = start;
  const effects: unknown[] = [];
  for (const e of events) {
    const out = reduceAccounts(state, e);
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
}

const typed = (address = 'jordan.lee@example.com') =>
  run([
    { type: 'edit', address },
    { type: 'submit' },
    { type: 'discovered', seq: 1, provider: 'google' },
  ]).state;

const waiting = (connectId = 'c1') =>
  run(
    [
      { type: 'connect', loginHint: 'jordan.lee@example.com' },
      { type: 'started', attempt: 1, connectId },
    ],
    typed(),
  ).state;

describe('discovery and focus (F12)', () => {
  test('onb-discover-focus-F12: typed address + Return discovers, and Google focuses Continue with Google', () => {
    const { state, effects } = run([
      { type: 'edit', address: 'jordan.lee@example.com' },
      { type: 'submit' },
    ]);
    assert.equal(state.mode, 'discovering');
    assert.deepEqual(effects, [{ type: 'discover', address: 'jordan.lee@example.com', seq: 1 }]);
    const found = reduceAccounts(state, { type: 'discovered', seq: 1, provider: 'google' }).state;
    assert.equal(found.mode, 'typed');
    assert.deepEqual(accountsFocus(found.mode), { kind: 'button', label: 'Continue with Google' });
    assert.equal(accountsMain(found.mode), 'connect');
  });

  test('onb-discover-unsupported: another provider shows the sentence and starts no connect', () => {
    const { state, effects } = run([
      { type: 'edit', address: 'jordan.lee@example.org' },
      { type: 'submit' },
      { type: 'discovered', seq: 1, provider: 'icloud' },
    ]);
    assert.equal(state.mode, 'choose');
    assert.equal(state.notice, 'unsupported');
    assert.ok(!effects.some(e => (e as { type: string }).type === 'connect'));
    assert.deepEqual(accountsFocus(state.mode), { kind: 'field', id: 'onb-address' });
  });

  test('a failed discovery still offers Google (never waits on it)', () => {
    const { state } = run([
      { type: 'edit', address: 'jordan.lee@example.com' },
      { type: 'submit' },
      { type: 'discovered', seq: 1, provider: 'error' },
    ]);
    assert.equal(state.mode, 'choose');
    assert.equal(state.notice, 'unchecked');
  });

  test('a half address gets a plain sentence and no call', () => {
    const { state, effects } = run([{ type: 'edit', address: 'jordan' }, { type: 'submit' }]);
    assert.equal(state.notice, 'invalid');
    assert.deepEqual(effects, []);
    assert.equal(looksLikeAddress('jordan@example.com'), true);
    assert.equal(looksLikeAddress('jordan@example'), false);
  });

  test('an answer for an older address is ignored after the owner edits', () => {
    const { state } = run([
      { type: 'edit', address: 'a@example.com' },
      { type: 'submit' },
      { type: 'edit', address: 'b@example.com' },
      { type: 'discovered', seq: 1, provider: 'google' },
    ]);
    assert.equal(state.mode, 'choose');
  });

  test('focus targets: waiting → Cancel, failed → Try again, connected → Continue', () => {
    assert.deepEqual(accountsFocus('waiting'), { kind: 'button', label: 'Cancel' });
    assert.deepEqual(accountsFocus('failed'), { kind: 'button', label: 'Try again' });
    assert.deepEqual(accountsFocus('connected'), { kind: 'button', label: 'Continue' });
    assert.equal(accountsMain('waiting'), null, 'Return never cancels by accident');
  });
});

describe('connect, cancel and late answers (F9)', () => {
  test('Continue with Google waits and passes the address as login_hint', () => {
    const { state, effects } = run(
      [{ type: 'connect', loginHint: 'jordan.lee@example.com' }],
      typed(),
    );
    assert.equal(state.mode, 'waiting');
    assert.deepEqual(effects, [
      { type: 'connect', attempt: 1, loginHint: 'jordan.lee@example.com' },
    ]);
  });

  test('the awaited flow connecting shows the list', () => {
    const s = reduceAccounts(waiting(), {
      type: 'frame',
      connectId: 'c1',
      state: 'connected',
    }).state;
    assert.equal(s.mode, 'connected');
  });

  test('the awaited flow failing shows the reason with Try again', () => {
    const s = reduceAccounts(waiting(), {
      type: 'frame',
      connectId: 'c1',
      state: 'failed',
      reasonCode: 'auth.denied',
    }).state;
    assert.equal(s.mode, 'failed');
    assert.equal(s.failure, 'auth.denied');
    assert.equal(accountsMain(s.mode), 'retry');
  });

  test('onb-oauth-cancel: Esc while waiting cancels that connect and returns to the field', () => {
    const out = accountsEsc(waiting(), false);
    assert.equal(out.handled, true);
    assert.equal(out.state.mode, 'choose');
    assert.deepEqual(out.effects, [{ type: 'cancelConnect', connectId: 'c1' }]);
  });

  test('F9: a connected frame after Cancel changes nothing on screen', () => {
    const cancelled = reduceAccounts(waiting(), { type: 'cancel' }).state;
    const after = reduceAccounts(cancelled, {
      type: 'frame',
      connectId: 'c1',
      state: 'connected',
    }).state;
    assert.deepEqual(after, cancelled);
    assert.equal(isLateFrame(cancelled, 'c1'), true);
  });

  test('F9: a frame for an older flow never moves the current wait', () => {
    const second = run(
      [{ type: 'cancel' }, { type: 'connect' }, { type: 'started', attempt: 2, connectId: 'c2' }],
      waiting('c1'),
    ).state;
    for (const state of ['connected', 'failed', 'cancelled']) {
      const after = reduceAccounts(second, { type: 'frame', connectId: 'c1', state }).state;
      assert.equal(after.mode, 'waiting');
      assert.equal(after.connectId, 'c2');
    }
  });

  test('F9: frames arriving on the list or the choose screen never navigate', () => {
    for (const start of [initialAccounts(true), initialAccounts(false), typed()]) {
      const after = reduceAccounts(start, { type: 'frame', connectId: 'x', state: 'failed' }).state;
      assert.deepEqual(after, start);
    }
  });

  test('a connect id that arrives after Cancel is cancelled at once', () => {
    const { state, effects } = run(
      [{ type: 'connect' }, { type: 'cancel' }, { type: 'started', attempt: 1, connectId: 'c7' }],
      typed(),
    );
    assert.equal(state.mode, 'choose');
    assert.deepEqual(effects.at(-1), { type: 'cancelConnect', connectId: 'c7' });
  });

  test('a failure that beats the connect id is applied when the id arrives (never stuck waiting)', () => {
    const { state } = run(
      [
        { type: 'connect' },
        { type: 'frame', connectId: 'c3', state: 'failed', reasonCode: 'config.clientMissing' },
        { type: 'started', attempt: 1, connectId: 'c3' },
      ],
      typed(),
    );
    assert.equal(state.mode, 'failed');
    assert.equal(state.failure, 'config.clientMissing');
  });

  test('Account/connect refused outright shows the failed state', () => {
    const { state } = run([{ type: 'connect' }, { type: 'startFailed', attempt: 1 }], typed());
    assert.equal(state.mode, 'failed');
  });
});

describe('Esc ladder and the list', () => {
  test('Esc on a typed address clears to the field; Esc on an empty field goes back a step', () => {
    const cleared = accountsEsc(typed(), false);
    assert.equal(cleared.handled, true);
    assert.equal(cleared.state.address, '');
    assert.equal(accountsEsc(cleared.state, false).handled, false);
  });

  test('Esc on an empty field with accounts shows the list; Esc on the list goes back a step', () => {
    const toList = accountsEsc(initialAccounts(false), true);
    assert.equal(toList.state.mode, 'connected');
    assert.equal(accountsEsc(toList.state, true).handled, false);
  });

  test('entering the step shows the list when accounts exist, else the field', () => {
    assert.equal(
      reduceAccounts(typed(), { type: 'enter', hasAccounts: true }).state.mode,
      'connected',
    );
    assert.equal(
      reduceAccounts(typed(), { type: 'enter', hasAccounts: false }).state.mode,
      'choose',
    );
  });

  test('the list with no accounts draws the field instead', () => {
    assert.equal(shownMode(initialAccounts(true), 0), 'choose');
    assert.equal(shownMode(initialAccounts(true), 2), 'connected');
  });
});

describe('runAccountsEffect over ports', () => {
  const ports = (over: Partial<ConnectPorts>): ConnectPorts => ({
    discover: async () => ({ provider: 'google' }),
    connect: async () => ({ connectId: 'c9' }),
    cancelConnect: async () => ({ cancelled: true }),
    ...over,
  });

  test('connect passes provider google, login_hint and the setup id, then reports the id', async () => {
    const calls: unknown[] = [];
    const events: AccountsEvent[] = [];
    await runAccountsEffect(
      { type: 'connect', attempt: 3, loginHint: 'jordan.lee@example.com' },
      ports({
        connect: async input => {
          calls.push(input);
          return { connectId: 'c9' };
        },
      }),
      e => events.push(e),
      'setup-1',
    );
    assert.deepEqual(calls, [
      { provider: 'google', loginHint: 'jordan.lee@example.com', setupId: 'setup-1' },
    ]);
    assert.deepEqual(events, [{ type: 'started', attempt: 3, connectId: 'c9' }]);
  });

  test('a missing or failing discovery reports error, so Google is still offered', async () => {
    const events: AccountsEvent[] = [];
    await runAccountsEffect(
      { type: 'discover', address: 'a@example.com', seq: 4 },
      ports({
        discover: async () => {
          throw new Error('no');
        },
      }),
      e => events.push(e),
      undefined,
    );
    assert.deepEqual(events, [{ type: 'discovered', seq: 4, provider: 'error' }]);
  });
});
