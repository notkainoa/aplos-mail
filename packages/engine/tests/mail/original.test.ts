import test from 'node:test';
import assert from 'node:assert/strict';
import type { LogRecord } from '@aplos/contract';
import { parseArgs } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import type { BlobFiles, BlobHeader } from '../../src/ports';
import { BlobFilesError } from '../../src/ports';
import { openStore, type StoreWrite } from '../../src/store';
import { ACCOUNT, accountWrite, folderWrites, msg, T0, tempDb } from '../store/helpers';
import { manualClock } from '../runtime.helpers';

/**
 * `Message/original` (Blob package 7): the raw RFC822 through `ProviderPort.original` (optional; absent ->
 * unavailable), capped at 25 MB under a 120 s total / 30 s idle deadline tied to the caller's signal, then stored
 * as an `original` blob (`message/rfc822`, cleaned subject + `.eml`) that `Blob/get` reads back.
 */

const enc = (s: string) => new TextEncoder().encode(s);

function memoryBlobs() {
  const stored = new Map<string, { header: BlobHeader; bytes: Uint8Array }>();
  const files: BlobFiles = {
    async put(id, header, bytes) {
      if (stored.has(id)) throw new BlobFilesError('exists');
      stored.set(id, { header: { ...header }, bytes: bytes.slice() });
    },
    async get(id) {
      const entry = stored.get(id);
      return entry && { header: { ...entry.header }, bytes: entry.bytes.slice() };
    },
    async remove(id) {
      stored.delete(id);
    },
    async list() {
      return [...stored].map(([id, e]) => ({ id, header: { ...e.header }, mtimeMs: T0 }));
    },
    async usage() {
      return [...stored.values()].reduce((n, e) => n + e.bytes.byteLength, 0);
    },
  };
  return { files, stored };
}

async function world(opts: { withOriginal?: boolean } = {}) {
  const file = tempDb();
  const clock = manualClock();
  const records: LogRecord[] = [];
  const log = createLogger({ sink: { write: r => void records.push(r) }, salt: 'orig', clock });
  const store = openStore(file.open(), { now: () => clock.now(), extensions: laneExtensions() });
  const seed: StoreWrite[] = [{ ...accountWrite }, ...folderWrites, msg('r1', 't1', 0)];
  store.commit({ opId: 'seed', origin: 'sync', writes: seed });
  const blobs = memoryBlobs();
  const calls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  let stalls = 0;
  let gate: { promise: Promise<void>; open: () => void } | undefined;
  const streams = new Map<
    string,
    () => AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>>
  >();
  const bytes = (s: string) =>
    async function* () {
      yield enc(s.slice(0, 4));
      yield enc(s.slice(4));
    };
  streams.set('r1', bytes('Return-Path: <a@b>\r\nSubject: hi\r\n\r\nbody'));
  streams.set('big', async function* () {
    yield new Uint8Array(25 * 1024 * 1024);
    yield enc('x');
  });
  const held = async function* () {
    stalls++;
    await gate!.promise;
    yield enc('late');
  };
  const accounts: Record<string, unknown> = {};
  if (opts.withOriginal !== false)
    accounts.original = (account: string, remoteId: string, options?: { signal?: AbortSignal }) => {
      calls.push(`${account}/${remoteId}`);
      signals.push(options?.signal);
      const fn = streams.get(remoteId);
      if (!fn) return Promise.reject(new Error(`no original ${remoteId}`));
      return Promise.resolve(fn());
    };
  const engine = await createEngine({
    store,
    clock,
    log,
    ports: { accounts: accounts as never, blobFiles: blobs.files },
    validate: parseArgs as (m: string, a: unknown) => unknown,
  });
  const session = engine.connect();
  return {
    engine,
    session,
    store,
    clock,
    calls,
    streams,
    signals,
    blobs,
    stalled: () => stalls,
    setHeld: () => {
      gate = { promise: undefined as unknown as Promise<void>, open: () => undefined };
      gate.promise = new Promise<void>(r => {
        gate!.open = r;
      });
      streams.set('r1', held);
    },
    hold: (remoteId: string) => {
      let open: () => void = () => undefined;
      const promise = new Promise<void>(r => {
        open = r;
      });
      streams.set(remoteId, async function* () {
        stalls++;
        await promise;
        yield enc('late');
      });
      return { promise, open };
    },
    close: () => engine.close(),
  };
}

