import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { StorePort } from '@aplos/engine/store';
import { createClientTokens, verify } from '../../src/host/transports/auth';

/**
 * The host side of `Clients/grant` (host-5): token files land 0600 in a 0700 dir, a re-issue never
 * overwrites, remove is idempotent, and `verify` answers a client's identity only for a live row's token —
 * the per-request `revoked_at IS NULL` read lives in its SQL.
 */

const dir = () => mkdtempSync(join(tmpdir(), 'aplos-tokens-'));

test('issue writes a 0600 token file in a 0700 dir, never overwrites, remove is idempotent', async () => {
  const dataDir = dir();
  const tokens = createClientTokens({ dataDir });
  const token = 'a'.repeat(64);
  const { path } = await tokens.issue('cl_01', token);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(dataDir, 'run', 'clients')).mode & 0o777, 0o700);
  await assert.rejects(
    tokens.issue('cl_01', token),
    /EEXIST|exists/,
    're-issue must fail, not swap',
  );
  await tokens.remove('cl_01');
  assert.equal(readdirSync(join(dataDir, 'run', 'clients')).length, 0);
  await tokens.remove('cl_01'); // missing is fine
});

const hash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

const fakeStore = (rows: unknown[]): StorePort =>
  ({ read: (fn: (q: { all: () => unknown[] }) => unknown) => fn({ all: () => rows }) }) as never;

test('verify answers the client for a live row whose hash matches, and nothing else', () => {
  const token = 'b'.repeat(64);
  const live = { id: 'cl_9', kind: 'cli', token_hash: hash(token), scopes: '["read"]' };
  assert.deepEqual(verify(fakeStore([live]), token), {
    clientId: 'cl_9',
    kind: 'cli',
    scopes: ['read'],
  });
  assert.equal(verify(fakeStore([live]), 'c'.repeat(64)), undefined, 'wrong token');
  assert.equal(verify(fakeStore([]), token), undefined, 'no live row');
  assert.equal(verify(fakeStore([live]), token.toUpperCase()), undefined, 'shape gate');
});
