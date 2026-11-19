import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '@aplos/contract/contract-error';
import { handlers } from '../src/methods/account';
import type { MethodContext } from '../src/methods/types';
import type { AccountRuntime } from '../src/ports';
import { ProviderError } from '../src/ports/base';
import { T0 } from './store/helpers';
import { answer, CAPS, seed, setup, sentence, tick } from './sync-account-helpers';

test('Account/get lists every account with health, capabilities, lease and identities, and no secrets', async () => {
  const t = setup();
  try {
    seed(t.store, 'acct-1');
    seed(t.store, 'acct-2', 'sub-2', 'two@gmail.com');
    // Where a secret could ride along: the detail JSON, the settings JSON, and the live runtime object.
    t.db.exec(
      `UPDATE accounts SET status_detail = '{"credentialRef":"vault:LEAK","token":"ya29.LEAK"}', settings = '{"colorTag":"blue","credentialRef":"vault:LEAK","secret":"LEAK"}' WHERE id = 'acct-2'`,
    );
    t.statuses.set('acct-1', {
      credentialRef: 'vault:LEAK',
      refreshToken: 'LEAK',
      status: { state: 'syncing' },
      lastSyncAt: T0,
      reconnectBy: T0 + 5,
      grantedScopes: ['scope-a'],
      capabilities: CAPS,
      missingPermissions: [
        { capability: 'calendar', reasonCode: 'permission.calendar', missingScopes: ['cal'] },
      ],
      firstWindow: { read: 3, total: 50 },
      lease: { role: 'primary', holder: 'dev-1', until: T0 + 9, pinned: true },
    } as AccountRuntime);
    const out = await handlers['Account/get']({}, t.ctx);
    assert.deepEqual(
      out.list.map(a => a.id),
      ['acct-1', 'acct-2'],
    );
    const one = out.list[0];
    assert.deepEqual(one.health, {
      status: { state: 'syncing' },
      reconnectBy: T0 + 5,
      lastSyncAt: T0,
    });
    assert.equal(one.capabilities.labels, true);
    assert.equal(one.capabilities.threading, 'native');
    assert.deepEqual(one.lease, {
      role: 'primary',
      holderDeviceId: 'dev-1',
      until: T0 + 9,
      pinned: true,
    });
    assert.deepEqual(one.identities, [
      { address: 'owner@gmail.com', name: 'Owner', default: true },
    ]);
    assert.equal(one.missingPermissions?.[0].capability, 'calendar');
    assert.deepEqual(out.list[1].health.status, { state: 'ok' });
    assert.equal(out.list[1].colorTag, 'blue');
    assert.equal(out.list[1].health.reconnectBy, T0 + 1000);
    assert.equal(out.state.dbEpoch, t.store.dbEpoch);
    const text = JSON.stringify(out);
    assert.ok(!text.includes('LEAK'), 'a stored or live secret reached the output');
    assert.ok(!text.includes('sub-1'), 'the provider subject reached the output');
  } finally {
    t.cleanup();
  }
});

test('Account/get with ids returns those accounts and lists unknown ids apart; a stored pause reads back', async () => {
  const t = setup();
  try {
    seed(t.store);
    t.store.commit({
      opId: 'pause',
      origin: 'system',
      writes: [
        {
          kind: 'account',
          id: 'acct-1',
          status: {
            state: 'paused',
            until: T0 + 60_000,
            class: 'throttle',
            reason: 'rateLimitExceeded',
          },
          reasonCode: 'rate.minute',
        },
      ],
    });
    const out = await handlers['Account/get']({ ids: ['nope', 'acct-1'] }, t.ctx);
    assert.deepEqual(out.notFound, ['nope']);
    assert.deepEqual(out.list[0].health.status, {
      state: 'paused',
      until: T0 + 60_000,
      class: 'throttle',
      reason: 'rateLimitExceeded',
    });
    assert.equal(out.list[0].health.reasonCode, 'rate.minute');
  } finally {
    t.cleanup();
  }
});