const orig = (w: Awaited<ReturnType<typeof world>>, remoteId = 'r1') =>
  w.session.call('Message/original', { messageId: `${ACCOUNT}:${remoteId}` }) as Promise<{
    blobId: string;
    name: string;
    size: number;
  }>;

test('fetch: streams the RFC822 into an original blob the caller owns and Blob/get reads back', async () => {
  const w = await world();
  const got = await orig(w);
  assert.deepEqual(w.calls, [`${ACCOUNT}/r1`]);
  assert.match(got.blobId, /^b_[0-9a-f]{32}$/);
  assert.equal(got.name, 'Subject t1.eml', 'the cleaned stored subject plus .eml');
  assert.ok(got.size > 0);
  const blob = (await w.session.call('Blob/get', { blobId: got.blobId })) as {
    bytes: Uint8Array;
    mime: string;
    name?: string;
  };
  assert.equal(
    new TextDecoder().decode(blob.bytes),
    'Return-Path: <a@b>\r\nSubject: hi\r\n\r\nbody',
  );
  assert.equal(blob.mime, 'message/rfc822');
  assert.equal(blob.name, got.name);
  await w.close();
});

test('a message not in the store is notFound without touching the provider', async () => {
  const w = await world();
  const error = await w.session.call('Message/original', { messageId: `${ACCOUNT}:nope` }).then(
    () => assert.fail('expected notFound'),
    (e: unknown) => e,
  );
  assert.ok(error instanceof ContractError);
  assert.equal(error.type, 'notFound');
  assert.equal(w.calls.length, 0);
  await w.close();
});

test('over 25 MB: tooLarge and nothing is stored', async () => {
  const w = await world();
  w.store.commit({
    opId: 'big',
    origin: 'sync',
    writes: [msg('big', 't9', 1)],
  });
  const error = await orig(w, 'big').then(
    () => assert.fail('expected tooLarge'),
    (e: unknown) => e,
  );
  assert.ok(error instanceof ContractError);
  assert.equal(error.type, 'tooLarge');
  assert.match(error.message, /too large/i);
  await w.close();
});

test('a stalled fetch dies on the deadline, not on the caller', async () => {
  const w = await world();
  w.setHeld();
  const pending = orig(w).then(
    () => assert.fail('expected cancellation'),
    (e: unknown) => e,
  );
  // Dispatch is asynchronous: wait until the fetch is actually suspended inside the stream — the
  // idle deadline is armed by then — before the clock moves.
  for (let i = 0; i < 100 && w.stalled() === 0; i++) await new Promise(r => setImmediate(r));
  assert.equal(w.stalled(), 1, 'the fetch stalled inside the stream');
  w.clock.advance(31_000);
  const error = await pending;
  assert.ok(error instanceof ContractError);
  assert.equal(error.type, 'unavailable');
  await w.close();
});

test('exactly 25 MB streams through; a missing subject falls back to message.eml', async () => {
  const w = await world();
  w.store.commit({
    opId: 'edge',
    origin: 'sync',
    writes: [msg('exact', 'tx', 1), msg('nosubj', 'tn', 2, { subject: '' })],
  });
  w.streams.set('exact', async function* () {
    yield new Uint8Array(25 * 1024 * 1024);
  });
  w.streams.set('nosubj', async function* () {
    yield enc('Subject: none');
  });
  const got = await orig(w, 'exact');
  assert.equal(got.size, 25 * 1024 * 1024);
  const named = await orig(w, 'nosubj');
  assert.equal(named.name, 'message.eml');
  await w.close();
});

test('an open call that never settles dies on the total deadline', async () => {
  const w = await world();
  w.store.commit({ opId: 'never', origin: 'sync', writes: [msg('never', 'tv', 4)] });
  w.streams.set('never', () => new Promise<AsyncIterable<Uint8Array>>(() => undefined));
  const pending = orig(w, 'never').then(
    () => assert.fail('expected cancellation'),
    (e: unknown) => e,
  );
  for (let i = 0; i < 100 && w.calls.length === 0; i++) await new Promise(r => setImmediate(r));
  assert.equal(w.calls.length, 1, 'the provider call never settled');
  w.clock.advance(120_000);
  const error = await pending;
  assert.ok(error instanceof ContractError);
  assert.equal(error.type, 'unavailable');
  await w.close();
});

