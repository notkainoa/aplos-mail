/**
 * prov-gmail search rate-limit path (eng-views REQUEST): an interactive-lane refusal surfaces the classified
 * ProviderError intact, the wire cost of one search() is the list plus the metadata batch's real calls, and a
 * paused governor refuses the next interactive search before any request.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PausedError, ProviderError } from '@aplos/engine/ports';
import { rig } from './harness';
import { createFaultInjector } from '@aplos/emulators';

test('prov-gmail search: a 429 on the list surfaces the classified ProviderError intact', async () => {
  const faults = createFaultInjector();
  const r = await rig({ threads: 60, emulator: { faults } });
  faults.failNext(
    { apiMethod: 'gmail.users.messages.list' },
    { status: 429, reason: 'rateLimitExceeded', retryAfterSeconds: 120 },
  );
  await assert.rejects(
    () => r.adapter.search!({ text: 'synthetic', limit: 25 }, r.ctx()),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.error.class === 'throttle' &&
      error.error.reason === 'rateLimitExceeded' &&
      error.error.method === 'gmail.messages.list' &&
      error.scope === 'account' &&
      error.error.retryAfterMs === 120_000,
  );
  assert.ok(r.governor.pausedUntil > r.clock.now(), 'the throttle paused the account');
});

test('prov-gmail search: the throttle window refuses the next interactive search with zero requests', async () => {
  const r = await rig({ threads: 60 });
  r.governor.apply({
    class: 'throttle',
    provider: 'gmail',
    method: 'gmail.messages.list',
    reason: 'rateLimitExceeded',
    retryAfterMs: 120_000,
  });
  const before = r.fetches.length;
  await assert.rejects(
    () => r.adapter.search!({ text: 'synthetic', limit: 25 }, r.ctx()),
    (error: unknown) => error instanceof PausedError && error.cls === 'throttle',
  );
  assert.equal(r.fetches.length, before, 'no Gmail call inside the throttle window');
});

test('prov-gmail search: one search() is the list plus one metadata batch on the wire', async () => {
  const r = await rig({ threads: 12 });
  for (let i = 0; i < 6; i++)
    r.emu.mailbox.addMessage({
      from: 'Ada Quill <ada.quill@mail.example.test>',
      subject: `Searchable note ${i}`,
      text: 'hit',
      labelIds: ['INBOX'],
      internalDate: r.clock.now() - i * 60_000,
    });
  const since = r.fetches.length;
  const result = await r.adapter.search!({ text: 'subject:searchable', limit: 25 }, r.ctx());
  assert.equal(
    result.remoteThreadIds.length,
    6,
    'newest-per-thread dedupe keeps six distinct threads',
  );
  const calls = r.fetches.slice(since);
  const lists = calls.filter(f => f.path.endsWith('/messages'));
  const batches = calls.filter(f => f.path.startsWith('/batch'));
  assert.equal(lists.length, 1, 'one messages.list');
  assert.equal(batches.length, 1, 'one batch for <=batchSize newest-per-thread ids');
  assert.equal(calls.length, 2);
});

test('prov-gmail search: a concurrent-limit refusal surfaces concurrency:true intact', async () => {
  const faults = createFaultInjector();
  const r = await rig({ threads: 60, emulator: { faults } });
  faults.failNext(
    { apiMethod: 'gmail.users.messages.list' },
    {
      status: 429,
      reason: 'rateLimitExceeded',
      message: 'Too many concurrent requests for user',
      retryAfterSeconds: 30,
    },
  );
  await assert.rejects(
    () => r.adapter.search!({ text: 'subject:synthetic', limit: 25 }, r.ctx()),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.error.class === 'throttle' &&
      error.error.concurrency === true,
  );
});

test('fix-search prov-gmail search: no words is no Gmail call and no hits (never a list of recent mail)', async () => {
  const r = await rig({ threads: 12 });
  const before = r.fetches.length;
  for (const text of ['', '   '])
    assert.deepEqual(await r.adapter.search!({ text, limit: 25 }, r.ctx()), {
      upserts: [],
      remoteThreadIds: [],
      costUnits: 0,
    });
  assert.equal(r.fetches.length, before, 'nothing went to Gmail');
});