test('Account/discover recognises gmail and googlemail and says plainly that the rest is unsupported', async () => {
  const t = setup();
  try {
    const google = await handlers['Account/discover']({ address: 'Me@GMail.com' }, t.ctx);
    assert.equal(google.provider, 'google');
    assert.equal(
      (await handlers['Account/discover']({ domain: 'googlemail.com' }, t.ctx)).provider,
      'google',
    );
    const other = await handlers['Account/discover']({ address: 'me@acme.example' }, t.ctx);
    assert.equal(other.provider, 'unsupported');
    assert.equal(other.reasonCode, 'discover.unsupported');
    assert.match(other.message ?? '', /Gmail/);
  } finally {
    t.cleanup();
  }
});

test('Account/connect returns a connectId at once, then reports waiting and connected and starts the account', async () => {
  const t = setup();
  try {
    const { connectId } = await handlers['Account/connect'](
      { provider: 'google', address: 'new@gmail.com', secret: 'hunter2' },
      t.ctx,
    );
    assert.equal(t.connectFrames().length, 0);
    await tick();
    assert.equal(t.pending.length, 1);
    assert.equal(t.pending[0].req.mode, 'new');
    assert.ok(!JSON.stringify(t.pending[0].req).includes('hunter2'));
    t.pending[0].resolve(answer('sub-new', 'new@gmail.com'));
    await tick();
    const accountId = t.pending[0].account;
    assert.deepEqual(
      t.connectFrames().map(f => f.frame === 'connect' && [f.state, f.mode, f.accountId]),
      [
        ['waiting', 'new', undefined],
        ['connected', 'new', accountId],
      ],
    );
    assert.ok(t.connectFrames().every(f => f.frame === 'connect' && f.connectId === connectId));
    assert.deepEqual(t.calls, [`start:${accountId}`]);
    const got = await handlers['Account/get']({ ids: [accountId] }, t.ctx);
    assert.equal(got.list[0].address, 'new@gmail.com');
    assert.equal(got.list[0].name, 'Owner');
    assert.ok(!JSON.stringify(t.frames).includes('secret-credential-ref'));
  } finally {
    t.cleanup();
  }
});

test('a second connect for the same address is refused while the first waits; an account that exists is not added twice', async () => {
  const t = setup();
  try {
    seed(t.store);
    await handlers['Account/connect']({ provider: 'google', address: 'dup@gmail.com' }, t.ctx);
    await assert.rejects(
      async () =>
        handlers['Account/connect']({ provider: 'google', address: 'DUP@gmail.com' }, t.ctx),
      (e: unknown) =>
        e instanceof ContractError && e.type === 'conflict' && /already open/.test(sentence(e)),
    );
    await tick();
    t.pending[0].resolve(answer('sub-1', 'owner@gmail.com'));
    await tick();
    const last = t.connectFrames().at(-1);
    assert.ok(
      last?.frame === 'connect' && last.state === 'failed' && last.reasonCode === 'account.exists',
    );
    assert.deepEqual(t.calls, []);
    assert.equal((await handlers['Account/get']({}, t.ctx)).list.length, 1);
  } finally {
    t.cleanup();
  }
});

test('Account/connect is Gmail only in round 1', async () => {
  const t = setup();
  try {
    await assert.rejects(
      async () => handlers['Account/connect']({ provider: 'imap', address: 'a@b.example' }, t.ctx),
      (e: unknown) => e instanceof ContractError && e.type === 'unsupported',
    );
  } finally {
    t.cleanup();
  }
});