test('a 255-code-point subject still fits line(500) and keeps .eml stored and returned', async () => {
  const w = await world();
  w.store.commit({
    opId: 'longname',
    origin: 'sync',
    writes: [msg('emoji', 'te', 5, { subject: '😀'.repeat(255) })],
  });
  w.streams.set('emoji', async function* () {
    yield enc('x');
  });
  const got = await orig(w, 'emoji');
  assert.ok(got.name.length <= 500, `contract bound, got ${got.name.length} units`);
  assert.ok(got.name.endsWith('.eml'));
  const stored = w.blobs.stored.get(got.blobId)!;
  assert.equal(stored.header.name, got.name, 'stored name is the returned name');
  assert.equal(stored.header.kind, 'original');
  await w.close();
});

test('a non-Uint8Array chunk is unavailable, not stored', async () => {
  const w = await world();
  w.store.commit({ opId: 'weird', origin: 'sync', writes: [msg('weird', 'tw', 3)] });
  w.streams.set('weird', async function* () {
    yield 'not bytes' as unknown as Uint8Array;
  });
  const error = await orig(w, 'weird').then(
    () => assert.fail('expected unavailable'),
    (e: unknown) => e,
  );
  assert.ok(error instanceof ContractError);
  assert.equal(error.type, 'unavailable');
  await w.close();
});

test('without the provider-original port the method answers unavailable', async () => {
  const w = await world({ withOriginal: false });
  const error = await orig(w).then(
    () => assert.fail('expected unavailable'),
    (e: unknown) => e,
  );
  assert.ok(error instanceof ContractError);
  assert.equal(error.type, 'unavailable');
  await w.close();
});

test('two concurrent gets for one message share one provider fetch and one blob', async () => {
  const w = await world();
  const gate = w.hold('r1');
  const a = orig(w);
  const b = orig(w);
  for (let i = 0; i < 100 && w.calls.length === 0; i++) await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  gate.open();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(w.calls.length, 1, 'one provider read for two callers');
  assert.equal(ra.blobId, rb.blobId);
  await w.close();
});

test('a repeat get opens the live blob again: no second fetch, same id', async () => {
  const w = await world();
  const first = await orig(w);
  const second = await orig(w);
  assert.equal(w.calls.length, 1, 'the repeat read the live blob');
  assert.equal(second.blobId, first.blobId);
  const bytes = (await w.session.call('Blob/get', { blobId: second.blobId })) as {
    bytes: Uint8Array;
  };
  assert.ok(bytes.bytes.byteLength > 0, 'the reused blob still reads');
  await w.close();
});

test('a fourth concurrent fetch on the account is refused busy, retryable, without a provider read', async () => {
  const w = await world();
  const gates: { open: () => void }[] = [];
  const pending: Promise<{ blobId: string; name: string; size: number }>[] = [];
  for (const [i, remoteId] of ['r1', 'r2', 'r3'].entries()) {
    if (i)
      w.store.commit({
        opId: `seed-${remoteId}`,
        origin: 'sync',
        writes: [msg(remoteId, `t${i}`, i)],
      });
    gates.push(w.hold(remoteId));
    pending.push(orig(w, remoteId));
  }
  w.store.commit({ opId: 'seed-r4', origin: 'sync', writes: [msg('r4', 't4', 4)] });
  w.streams.set('r4', async function* () {
    yield enc('r4');
  });
  for (let i = 0; i < 100 && w.stalled() < 3; i++) await new Promise(r => setImmediate(r));
  assert.equal(w.stalled(), 3, 'three fetches in flight');
  const error = await orig(w, 'r4').then(
    () => assert.fail('expected busy'),
    (e: unknown) => e,
  );
  assert.ok(error instanceof ContractError);
  assert.equal(error.type, 'unavailable');
  assert.ok((error as { body?: { retryAfterMs?: number } }).body?.retryAfterMs !== undefined);
  assert.equal(w.calls.length, 3, 'the refused call never reached the provider');
  for (const g of gates) g.open();
  await Promise.all(pending);
  await w.close();
});

test('a caller already at quota is refused before the provider read', async () => {
  const w = await world();
  const listener = w.engine.connect({
    kind: 'listener',
    via: 'mcp',
    clientId: 'mcp-1',
    scopes: ['read', 'draft'],
  });
  for (let i = 0; i < 4; i++)
    await listener.call('Blob/put', {
      bytes: new Uint8Array(25 * 1024 * 1024),
      mime: 'application/octet-stream',
      name: `f${i}.bin`,
    });
  const error = await listener.call('Message/original', { messageId: `${ACCOUNT}:r1` }).then(
    () => assert.fail('expected quota'),
    (e: unknown) => e,
  );
  assert.ok(error instanceof ContractError);
  assert.equal(error.type, 'tooLarge');
  assert.equal(w.calls.length, 0, 'the quota refusal wasted no provider read');
  await w.close();
});

