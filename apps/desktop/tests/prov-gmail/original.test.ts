/**
 * prov-gmail `ProviderPort.original` (`Message/original`): the message's raw RFC822 through
 * `messages.get format=raw`, decoded in the adapter, priced as full, interactive lane.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '@aplos/engine/ports';
import { fetchOriginal } from '../../src/host/providers/google/bodies';
import { GMAIL_COSTS } from '../../src/host/providers/google/costs';
import { gmailLog, rig } from './harness';

async function collected(iter: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const chunk of iter) parts.push(chunk);
  return Buffer.concat(parts);
}

test('prov-gmail original: returns the stored raw bytes, one get priced as full on the interactive lane', async () => {
  const r = await rig();
  const raw = Buffer.from(
    'From: a@example.test\r\nTo: b@example.test\r\nSubject: hi\r\nMessage-ID: <m1@example.test>\r\n\r\nbody\r\n',
  );
  const m = r.emu.mailbox.addRaw(raw, { labelIds: ['INBOX'] });
  const since = r.fetches.length;
  const live = new AbortController();
  const bytes = await collected(await r.adapter.original!(m.id, r.ctx(), { signal: live.signal }));
  assert.deepEqual(bytes, raw);
  const calls = r.fetches.slice(since);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].path.endsWith(`/messages/${m.id}`));
  assert.equal(calls[0].query.get('format'), 'raw');
  const gmailCalls = gmailLog(r.emu).filter(e => e.apiMethod === 'gmail.users.messages.get');
  assert.equal(gmailCalls.length, 1);
  assert.equal(gmailCalls[0].units, 60);
  assert.ok(r.governor.sentCalls().every(c => c.lane === 'interactive' && c.kind === 'read'));
  assert.equal(r.governor.sentCalls()[0].cost, 60);
});

test('prov-gmail original: an absent message surfaces as the adapter error, nothing yielded', async () => {
  const r = await rig();
  // A hex-shaped id the emulator does not hold is a real 404; a non-hex id is a 400. Both refuse.
  await assert.rejects(() => r.adapter.original!('deadbeef00', r.ctx()));
});

test('prov-gmail original: the governor pause stops the fetch before any request', async () => {
  const r = await rig();
  r.governor.apply({
    class: 'throttle',
    provider: 'gmail',
    method: 'gmail.messages.get',
    reason: 'rateLimitExceeded',
    retryAfterMs: 60_000,
  });
  const m = r.emu.mailbox.addRaw(Buffer.from('a\r\n\r\nb'), { labelIds: ['INBOX'] });
  const since = r.fetches.length;
  await assert.rejects(() => r.adapter.original!(m.id, r.ctx()));
  assert.equal(r.fetches.slice(since).length, 0);
});

/** A deps-level stub: the JSON `messages.get` reply without touching the emulator. */
function stubDeps(raw: unknown) {
  return {
    fetch: (async () =>
      new Response(JSON.stringify(raw === undefined ? { id: 'm-9' } : { id: 'm-9', raw }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch,
    costs: GMAIL_COSTS,
    userAgent: 'aplos-test',
    closed: new AbortController().signal,
  };
}

test('prov-gmail original: a reply without raw refuses emptyOriginal, not an empty stream', async () => {
  const r = await rig();
  await assert.rejects(
    () => fetchOriginal(stubDeps(undefined), 'm-9', r.ctx()),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.error.class === 'permanent' &&
      error.error.reason === 'emptyOriginal',
  );
});

test('prov-gmail original: a malformed raw refuses malformedOriginal, never garbage bytes', async () => {
  const r = await rig();
  await assert.rejects(
    () => fetchOriginal(stubDeps('not base64url !!!!'), 'm-9', r.ctx()),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.error.class === 'permanent' &&
      error.error.reason === 'malformedOriginal',
  );
});

test('prov-gmail original: the caller signal aborts before any request', async () => {
  const r = await rig();
  const m = r.emu.mailbox.addRaw(Buffer.from('a\r\n\r\nb'), { labelIds: ['INBOX'] });
  const since = r.fetches.length;
  await assert.rejects(() => r.adapter.original!(m.id, r.ctx(), { signal: AbortSignal.abort() }));
  assert.equal(r.fetches.slice(since).length, 0);
});