test('Account/reconnect passes the login hint and subject, names the account on every frame, keeps the actor running', async () => {
  const t = setup();
  try {
    seed(t.store);
    const { connectId } = await handlers['Account/reconnect']({ accountId: 'acct-1' }, t.ctx);
    await tick();
    assert.equal(t.pending[0].req.loginHint, 'owner@gmail.com');
    assert.equal(t.pending[0].req.expectedSubject, 'sub-1');
    assert.equal(t.pending[0].req.mode, 'reconnect');
    t.pending[0].resolve(answer('sub-1', 'owner@gmail.com'));
    await tick();
    const frames = t.connectFrames();
    assert.deepEqual(
      frames.map(f => f.frame === 'connect' && [f.connectId, f.mode, f.state, f.accountId]),
      [
        [connectId, 'reconnect', 'waiting', 'acct-1'],
        [connectId, 'reconnect', 'connected', 'acct-1'],
      ],
    );
    assert.deepEqual(t.calls, ['reconnected:acct-1']);
  } finally {
    t.cleanup();
  }
});

test('Account/reconnect refuses another Google account and stores nothing', async () => {
  const t = setup();
  try {
    seed(t.store);
    const before = t.store.seq();
    await handlers['Account/reconnect']({ accountId: 'acct-1' }, t.ctx);
    await assert.rejects(
      async () => handlers['Account/reconnect']({ accountId: 'acct-1' }, t.ctx),
      (e: unknown) => e instanceof ContractError && /already open/.test(sentence(e)),
    );
    await tick();
    t.pending[0].resolve(answer('sub-OTHER', 'other@gmail.com'));
    await tick();
    const last = t.connectFrames().at(-1);
    assert.ok(last?.frame === 'connect' && last.state === 'failed');
    assert.equal(last.reasonCode, 'auth.wrongAccount');
    assert.equal(last.accountId, 'acct-1');
    assert.deepEqual(t.calls, []);
    assert.equal(t.store.seq(), before);
    // The refused sign-in is over: another may start.
    await handlers['Account/reconnect']({ accountId: 'acct-1' }, t.ctx);
  } finally {
    t.cleanup();
  }
});

test('Account/grantPermissions runs the same flow under its own mode', async () => {
  const t = setup();
  try {
    seed(t.store);
    await handlers['Account/grantPermissions']({ accountId: 'acct-1' }, t.ctx);
    await tick();
    assert.equal(t.pending[0].req.mode, 'grantPermissions');
    t.pending[0].resolve(answer('sub-1', 'owner@gmail.com'));
    await tick();
    const modes = t.connectFrames().map(f => f.frame === 'connect' && f.mode);
    assert.deepEqual(modes, ['grantPermissions', 'grantPermissions']);
    assert.deepEqual(t.calls, ['reconnected:acct-1']);
  } finally {
    t.cleanup();
  }
});

test('Account/grantPermissions carries the calendarWrite opt-in to the sign-in only when named', async () => {
  const t = setup();
  try {
    seed(t.store);
    await handlers['Account/grantPermissions']({ accountId: 'acct-1' }, t.ctx);
    await tick();
    assert.equal(t.pending[0].req.enable, undefined);
    t.pending[0].resolve(answer('sub-1', 'owner@gmail.com'));
    await tick();

    await handlers['Account/grantPermissions'](
      { accountId: 'acct-1', enable: 'calendarWrite' },
      t.ctx,
    );
    await tick();
    assert.equal(t.pending[1].req.mode, 'grantPermissions');
    assert.equal(t.pending[1].req.enable, 'calendarWrite');
    t.pending[1].resolve(answer('sub-1', 'owner@gmail.com'));
    await tick();

    // A plain reconnect can never widen the grant, even if a caller passes the field.
    const sneaky = { accountId: 'acct-1', enable: 'calendarWrite' } as { accountId: string };
    await handlers['Account/reconnect'](sneaky, t.ctx);
    await tick();
    assert.equal(t.pending[2].req.mode, 'reconnect');
    assert.equal(t.pending[2].req.enable, undefined);
    t.pending[2].resolve(answer('sub-1', 'owner@gmail.com'));
    await tick();
  } finally {
    t.cleanup();
  }
});

