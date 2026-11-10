import assert from 'node:assert/strict';
import test from 'node:test';
import { listenerCaller } from '@aplos/contract/access';
import type { EngineMethodName, Input, Output } from '@aplos/contract';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import { openStore, type StorePort } from '../../src/store';
import { manualClock } from '../runtime.helpers';
import { tempDb } from '../store/helpers';

/**
 * `Workflow/*` on the real engine (prov-gmail's area): device sync of Done/Later/reminders over the sealed
 * channel. Pairing (the code carries the shared data key) has no port, so enable and code answer
 * `unavailable`, status reports the flag plus `available:false`, and disable is the idempotent off.
 */

async function world() {
  const file = tempDb();
  const clock = manualClock();
  const store: StorePort = openStore(file.open(), {
    now: () => clock.now(),
    extensions: laneExtensions(),
  });
  const log = createLogger({ sink: { write: () => undefined }, salt: 'wf-test', clock });
  const engine = await createEngine({ store, clock, log });
  const session = engine.connect();
  const call = <M extends EngineMethodName>(method: M, args: Input<M>) =>
    session.call(method, args) as Promise<Output<M>>;
  const asClient = (id: string, scopes: string[]) =>
    engine.connect(listenerCaller({ id, kind: 'cli', scopes }, 'http') as never);
  return { engine, store, clock, db: file.open(), call, asClient };
}

const flag = (db: ReturnType<ReturnType<typeof tempDb>['open']>) =>
  db.prepare("SELECT value FROM meta WHERE key = 'workflow_sync'").get() as
    { value: string } | undefined;

test('status reports disabled and unavailable; enable and code answer unavailable', async () => {
  const w = await world();
  try {
    const status = await w.call('Workflow/status', {});
    assert.deepEqual(status, {
      enabled: false,
      available: false,
      message: 'Syncing Done and Later between Macs arrives in a later version.',
    });
    for (const method of ['Workflow/enable', 'Workflow/code'] as const)
      await assert.rejects(
        w.call(method, method === 'Workflow/enable' ? {} : {}),
        (e: { type?: string }) => e.type === 'unavailable',
      );
    assert.equal(flag(w.db), undefined, 'a refused enable writes nothing');
  } finally {
    await w.engine.close();
  }
});

test('disable is the idempotent off: it clears a planted flag and reports disabled', async () => {
  const w = await world();
  try {
    assert.deepEqual(await w.call('Workflow/disable', {}), { enabled: false });
    w.db.prepare("INSERT INTO meta(key, value) VALUES('workflow_sync', '1')").run();
    assert.equal((await w.call('Workflow/status', {})).enabled, true);
    assert.deepEqual(await w.call('Workflow/disable', {}), { enabled: false });
    assert.equal(flag(w.db)!.value, '0');
    assert.equal((await w.call('Workflow/status', {})).enabled, false);
  } finally {
    await w.engine.close();
  }
});

test('a listener reads status but the secret methods stay window-only', async () => {
  const w = await world();
  try {
    const client = w.asClient('c1', ['read', 'admin']);
    const status = (await client.call('Workflow/status', {})) as Output<'Workflow/status'>;
    assert.equal(status.available, false);
    for (const method of ['Workflow/enable', 'Workflow/code']) {
      await assert.rejects(
        client.call(method, {}),
        (e: { type?: string }) => e.type === 'forbidden',
        `${method} is secret and never leaves a window`,
      );
    }
    await client.call('Workflow/disable', {});
  } finally {
    await w.engine.close();
  }
});

test('a listener disable lands an audit row naming the client', async () => {
  const w = await world();
  try {
    w.db.prepare("INSERT INTO meta(key, value) VALUES('workflow_sync', '1')").run();
    await w.asClient('c9', ['read', 'admin']).call('Workflow/disable', {});
    const rows = w.db
      .prepare("SELECT method, client_id FROM audit_log WHERE method = 'Workflow/disable'")
      .all() as { method: string; client_id: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.client_id, 'c9');
  } finally {
    await w.engine.close();
  }
});
