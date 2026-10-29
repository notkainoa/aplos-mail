import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '@aplos/contract/contract-error';
import { handlers } from '../src/methods/account';
import type { ConnectResult } from '../src/ports';
import { disposeConnectSessions } from '../src/sync/connect-sessions';
import { T0 } from './store/helpers';
import { answer, seed, setup, sentence, tick } from './sync-account-helpers';

test('a cancel that lands after the answer won the race but before it was stored stands: no connected after cancelled', async () => {
  const t = setup();
  try {
    seed(t.store);
    const { connectId } = await handlers['Account/reconnect']({ accountId: 'acct-1' }, t.ctx);
    await tick();
    t.pending[0].resolve(answer('sub-1', 'owner@gmail.com'));
    // One turn: the answer has settled the wait, its continuation has not run yet.
    await Promise.resolve();
    assert.deepEqual(await handlers['Account/cancelConnect']({ connectId }, t.ctx), {
      cancelled: true,
    });
    await tick();
    assert.deepEqual(
      t.connectFrames().map(f => f.frame === 'connect' && f.state),
      ['waiting', 'cancelled'],
    );
    assert.deepEqual(t.calls, []);
  } finally {
    t.cleanup();
  }
});

test('cancelling a new-account sign-in emits cancelled in mode new, without an account id, and frees the address', async () => {
  const t = setup();
  try {
    const { connectId } = await handlers['Account/connect'](
      { provider: 'google', address: 'c@gmail.com' },
      t.ctx,
    );
    await tick();
    await handlers['Account/cancelConnect']({ connectId }, t.ctx);
    t.pending[0].resolve(answer('sub-c', 'c@gmail.com'));
    await tick();
    assert.deepEqual(
      t.connectFrames().map(f => f.frame === 'connect' && [f.mode, f.state, f.accountId]),
      [
        ['new', 'waiting', undefined],
        ['new', 'cancelled', undefined],
      ],
    );
    assert.deepEqual(t.calls, []);
    assert.equal((await handlers['Account/get']({}, t.ctx)).list.length, 0);
    await handlers['Account/connect']({ provider: 'google', address: 'c@gmail.com' }, t.ctx);
  } finally {
    t.cleanup();
  }
});

test('when start() throws after the row was committed, a retry for the same address finishes it instead of refusing', async () => {
  const t = setup();
  try {
    t.flags.failStart = true;
    await handlers['Account/connect']({ provider: 'google', address: 'r@gmail.com' }, t.ctx);
    await tick();
    t.pending[0].resolve(answer('sub-r', 'r@gmail.com'));
    await tick();
    const failed = t.connectFrames().at(-1);
    assert.ok(failed?.frame === 'connect' && failed.state === 'failed');
    const stored = (await handlers['Account/get']({}, t.ctx)).list;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].health.status.state, 'starting');
    t.flags.failStart = false;
    t.calls.length = 0;
    // Not refused up front, and not as a duplicate once Google answers.
    await handlers['Account/connect']({ provider: 'google', address: 'r@gmail.com' }, t.ctx);
    await tick();
    assert.equal(t.pending[1].account, stored[0].id, 'the retry signs in under the waiting row');
    t.pending[1].resolve(answer('sub-r', 'r@gmail.com'));
    await tick();
    const last = t.connectFrames().at(-1);
    assert.ok(last?.frame === 'connect' && last.state === 'connected');
    assert.equal(last.accountId, stored[0].id);
    assert.deepEqual(t.calls, [`reconnected:${stored[0].id}`, `start:${stored[0].id}`]);
    assert.equal((await handlers['Account/get']({}, t.ctx)).list.length, 1);
  } finally {
    t.cleanup();
  }
});

test('an added account is refused up front from the address, before any browser opens', async () => {
  const t = setup();
  try {
    seed(t.store);
    await assert.rejects(
      async () =>
        handlers['Account/connect']({ provider: 'google', address: 'OWNER@gmail.com' }, t.ctx),
      (e: unknown) => e instanceof ContractError && e.body.reasonCode === 'account.exists',
    );
    await tick();
    assert.equal(t.pending.length, 0);
  } finally {
    t.cleanup();
  }
});

test('a reconnect re-reads the stored identity when Google answers, not only when it started', async () => {
  const t = setup();
  try {
    seed(t.store);
    t.db.exec(`UPDATE accounts SET remote_subject = NULL WHERE id = 'acct-1'`);
    await handlers['Account/reconnect']({ accountId: 'acct-1' }, t.ctx);
    await tick();
    assert.equal(t.pending[0].req.expectedSubject, undefined);
    // While the browser was open another window completed a sign-in that stored the subject.
    t.db.exec(`UPDATE accounts SET remote_subject = 'sub-1' WHERE id = 'acct-1'`);
    t.pending[0].resolve(answer('sub-OTHER', 'owner@gmail.com'));
    await tick();
    const last = t.connectFrames().at(-1);
    assert.ok(last?.frame === 'connect' && last.state === 'failed');
    assert.equal(last.reasonCode, 'auth.wrongAccount');
    assert.deepEqual(t.calls, []);
  } finally {
    t.cleanup();
  }
});

