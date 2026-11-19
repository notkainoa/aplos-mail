import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '@aplos/contract/contract-error';
import { testEngine } from '../runtime.helpers';
import { accountWrite } from '../store/helpers';

// The window-failure path only logged non-contract throws as `rpc.failed` and sent contract bodies to the frame
// silently — the owner calendar bug stayed invisible because nothing recorded the failing kind or its error type.
test('a window killed by a contract error logs view.window_failed with kind + type', async () => {
  const { lazyViewLoaderForTest, registerViewKind } = await import('../../src/views/registry');
  // `events` is still lazy in this process: the compiler answers the open, then the rerun after an event
  // commit hits the throwing layout — the refresh path `failed()` covers.
  let calls = 0;
  lazyViewLoaderForTest('events', async () => {
    registerViewKind('events', () => ({
      kind: 'events',
      rowType: 'Event',
      layout: () => {
        if (++calls > 1) throw new ContractError({ type: 'unavailable', message: 'gone' });
        return { total: 0, sections: [] };
      },
      rows: () => [],
      locate: () => undefined,
      statements: () => [{ sql: 'SELECT id FROM events LIMIT 1', params: [] }],
    }));
  });
  const t = await testEngine();
  try {
    t.store.commit({ opId: 'a', origin: 'local', writes: [{ ...accountWrite }] });
    const w = t.engine.connect();
    const win = (await w.call('View/watch', {
      spec: { kind: 'events', from: 0, to: 86_400_000 },
    })) as { windowId: string };
    assert.ok(win.windowId);
    t.store.commit({
      opId: 'bump',
      origin: 'sync',
      writes: [
        {
          kind: 'calendar',
          accountId: 'acct-1',
          remoteId: 'primary',
          name: 'Personal',
          hidden: false,
          readOnly: false,
          primary: true,
          selected: true,
        },
      ],
    });
    t.clock.advance(400);
    await new Promise(r => setTimeout(r, 50));
    const record = t.records.find(r => r.event === 'view.window_failed');
    assert.ok(record, 'the failure was logged');
    assert.equal(record.data?.kind, 'events');
    assert.equal(record.data?.type, 'unavailable');
  } finally {
    await t.cleanup();
  }
});
