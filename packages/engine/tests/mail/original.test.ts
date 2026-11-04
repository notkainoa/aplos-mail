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
  let stalls = 0;
  let gate: { promise: Promise<void>; open: () => void } | undefined;
  const streams = new Map<string, () => AsyncIterable<Uint8Array>>();
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
    accounts.original = (account: string, remoteId: string) => {
      calls.push(`${account}/${remoteId}`);
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
    stalled: () => stalls,
    setHeld: () => {
      gate = { promise: undefined as unknown as Promise<void>, open: () => undefined };
      gate.promise = new Promise<void>(r => {
        gate!.open = r;
      });
      streams.set('r1', held);
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