test('Account/cancelConnect emits cancelled and ignores a late answer', async () => {
  const t = setup();
  try {
    seed(t.store);
    const { connectId } = await handlers['Account/reconnect']({ accountId: 'acct-1' }, t.ctx);
    await tick();
    assert.deepEqual(await handlers['Account/cancelConnect']({ connectId }, t.ctx), {
      cancelled: true,
    });
    t.pending[0].resolve(answer('sub-1', 'owner@gmail.com'));
    await tick();
    assert.deepEqual(
      t.connectFrames().map(f => f.frame === 'connect' && [f.state, f.mode, f.accountId]),
      [
        ['waiting', 'reconnect', 'acct-1'],
        ['cancelled', 'reconnect', 'acct-1'],
      ],
    );
    assert.deepEqual(t.calls, []);
    assert.deepEqual(await handlers['Account/cancelConnect']({ connectId }, t.ctx), {
      cancelled: false,
    });
    await handlers['Account/reconnect']({ accountId: 'acct-1' }, t.ctx);
  } finally {
    t.cleanup();
  }
});

test('a failed connect reports a copy key and never the secret or the provider text', async () => {
  const t = setup();
  try {
    await handlers['Account/connect']({ provider: 'google', address: 'x@gmail.com' }, t.ctx);
    await tick();
    t.pending[0].reject(
      new ProviderError({
        class: 'permission',
        provider: 'oauth',
        method: 'oauth.token',
        reason: 'missingRequiredScope',
        providerMessage: 'ya29.access-token-text',
      }),
    );
    await tick();
    const last = t.connectFrames().at(-1);
    assert.ok(last?.frame === 'connect' && last.state === 'failed');
    assert.equal(last.reasonCode, 'permission.mailModify');
    assert.ok(!JSON.stringify(t.frames).includes('ya29'));
    assert.deepEqual(t.calls, []);
  } finally {
    t.cleanup();
  }
});

test('Account/updateSecret is unsupported for a Google account', async () => {
  const t = setup();
  try {
    seed(t.store);
    await assert.rejects(
      async () => handlers['Account/updateSecret']({ accountId: 'acct-1', secret: 'pw' }, t.ctx),
      (e: unknown) =>
        e instanceof ContractError && e.type === 'unsupported' && /Google/.test(sentence(e)),
    );
    await assert.rejects(
      async () => handlers['Account/updateSecret']({ accountId: 'nope', secret: 'pw' }, t.ctx),
      (e: unknown) => e instanceof ContractError && e.type === 'notFound',
    );
  } finally {
    t.cleanup();
  }
});

test('Account/set renames and flips AI use with a receipt, and replays an opId without writing again', async () => {
  const t = setup();
  try {
    seed(t.store);
    const args = { opId: 'op-1', accountId: 'acct-1', name: ' Work ', aiAllowed: true };
    const first = await handlers['Account/set'](args, t.ctx);
    assert.equal(first.account.name, 'Work');
    assert.equal(first.account.aiAllowed, true);
    assert.equal(first.receipt.opId, 'op-1');
    assert.equal(first.receipt.appliedState.seq, t.store.seq());
    const seq = t.store.seq();
    const again = await handlers['Account/set']({ ...args, name: 'Changed' }, t.ctx);
    assert.equal(again.account.name, 'Work');
    assert.equal(t.store.seq(), seq);
    const cleared = await handlers['Account/set'](
      { opId: 'op-2', accountId: 'acct-1', name: '  ' },
      t.ctx,
    );
    assert.equal(cleared.account.name, 'owner@gmail.com');
    await assert.rejects(
      async () => handlers['Account/set']({ opId: 'op-3', accountId: 'nope', name: 'x' }, t.ctx),
      (e: unknown) => e instanceof ContractError && e.type === 'notFound',
    );
  } finally {
    t.cleanup();
  }
});

test('Account/set refuses a colour or notification change before writing anything (store gap)', async () => {
  const t = setup();
  try {
    seed(t.store);
    const seq = t.store.seq();
    await assert.rejects(
      async () =>
        handlers['Account/set'](
          { opId: 'op-9', accountId: 'acct-1', name: 'New', colorTag: 'blue' },
          t.ctx,
        ),
      (e: unknown) => e instanceof ContractError && e.type === 'unavailable',
    );
    assert.equal(t.store.seq(), seq);
  } finally {
    t.cleanup();
  }
});

