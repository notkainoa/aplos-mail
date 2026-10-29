import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedKnownSubject } from '../../src/host/providers/oauth/known-subject';

test('a lookup that answers false is the only way to say "unknown"', async () => {
  assert.equal(await boundedKnownSubject(() => false)('s1'), false);
  assert.equal(await boundedKnownSubject(async () => false)('s1'), false);
  assert.equal(await boundedKnownSubject(() => true)('s1'), true);
});

test('a lookup that throws, rejects or never answers counts as known', async () => {
  const options = { timeoutMs: 20 };
  assert.equal(
    await boundedKnownSubject(() => {
      throw new Error('boom');
    }, options)('s1'),
    true,
  );
  assert.equal(
    await boundedKnownSubject(() => Promise.reject(new Error('boom')), options)('s1'),
    true,
  );
  const started = Date.now();
  assert.equal(
    await boundedKnownSubject(() => new Promise<boolean>(() => {}), options)('s1'),
    true,
  );
  assert.ok(Date.now() - started < 1_000, 'the wait is bounded');
});

test('a non-boolean answer is not "unknown"', async () => {
  assert.equal(await boundedKnownSubject((() => undefined) as never)('s1'), true);
});
