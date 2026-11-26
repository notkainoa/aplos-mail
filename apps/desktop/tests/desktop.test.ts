import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftOwnership, draftMutationId } from '../src/main/desktop-policy';
import { isTrustedRequest } from '../src/main/server';

test('loopback bridge rejects cross-site origins and DNS rebinding hosts', () => {
  assert.equal(
    isTrustedRequest({ headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:5173' } }),
    true,
  );
  assert.equal(
    isTrustedRequest({ headers: { host: 'localhost:4317', origin: 'http://localhost:5173' } }),
    true,
  );
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:4317' } }), true);
  assert.equal(
    isTrustedRequest({ headers: { host: '127.0.0.1:4317', origin: 'https://malicious.example' } }),
    false,
  );
  assert.equal(isTrustedRequest({ headers: { host: 'malicious.example:4317' } }), false);
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:4317', origin: 'null' } }), false);
});

test('draft send and delete parse IDs without a nested draft object', () => {
  assert.equal(draftMutationId('draft.send', { id: 'draft-1' }), 'draft-1');
  assert.equal(draftMutationId('draft.delete', { id: 'draft-1' }), 'draft-1');
  assert.equal(draftMutationId('draft.save', { draft: { id: 'draft-1' } }), 'draft-1');
  assert.throws(() => draftMutationId('draft.save', { id: 'draft-1' }), /Invalid draft ID/);
});

test('a claimed draft blocks other windows until its owner releases or closes', () => {
  const ownership = new DraftOwnership();
  assert.equal(ownership.claim('draft-1', 20), true);
  assert.equal(ownership.claim('draft-1', 10), false);
  assert.throws(() => ownership.assertEditable('draft-1', 10), /another window/);
  assert.doesNotThrow(() => ownership.assertEditable('draft-1', 20));
  assert.equal(ownership.release('draft-1', 10), false);
  assert.equal(ownership.claim('draft-1', 30), false);
  assert.deepEqual(ownership.releaseWindow(20), ['draft-1']);
  assert.equal(ownership.claim('draft-1', 30), true);
});
