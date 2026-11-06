// The `aplos://oauth-return` window binding: which live sign-in returns to the setup window and
// which returns to the mail window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlers } from '../../src/methods/account';
import type { MethodContext } from '../../src/methods/types';
import {
  ConnectSessions,
  connectionOpensOnboarding,
  noteOnboardingConnection,
  oauthReturnFor,
  oauthReturnKey,
  type ConnectFlow,
} from '../../src/sync/connect-sessions';
import { setup } from '../sync-account-helpers';

const fakeFlow = (key: string, mode: 'new' | 'reconnect' = 'new'): ConnectFlow => ({
  mode,
  accountId: `acct-${key}`,
  key,
  kind: 'google',
  request: { mode },
  accept: async () => ({}),
});

function sessions() {
  return new ConnectSessions({
    accounts: {
      connect: () => new Promise(() => {}),
      start: async () => {},
      stop: async () => {},
      status: () => undefined,
      claimLease: async () => {},
      releaseLease: async () => {},
      reconnected: async () => {},
      discardCredential: async () => {},
      wake: () => {},
    } as never,
    frames: { emit: () => {} } as never,
    randomBytes: n => new Uint8Array(n).fill(1),
    clock: { now: () => Date.now() },
    deadlines: { register: () => () => {}, changed: () => {} } as never,
  });
}

test('a connect carrying setupId marks its connection onboarding; an unmarked one is mail', () => {
  noteOnboardingConnection('c7');
  assert.equal(connectionOpensOnboarding('c7'), true);
  assert.equal(connectionOpensOnboarding('c8'), false);
});

test('oauthReturnKey maps a new request to new:<address> and others to account:<id>', () => {
  assert.equal(
    oauthReturnKey({ mode: 'new', address: 'Alex@Example.com' }, 'a1'),
    'new:alex@example.com',
  );
  assert.equal(oauthReturnKey({ mode: 'new' }, 'a1'), 'new:');
  assert.equal(oauthReturnKey({ mode: 'reconnect' }, 'a1'), 'account:a1');
  assert.equal(oauthReturnKey({ mode: 'grantPermissions' }, 'a1'), 'account:a1');
});

test('Account/connect binds the setup window only for a window caller carrying setupId', async () => {
  const t = setup();
  try {
    // The setup window's own connect returns to onboarding.
    await handlers['Account/connect'](
      { provider: 'google', address: 'w@gmail.com', setupId: 'setup-1' },
      t.ctx,
    );
    assert.equal(oauthReturnFor('new:w@gmail.com'), 'onboarding');
    // A non-window caller (a listener client, the CLI) that sends a setupId must still bind
    // 'mail': it can never surface the setup window.
    const listener: MethodContext = {
      ...t.ctx,
      caller: { kind: 'listener', scopes: ['admin'] },
      connectionId: 'c2',
    };
    await handlers['Account/connect'](
      { provider: 'google', address: 'l@gmail.com', setupId: 'setup-1' },
      listener,
    );
    assert.equal(oauthReturnFor('new:l@gmail.com'), 'mail');
    // ...and its connection is never marked as the setup window's, so a later reconnect or grant on it
    // cannot return to the setup window either (the window caller's own connection is marked).
    assert.equal(connectionOpensOnboarding('c2'), false);
    assert.equal(connectionOpensOnboarding(t.ctx.connectionId), true);
    // A window caller without a setupId is the mail window's Add account flow.
    await handlers['Account/connect']({ provider: 'google', address: 'm@gmail.com' }, t.ctx);
    assert.equal(oauthReturnFor('new:m@gmail.com'), 'mail');
  } finally {
    t.cleanup();
  }
});

test('an empty setupId is no setup session: a window caller binds mail (the old truthiness rule)', async () => {
  const t = setup();
  try {
    await handlers['Account/connect'](
      { provider: 'google', address: 'e@gmail.com', setupId: '' },
      t.ctx,
    );
    assert.equal(oauthReturnFor('new:e@gmail.com'), 'mail');
  } finally {
    t.cleanup();
  }
});

test('a live flow publishes its returnTo by key until the session ends', async () => {
  const s = sessions();
  const { connectId } = s.begin({ ...fakeFlow('new:a@b.c'), returnTo: 'onboarding' });
  assert.equal(oauthReturnFor('new:a@b.c'), 'onboarding');
  s.cancel(connectId);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(oauthReturnFor('new:a@b.c'), undefined);
});