test('with no stored subject the address match is accepted once, and the new subject is adopted', async () => {
  const t = setup();
  try {
    seed(t.store);
    t.db.exec(`UPDATE accounts SET remote_subject = NULL WHERE id = 'acct-1'`);
    await handlers['Account/reconnect']({ accountId: 'acct-1' }, t.ctx);
    await tick();
    t.pending[0].resolve(answer('sub-new', 'OWNER@gmail.com'));
    await tick();
    assert.deepEqual(t.calls, ['reconnected:acct-1']);
    // A different address with no stored subject is still another identity.
    await handlers['Account/reconnect']({ accountId: 'acct-1' }, t.ctx);
    await tick();
    t.pending[1].resolve(answer('sub-x', 'someone@gmail.com'));
    await tick();
    const last = t.connectFrames().at(-1);
    assert.ok(last?.frame === 'connect' && last.reasonCode === 'auth.wrongAccount');
    assert.deepEqual(t.calls, ['reconnected:acct-1']);
  } finally {
    t.cleanup();
  }
});

test('disposing the sessions aborts a waiting sign-in and frees its key', async () => {
  const t = setup();
  try {
    seed(t.store);
    await handlers['Account/reconnect']({ accountId: 'acct-1' }, t.ctx);
    await tick();
    disposeConnectSessions(t.ctx.services);
    assert.equal(t.sources.length, 0, 'the deadline source is unregistered');
    t.pending[0].resolve(answer('sub-1', 'owner@gmail.com'));
    await tick();
    assert.deepEqual(t.calls, []);
    assert.deepEqual(
      t.connectFrames().map(f => f.frame === 'connect' && f.state),
      ['waiting'],
    );
    await handlers['Account/reconnect']({ accountId: 'acct-1' }, t.ctx);
  } finally {
    t.cleanup();
  }
});

const noMailScope = (subject: string, address: string): ConnectResult => ({
  ...answer(subject, address),
  grantedScopes: ['openid', 'https://www.googleapis.com/auth/calendar.events'],
});

test('a new account whose grant lacks the mail scope is refused: no row, no start', async () => {
  const t = setup();
  try {
    const before = t.store.seq();
    await handlers['Account/connect']({ provider: 'google', address: 'n@gmail.com' }, t.ctx);
    await tick();
    t.pending[0].resolve(noMailScope('sub-n', 'n@gmail.com'));
    await tick();
    const last = t.connectFrames().at(-1);
    assert.ok(last?.frame === 'connect' && last.state === 'failed');
    assert.equal(last.reasonCode, 'permission.mailModify');
    assert.deepEqual(t.calls, []);
    assert.equal(t.store.seq(), before);
    assert.equal((await handlers['Account/get']({}, t.ctx)).list.length, 0);
  } finally {
    t.cleanup();
  }
});

for (const method of ['Account/reconnect', 'Account/grantPermissions'] as const) {
  test(`${method} with a grant that lacks the mail scope is refused: scopes stay, the auth block stays`, async () => {
    const t = setup();
    try {
      seed(t.store);
      const before = t.store.seq();
      await handlers[method]({ accountId: 'acct-1' }, t.ctx);
      await tick();
      t.pending[0].resolve(noMailScope('sub-1', 'owner@gmail.com'));
      await tick();
      const last = t.connectFrames().at(-1);
      assert.ok(last?.frame === 'connect' && last.state === 'failed');
      assert.equal(last.reasonCode, 'permission.mailModify');
      assert.equal(last.accountId, 'acct-1');
      assert.deepEqual(t.calls, []);
      assert.equal(t.store.seq(), before);
    } finally {
      t.cleanup();
    }
  });
}

test('a frame bus that throws on waiting leaves no stuck session: the key is free again', async () => {
  const t = setup();
  try {
    seed(t.store);
    t.flags.failWaiting = true;
    await handlers['Account/reconnect']({ accountId: 'acct-1' }, t.ctx);
    await tick();
    t.flags.failWaiting = false;
    assert.equal(t.pending.length, 0, 'the sign-in never reached the host');
    await handlers['Account/reconnect']({ accountId: 'acct-1' }, t.ctx);
  } finally {
    t.cleanup();
  }
});

test('at most three sign-ins wait at once; the fourth is refused in plain words', async () => {
  const t = setup();
  try {
    for (const name of ['a', 'b', 'c'])
      await handlers['Account/connect'](
        { provider: 'google', address: `${name}@gmail.com` },
        t.ctx,
      );
    await assert.rejects(
      async () =>
        handlers['Account/connect']({ provider: 'google', address: 'd@gmail.com' }, t.ctx),
      (e: unknown) =>
        e instanceof ContractError && e.type === 'conflict' && /Too many/.test(sentence(e)),
    );
    await tick();
    assert.equal(t.pending.length, 3);
  } finally {
    t.cleanup();
  }
});

test('a sign-in the browser never finishes expires after ten minutes as failed, aborted, and its answer is ignored', async () => {
  const t = setup();
  try {
    seed(t.store);
    await handlers['Account/reconnect']({ accountId: 'acct-1' }, t.ctx);
    await tick();
    const source = t.sources[0];
    assert.equal(await source.next(), T0 + 10 * 60_000);
    t.clock.t = T0 + 10 * 60_000;
    await source.fire(t.clock.t);
    const last = t.connectFrames().at(-1);
    assert.ok(last?.frame === 'connect' && last.state === 'failed');
    assert.equal(last.reasonCode, 'auth.timeout');
    assert.equal(last.accountId, 'acct-1');
    assert.equal(await source.next(), undefined);
    t.pending[0].resolve(answer('sub-1', 'owner@gmail.com'));
    await tick();
    assert.deepEqual(t.calls, []);
    assert.equal(t.connectFrames().length, 2);
    await handlers['Account/reconnect']({ accountId: 'acct-1' }, t.ctx);
  } finally {
    t.cleanup();
  }
});
