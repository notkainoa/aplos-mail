import assert from 'node:assert/strict';
import test from 'node:test';
import { listenerCaller } from '@aplos/contract/access';
import { ContractError } from '@aplos/contract/contract-error';
import type { EngineMethodName, Input, Output } from '@aplos/contract';
import { createLogger } from '../../src/diag/log';
import { sha256Hex } from '../../src/diag/sha256';
import { createEngine, laneExtensions } from '../../src/index';
import { openStore, type StorePort } from '../../src/store';
import { manualClock } from '../runtime.helpers';
import { tempDb } from '../store/helpers';

/**
 * `Clients/grant` on the real engine (eng-host). The security shape: a 256-bit token is minted per grant,
 * the store holds only its SHA-256, and the plaintext goes to the host's `clientTokens` port for the 0600
 * file — never through the contract, a log or a window. `uiOnly` keeps the method itself off the listener,
 * so a tool can never mint another tool (FR-5's class of reach).
 */

async function world(opts: { withTokens?: boolean; removeRejects?: boolean } = {}) {
  const file = tempDb();
  const clock = manualClock();
  const store: StorePort = openStore(file.open(), {
    now: () => clock.now(),
    extensions: laneExtensions(),
  });
  const events: string[] = [];
  const log = createLogger({
    sink: { write: r => events.push(r.event) },
    salt: 'grant-test',
    clock,
  });
  const issued: { clientId: string; token: string }[] = [];
  const removed: string[] = [];
  const engine = await createEngine({
    store,
    clock,
    log,
    ports:
      opts.withTokens === false
        ? {}
        : {
            clientTokens: {
              issue: async (clientId: string, token: string) => {
                issued.push({ clientId, token });
                return { path: `/data/run/clients/${clientId}.token` };
              },
              remove: async (clientId: string) => {
                if (opts.removeRejects) throw new Error('remove exploded');
                removed.push(clientId);
              },
              pathOf: (clientId: string) => `/data/run/clients/${clientId}.token`,
              has: async (clientId: string) =>
                issued.some(i => i.clientId === clientId) && !removed.includes(clientId),
            },
          },
  });
  const session = engine.connect();
  const call = <M extends EngineMethodName>(method: M, args: Input<M>) =>
    session.call(method, args) as Promise<Output<M>>;
  const asClient = (
    id: string,
    kind: string,
    scopes: string[],
    via: 'socket' | 'http' | 'mcp' = 'socket',
  ) => engine.connect(listenerCaller({ id, kind, scopes }, via) as never);
  return { engine, store, clock, db: file.open(), call, asClient, issued, removed, events };
}

test('grant inserts the row with the token hash, hands the plaintext to the host, lists the client', async () => {
  const w = await world();
  try {
    const { client } = await w.call('Clients/grant', {
      name: 'My CLI',
      kind: 'cli',
      scopes: ['read', 'draft', 'read'],
    });
    assert.match(client.id, /^cl_[0-9a-f]{32}$/);
    assert.deepEqual(client.scopes, ['read', 'draft'], 'scopes dedupe, order kept');
    assert.equal(client.createdAt, w.clock.now());
    assert.equal(client.tokenPath, `/data/run/clients/${client.id}.token`);
    // Exactly one issue call, a 256-bit token, and only its SHA-256 at rest.
    assert.equal(w.issued.length, 1);
    const { token } = w.issued[0]!;
    assert.match(token, /^[0-9a-f]{64}$/);
    const row = w.db
      .prepare(
        'SELECT name, kind, token_hash, scopes, last_seen_at, revoked_at FROM clients WHERE id = ?',
      )
      .get(client.id) as Record<string, unknown>;
    assert.equal(row.token_hash, sha256Hex(token));
    assert.equal(row.scopes, '["read","draft"]');
    assert.equal(row.last_seen_at, null);
    assert.equal(row.revoked_at, null);
    const dump = w.db.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all();
    void dump;
    const stored = w.db.prepare('SELECT token_hash FROM clients').all() as { token_hash: string }[];
    assert.equal(
      stored.some(r => r.token_hash === token),
      false,
      'the plaintext is never stored',
    );
    // And the row reads back through Clients/list without a token path.
    const { list } = await w.call('Clients/list', {});
    assert.equal(list.length, 1);
    assert.equal(list[0]!.tokenPath, undefined);
    // Revoke then works on the granted row — and the token file is removed with it.
    await w.call('Clients/revoke', { id: client.id });
    assert.equal((await w.call('Clients/list', {})).list[0]!.revokedAt, w.clock.now());
    assert.deepEqual(w.removed, [client.id], 'revoke removes the token file');
  } finally {
    await w.engine.close();
  }
});

test('a grant with no token-file port answers unavailable and writes nothing', async () => {
  const w = await world({ withTokens: false });
  try {
    await assert.rejects(
      w.call('Clients/grant', { name: 'x', kind: 'cli', scopes: ['read'] }),
      (e: { type?: string }) => e.type === 'unavailable',
    );
    assert.equal((w.db.prepare('SELECT COUNT(*) AS n FROM clients').get() as { n: number }).n, 0);
  } finally {
    await w.engine.close();
  }
});