test('an empty original is unavailable and stores nothing', async () => {
  const w = await world();
  w.store.commit({ opId: 'empty-m', origin: 'sync', writes: [msg('empty', 'te', 2)] });
  w.streams.set('empty', async function* () {
    yield undefined as unknown as Uint8Array;
  });
  const error = await orig(w, 'empty').then(
    () => assert.fail('expected unavailable'),
    (e: unknown) => e,
  );
  assert.ok(error instanceof ContractError);
  assert.equal(error.type, 'unavailable');
  await w.close();
});

test("the deadline aborts the port's signal so the HTTP read stops", async () => {
  const w = await world();
  w.setHeld();
  const pending = orig(w).then(
    () => assert.fail('expected unavailable'),
    (e: unknown) => e,
  );
  await new Promise(r => setImmediate(r));
  assert.equal(w.signals.length, 1);
  assert.equal(w.signals[0]!.aborted, false);
  w.clock.advance(120_000);
  const error = await pending;
  assert.ok(error instanceof ContractError);
  assert.equal(w.signals[0]!.aborted, true, 'the deadline reached the adapter read');
  await w.close();
});

test('a provider `unavailable` answers the not-running sentence', async () => {
  const w = await world();
  w.store.commit({ opId: 'dead-m', origin: 'sync', writes: [msg('dead', 'te', 2)] });
  w.streams.set('dead', () => {
    throw new ContractError({ type: 'unavailable', message: 'adapter offline' });
  });
  const error = await orig(w, 'dead').then(
    () => assert.fail('expected unavailable'),
    (e: unknown) => e,
  );
  assert.ok(error instanceof ContractError);
  assert.equal(error.type, 'unavailable');
  assert.equal(error.message, 'This part of Aplos is not running yet.');
  await w.close();
});

test('a dot-file subject never names a hidden export; ../ paths collapse to the plain name', async () => {
  const w = await world();
  w.store.commit({
    opId: 'dot-m',
    origin: 'sync',
    writes: [msg('hidden', 'td', 2, { subject: '.hidden' })],
  });
  w.streams.set('hidden', async function* () {
    yield enc('x');
  });
  const got = await orig(w, 'hidden');
  assert.equal(got.name, 'hidden.eml');
  w.store.commit({
    opId: 'dot2',
    origin: 'sync',
    writes: [msg('esc', 'te2', 3, { subject: '../../x' })],
  });
  w.streams.set('esc', async function* () {
    yield enc('y');
  });
  const escaped = await orig(w, 'esc');
  assert.equal(escaped.name, 'x.eml');
  await w.close();
});

test('a provider stream that throws mid-read maps to unavailable, not internal', async () => {
  const w = await world();
  w.store.commit({ opId: 'boom-m', origin: 'sync', writes: [msg('boom', 'tb', 2)] });
  w.streams.set('boom', async function* () {
    yield enc('part');
    throw new Error('provider exploded with a fake token secret-123');
  });
  const error = await orig(w, 'boom').then(
    () => assert.fail('expected unavailable'),
    (e: unknown) => e,
  );
  assert.ok(error instanceof ContractError);
  assert.equal(error.type, 'unavailable');
  assert.ok(!error.message.includes('secret-123'), 'provider text never leaks');
  await w.close();
});

test("a listener's original blob is notFound to a window session", async () => {
  const w = await world();
  const listener = w.engine.connect({
    kind: 'listener',
    via: 'mcp',
    clientId: 'mcp-2',
    scopes: ['read'],
  });
  const got = (await listener.call('Message/original', {
    messageId: `${ACCOUNT}:r1`,
  })) as { blobId: string };
  const error = await w.session.call('Blob/get', { blobId: got.blobId }).then(
    () => assert.fail('expected notFound'),
    (e: unknown) => e,
  );
  assert.ok(error instanceof ContractError);
  assert.equal(error.type, 'notFound');
  await w.close();
});

test('an endless small-chunk stream stops at the cap', async () => {
  const w = await world();
  w.store.commit({ opId: 'endless-m', origin: 'sync', writes: [msg('endless', 'tn', 2)] });
  w.streams.set('endless', async function* () {
    for (;;) yield new Uint8Array(64 * 1024);
  });
  const error = await orig(w, 'endless').then(
    () => assert.fail('expected tooLarge'),
    (e: unknown) => e,
  );
  assert.ok(error instanceof ContractError);
  assert.equal(error.type, 'tooLarge');
  await w.close();
});
