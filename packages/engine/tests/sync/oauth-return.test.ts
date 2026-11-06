// The `aplos://oauth-return` window binding: which live sign-in returns to the setup window and
// which returns to the mail window.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConnectSessions,
  connectionOpensOnboarding,
  noteOnboardingConnection,
  oauthReturnFor,
  oauthReturnKey,
  type ConnectFlow,
} from '../../src/sync/connect-sessions';

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

test('a live flow publishes its returnTo by key until the session ends', async () => {
  const s = sessions();
  const { connectId } = s.begin({ ...fakeFlow('new:a@b.c'), returnTo: 'onboarding' });
  assert.equal(oauthReturnFor('new:a@b.c'), 'onboarding');
  s.cancel(connectId);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(oauthReturnFor('new:a@b.c'), undefined);
});
