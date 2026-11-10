import assert from 'node:assert/strict';
import test from 'node:test';
import { listenerCaller } from '@aplos/contract/access';
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

async function world(opts: { withTokens?: boolean } = {}) {
  const file = tempDb();
  const clock = manualClock();
  const store: StorePort = openStore(file.open(), {
    now: () => clock.now(),
    extensions: laneExtensions(),
  });
  const log = createLogger({ sink: { write: () => undefined }, salt: 'grant-test', clock });
  const issued: { clientId: string; token: string }[] = [];
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
                return { path: `run/clients/${clientId}.token` };
              },
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
  return { engine, store, clock, db: file.open(), call, asClient, issued };
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
    assert.equal(client.tokenPath, `run/clients/${client.id}.token`);
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
    // Revoke then works on the granted row.
    await w.call('Clients/revoke', { id: client.id });
    assert.equal((await w.call('Clients/list', {})).list[0]!.revokedAt, w.clock.now());
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
