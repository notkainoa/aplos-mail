import test from 'node:test';
import assert from 'node:assert/strict';
import type { Frame } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { handlers } from '../src/methods/account';
import type { MethodContext } from '../src/methods/types';
import type { EngineServices } from '../src/runtime/services';
import type { AccountActorHost, AccountRuntime, ConnectRequest, ConnectResult } from '../src/ports';
import { ProviderError } from '../src/ports/base';
import { openStore, type StorePort } from '../src/store';
import { tempDb, T0 } from './store/helpers';

const CAPS = {
  labels: true,
  folders: false,
  drafts: true,
  serverSearch: true,
  calendar: true,
  filters: true,
  push: false,
  sendAs: true,
  unsubscribeHeaders: true,
  threading: 'native' as const,
};

function answer(subject: string, address: string): ConnectResult {
  return {
    identity: { subject, address, displayName: 'Owner' },
    grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'],
    capabilities: CAPS,
    grant: { grantedAt: T0, refreshExpiresAt: T0 + 7 * 86_400_000, client: 'client-1' },
    credentialRef: 'vault:secret-credential-ref',
  };
}

interface Pending {
  account: string;
  kind: string;
  req: ConnectRequest;
  resolve(r: ConnectResult): void;
  reject(e: unknown): void;
}

function setup() {
  const file = tempDb();
  const store: StorePort = openStore(file.open(), { now: () => T0 });
  const frames: Frame[] = [];
  const calls: string[] = [];
  const pending: Pending[] = [];
  const statuses = new Map<string, AccountRuntime>();
  const accounts = {
    connect: (account: string, kind: string, req: ConnectRequest) =>
      new Promise<ConnectResult>((resolve, reject) => {
        pending.push({ account, kind, req, resolve, reject });
      }),
    start: async (id: string) => void calls.push(`start:${id}`),
    stop: async (id: string, why: string) => void calls.push(`stop:${id}:${why}`),
    reconnected: async (id: string) => void calls.push(`reconnected:${id}`),
    claimLease: async (id: string) => void calls.push(`claim:${id}`),
    releaseLease: async (id: string) => void calls.push(`release:${id}`),
    status: (id: string) => statuses.get(id),
  } as unknown as AccountActorHost;
  let n = 0;
  const services = {
    store,
    accounts,
    frames: {
      emit: (f: unknown) => void frames.push(f as Frame),
      changed() {},
      reset() {},
    },
    randomBytes: (len: number) => new Uint8Array(len).fill(++n),
  } as unknown as EngineServices;
  const ctx = {
    caller: { kind: 'window', scopes: ['admin'] },
    signal: new AbortController().signal,
    services,
    connectionId: 'c1',
    redispatch: () => Promise.reject(new Error('unused')),
  } as MethodContext;
  const db = file.open();
  return {
    store,
    frames,
    calls,
    pending,
    statuses,
    ctx,
    db,
    connectFrames: () => frames.filter(f => f.frame === 'connect'),
    cleanup() {
      store.close();
      db.close();
      file.cleanup();
    },
  };
}

function seed(store: StorePort, id = 'acct-1', subject = 'sub-1', address = 'owner@gmail.com') {
  store.commit({
    opId: `seed-${id}`,
    origin: 'system',
    writes: [
      {
        kind: 'account',
        id,
        provider: 'google',
        address,
        displayName: 'Owner',
        capabilities: { ...CAPS },
        grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'],
        status: { state: 'ok' },
        remoteSubject: subject,
        refreshExpiresAt: T0 + 1000,
      },
    ],
  });
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));
const sentence = (e: unknown) => (e instanceof ContractError ? e.body.message : String(e));

test('Account/get lists every account with health, capabilities, lease and identities, and no secrets', async () => {
  const t = setup();
  try {
    seed(t.store, 'acct-1');
    seed(t.store, 'acct-2', 'sub-2', 'two@gmail.com');
    t.statuses.set('acct-1', {
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
    assert.equal(out.list[1].health.status.state, 'ok');
    assert.equal(out.list[1].health.reconnectBy, T0 + 1000);
    assert.equal(out.state.dbEpoch, t.store.dbEpoch);
    const text = JSON.stringify(out);
    for (const word of ['credential', 'vault', 'token', 'secret', 'remoteSubject', 'sub-1']) {
      assert.ok(!text.includes(word), `${word} must not appear`);
    }
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

test('Account/disconnect is refused while a message is sending, and stops and deletes nothing while the store cannot remove an account', async () => {
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
    t.db.exec(`UPDATE submissions SET state = 'sent'`);
    await assert.rejects(
      async () => handlers['Account/disconnect']({ opId: 'op-d', accountId: 'acct-1' }, t.ctx),
      (e: unknown) => e instanceof ContractError && e.type === 'unavailable',
    );
    assert.deepEqual(t.calls, []);
    assert.equal((await handlers['Account/get']({}, t.ctx)).list.length, 1);
  } finally {
    t.cleanup();
  }
});