test('a failed issue leaves no client row', async () => {
  const w = await world();
  try {
    const engine = await createEngine({
      store: w.store,
      clock: w.clock,
      log: createLogger({ sink: { write: () => undefined }, salt: 's', clock: w.clock }),
      ports: {
        clientTokens: {
          issue: () => Promise.reject(new Error('disk full')),
          remove: () => Promise.resolve(),
          pathOf: (clientId: string) => `/data/run/clients/${clientId}.token`,
          has: () => Promise.resolve(false),
        },
      },
    });
    await assert.rejects(
      engine.connect().call('Clients/grant', { name: 'x', kind: 'cli', scopes: ['read'] }),
    );
    assert.equal((w.db.prepare('SELECT COUNT(*) AS n FROM clients').get() as { n: number }).n, 0);
    await engine.close();
  } finally {
    await w.engine.close();
  }
});

test('revoke still answers ok when the token file will not remove, and logs a warn', async () => {
  const w = await world({ removeRejects: true });
  try {
    const { client } = await w.call('Clients/grant', { name: 'c', kind: 'cli', scopes: ['read'] });
    assert.deepEqual(await w.call('Clients/revoke', { id: client.id }), { ok: true });
    assert.equal((await w.call('Clients/list', {})).list[0]!.revokedAt, w.clock.now());
    assert.ok(w.events.includes('client.token_remove_failed'), 'the failed remove is logged');
  } finally {
    await w.engine.close();
  }
});

test('a failed grant commit whose cleanup also fails still surfaces the commit error', async () => {
  const w = await world();
  try {
    // A store whose commit throws a distinct typed error: if the caller got the remove rejection instead,
    // it would arrive as a plain internal error — 'unavailable' can only be the commit's.
    const wrapped: StorePort = Object.create(Object.getPrototypeOf(w.store));
    Object.assign(wrapped, w.store, {
      commit: () => {
        throw new ContractError({ type: 'unavailable', message: 'commit exploded' });
      },
    });
    const engine = await createEngine({
      store: wrapped,
      clock: w.clock,
      log: createLogger({ sink: { write: () => undefined }, salt: 's', clock: w.clock }),
      ports: {
        clientTokens: {
          issue: () => Promise.resolve({ path: 'run/clients/x.token' }),
          remove: () => Promise.reject(new Error('remove exploded')),
          pathOf: (clientId: string) => `/data/run/clients/${clientId}.token`,
          has: () => Promise.resolve(false),
        },
      },
    });
    await assert.rejects(
      engine.connect().call('Clients/grant', { name: 'x', kind: 'cli', scopes: ['read'] }),
      (e: { type?: string }) => e.type === 'unavailable',
      'the caller sees the commit error, not the cleanup failure',
    );
    await engine.close();
  } finally {
    await w.engine.close();
  }
});

test('a failed grant commit removes the token file it issued', async () => {
  const w = await world();
  try {
    // An invalid write makes the commit throw after issue — the file must not linger.
    await assert.rejects(w.call('Clients/grant', { name: '', kind: 'cli', scopes: ['read'] }));
    assert.equal(w.issued.length, 1);
    assert.deepEqual(w.removed, [w.issued[0]!.clientId], 'the orphan file was removed');
    assert.equal((w.db.prepare('SELECT COUNT(*) AS n FROM clients').get() as { n: number }).n, 0);
  } finally {
    await w.engine.close();
  }
});

test('no caller but the app can grant: listener admin and mcp are refused before the handler', async () => {
  const w = await world();
  try {
    for (const session of [
      w.asClient('c1', 'cli', ['read', 'admin']),
      w.asClient('c2', 'mcp', ['read', 'admin'], 'mcp'),
    ]) {
      await assert.rejects(
        session.call('Clients/grant', { name: 'x', kind: 'cli', scopes: ['read'] }),
        (e: { type?: string }) => e.type === 'forbidden',
      );
    }
    assert.equal(w.issued.length, 0, 'no token was minted');
    assert.equal((w.db.prepare('SELECT COUNT(*) AS n FROM clients').get() as { n: number }).n, 0);
  } finally {
    await w.engine.close();
  }
});

test('a grant retry with the same name and kind returns the existing tool, no new row or file', async () => {
  const w = await world();
  try {
    const first = await w.call('Clients/grant', { name: 'dup', kind: 'cli', scopes: ['read'] });
    const second = await w.call('Clients/grant', { name: 'dup', kind: 'cli', scopes: ['read'] });
    assert.equal(second.client.id, first.client.id, 'the retry returns the existing grant');
    assert.equal(second.client.tokenPath, first.client.tokenPath, 'the retry shows the same path');
    assert.match(second.client.tokenPath ?? '', /^\//, 'the path is absolute like the first grant');
    assert.equal(w.issued.length, 1, 'no second token file was issued');
    assert.equal(
      (w.db.prepare('SELECT COUNT(*) AS n FROM clients').get() as { n: number }).n,
      1,
      'still one row',
    );
    // Different scopes are a different tool — no dedupe.
    const wider = await w.call('Clients/grant', {
      name: 'dup',
      kind: 'cli',
      scopes: ['read', 'admin'],
    });
    assert.notEqual(wider.client.id, first.client.id);
    // A revoked grant does not dedupe — a fresh grant mints a new row.
    await w.call('Clients/revoke', { id: first.client.id });
    const third = await w.call('Clients/grant', { name: 'dup', kind: 'cli', scopes: ['read'] });
    assert.notEqual(third.client.id, first.client.id);
  } finally {
    await w.engine.close();
  }
});