test('Account/lease pins or releases one account or all, and answers from the actors status', async () => {
  const t = setup();
  try {
    seed(t.store, 'acct-1');
    seed(t.store, 'acct-2', 'sub-2', 'two@gmail.com');
    t.statuses.set('acct-1', {
      lease: { role: 'primary', holder: 'dev-1', pinned: true },
    } as AccountRuntime);
    const one = await handlers['Account/lease']({ accountId: 'acct-1', pin: true }, t.ctx);
    assert.deepEqual(t.calls, ['claim:acct-1']);
    assert.deepEqual(one.leases, [
      { accountId: 'acct-1', lease: { role: 'primary', holderDeviceId: 'dev-1', pinned: true } },
    ]);
    await handlers['Account/lease']({ pin: false }, t.ctx);
    assert.deepEqual(t.calls.slice(1), ['release:acct-1', 'release:acct-2']);
    await assert.rejects(
      async () => handlers['Account/lease']({ accountId: 'nope', pin: true }, t.ctx),
      (e: unknown) => e instanceof ContractError && e.type === 'notFound',
    );
  } finally {
    t.cleanup();
  }
});

test('Account/disconnect is refused while a message is sending, then stops the actor and removes the account', async () => {
  const t = setup();
  try {
    seed(t.store);
    t.db.exec(
      `INSERT INTO submissions(id, draft_id, account_id, internet_id, not_before, state) VALUES('s1', 'd1', 'acct-1', '<i@x>', 1, 'sending')`,
    );
    await assert.rejects(
      async () => handlers['Account/disconnect']({ opId: 'op-d', accountId: 'acct-1' }, t.ctx),
      (e: unknown) =>
        e instanceof ContractError && e.type === 'conflict' && /sent/.test(sentence(e)),
    );
    assert.deepEqual(t.calls, [], 'a refused removal stops nothing');
    t.db.exec(`UPDATE submissions SET state = 'sent'`);
    const receipt = await handlers['Account/disconnect'](
      { opId: 'op-d', accountId: 'acct-1' },
      t.ctx,
    );
    assert.equal(receipt.opId, 'op-d');
    assert.deepEqual(t.calls, ['stop:acct-1:disconnect']);
    assert.equal((await handlers['Account/get']({}, t.ctx)).list.length, 0);
  } finally {
    t.cleanup();
  }
});

test('Account/lease is all or nothing: a failing pin puts the earlier ones back', async () => {
  const t = setup();
  try {
    seed(t.store, 'acct-1');
    seed(t.store, 'acct-2', 'sub-2', 'two@gmail.com');
    const host = t.ctx.services.accounts;
    host.claimLease = async id => {
      t.calls.push(`claim:${id}`);
      if (id === 'acct-2') throw new Error('workflow channel down');
    };
    await assert.rejects(
      async () => handlers['Account/lease']({ pin: true }, t.ctx),
      /channel down/,
    );
    assert.deepEqual(t.calls, ['claim:acct-1', 'claim:acct-2', 'release:acct-1', 'release:acct-2']);
  } finally {
    t.cleanup();
  }
});

test('Account/lease stops between accounts when the call is cancelled, and undoes what it did', async () => {
  const t = setup();
  try {
    seed(t.store, 'acct-1');
    seed(t.store, 'acct-2', 'sub-2', 'two@gmail.com');
    const controller = new AbortController();
    const ctx = { ...t.ctx, signal: controller.signal } as MethodContext;
    ctx.services.accounts.claimLease = async id => {
      t.calls.push(`claim:${id}`);
      controller.abort();
    };
    await assert.rejects(
      async () => handlers['Account/lease']({ pin: true }, ctx),
      (e: unknown) => e instanceof ContractError && e.type === 'cancelled',
    );
    assert.deepEqual(t.calls, ['claim:acct-1', 'release:acct-1']);
  } finally {
    t.cleanup();
  }
});
