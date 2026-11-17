import assert from 'node:assert/strict';
import test from 'node:test';
import type { StorePort } from '../../src/ports';
import { storedUndoSeconds } from '../../src/outbox/module';

/** A store whose settings row holds `data` (or no row at all). */
function storeWith(data: string | undefined): StorePort {
  const store = {
    read: <T>(fn: (q: { get: () => unknown }) => T): T =>
      fn({ get: () => (data === undefined ? undefined : { data }) }),
  };
  return store as unknown as StorePort;
}

test('the countdown uses the Undo send setting, and the setting default (8) when none was saved', () => {
  assert.equal(storedUndoSeconds(storeWith(JSON.stringify({ mail: { undoSendSeconds: 20 } }))), 20);
  assert.equal(storedUndoSeconds(storeWith(JSON.stringify({ mail: { undoSendSeconds: 0 } }))), 0);
  assert.equal(storedUndoSeconds(storeWith(undefined)), 8, 'Settings → Mail shows 8 seconds');
  assert.equal(storedUndoSeconds(storeWith('not json')), 8);
});
