import assert from 'node:assert/strict';
import test from 'node:test';
import { listenerCaller } from '@aplos/contract/access';
import type { EngineMethodName, Input, Output } from '@aplos/contract';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import { openStore } from '../../src/store';
import { manualClock } from '../runtime.helpers';
import { T0, tempDb } from '../store/helpers';

async function world() {
  const file = tempDb();
  const clock = manualClock();
  const store = openStore(file.open(), { now: () => clock.now(), extensions: laneExtensions() });
  const log = createLogger({ sink: { write: () => undefined }, salt: 's', clock });
  const engine = await createEngine({ store, clock, log });
  const window = engine.connect();
  const call = <M extends EngineMethodName>(method: M, args: Input<M>) =>
    window.call(method, args) as Promise<Output<M>>;
  const db = file.open();
  const addClient = (id: string) =>
    db
      .prepare(
        "INSERT INTO clients(id, name, kind, token_hash, scopes, created_at) VALUES(?, ?, 'cli', 'h', '[\"read\",\"admin\"]', ?)",
      )
      .run(id, `tool ${id}`, T0);
  const asClient = (id: string) =>
    engine.connect(listenerCaller({ id, kind: 'cli', scopes: ['read', 'admin'] }, 'http') as never);
  return { call, db, addClient, asClient, clock };
}

test('Clients/revoke stamps once: a second revoke does not move the time, an unknown client is notFound', async () => {
  const w = await world();
  w.addClient('c1');
  await w.call('Clients/revoke', { id: 'c1' });
  const first = (await w.call('Clients/list', {})).list[0]!.revokedAt;
  assert.ok(first);
  w.clock.advance(60_000);
  await w.call('Clients/revoke', { id: 'c1' });
  assert.equal(
    (await w.call('Clients/list', {})).list[0]!.revokedAt,
    first,
    'the first revoke time stands',
  );
  await assert.rejects(
    w.call('Clients/revoke', { id: 'nope' }),
    (e: { type?: string }) => e.type === 'notFound',
  );
});

test("Clients/audit never shows a target that can be content: an allowed sender's address stays in the engine", async () => {
  const w = await world();
  w.addClient('c1');
  w.addClient('c2');
  await w.asClient('c1').call('Mail/allowImages', {
    opId: 'a1',
    sender: 'secret.person@private.example',
    allow: true,
  });
  // Cutting a tool off is the app's alone: a tool (even an admin one) is refused, and the owner's own revoke is not audited.
  await assert.rejects(
    w.asClient('c2').call('Clients/revoke', { id: 'c1' }),
    (e: { type?: string }) => e.type === 'forbidden',
  );
  await w.call('Clients/revoke', { id: 'c1' });
  const { list } = await w.call('Clients/audit', {});
  assert.deepEqual(
    list.map(e => e.method),
    ['Mail/allowImages'],
  );
  assert.equal(list[0]!.target, undefined, 'no sender address');
  assert.equal(JSON.stringify(list).includes('private.example'), false);
  // The row itself still holds it (content-free means the READERS withhold it; the table is the engine's).
  assert.equal(
    (w.db.prepare('SELECT target FROM audit_log').all() as Array<{ target: string }>)[0]!.target,
    'secret.person@private.example',
  );
});

test('a revoked client cannot use a connection it still holds: refused on the next call, a window is not', async () => {
  const w = await world();
  w.addClient('c1');
  const client = w.asClient('c1');
  assert.ok(await client.call('Settings/get', {}), 'allowed before');
  await w.call('Clients/revoke', { id: 'c1' });
  await assert.rejects(
    client.call('Settings/get', {}),
    (e: { type?: string; message?: string }) =>
      e.type === 'forbidden' && /no longer allowed/.test(e.message ?? ''),
  );
  assert.ok(await w.call('Settings/get', {}), 'the app is unaffected');
  // A client the engine has no row for is the transport's to authenticate: not refused here.
  assert.ok(await w.asClient('unknown').call('Settings/get', {}));
});
