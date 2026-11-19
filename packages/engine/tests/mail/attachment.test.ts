import test from 'node:test';
import assert from 'node:assert/strict';
import type { LogRecord } from '@aplos/contract';
import { parseArgs } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import type { AttachmentFiles } from '../../src/store/port';
import type { BlobFiles, BlobHeader } from '../../src/ports';
import { BlobFilesError } from '../../src/ports';
import { openStore, type StoreWrite } from '../../src/store';
import { ACCOUNT, accountWrite, folderWrites, msg, T0, tempDb } from '../store/helpers';
import { manualClock } from '../runtime.helpers';

/**
 * `Attachment/get` (Blob package 6): a stored attachment's bytes fetched through the provider into the
 * `attachments/.noindex/` cache, committed `present`, and handed out as an `attachment` blob handle that
 * `Blob/get` reads through the cache — never a second copy. One fetch per part, at most three per account,
 * a 25 MB cap, and `ctx.signal` cancels it.
 */

const enc = (s: string) => new TextEncoder().encode(s);

/** In-memory `BlobFiles` with the host's contract, enough for the runtime to start. */
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
      return [...stored].map(([id, entry]) => ({ id, header: { ...entry.header }, mtimeMs: T0 }));
    },
    async usage() {
      return [...stored.values()].reduce((n, e) => n + e.bytes.byteLength, 0);
    },
  };
  return { files, stored };
}

/** In-memory `AttachmentFiles`: paths are `part-<n>`, bytes kept behind them. */
function memoryParts() {
  const files = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const port: AttachmentFiles = {
    async write(accountId, remoteId, remotePart, data) {
      calls.push(`write ${remoteId}/${remotePart}`);
      // Deterministic: a refetch of the same part lands on the same path, like the real port.
      const path = `part-${remotePart}`;
      files.set(path, data.slice());
      return path;
    },
    async read(path) {
      calls.push(`read ${path}`);
      const found = files.get(path);
      return found?.slice();
    },
    async remove(path) {
      files.delete(path);
    },
    async usage() {
      return [...files.values()].reduce((s, b) => s + b.byteLength, 0);
    },
  };
  return { port, files, calls };
}

interface FakeAccount {
  attachment(
    account: string,
    ref: { remoteMessageId: string; part: string },
  ): Promise<AsyncIterable<Uint8Array>>;
}

async function world(opts: { attachmentFiles?: AttachmentFiles } = {}) {
  const file = tempDb();
  const db = file.open();
  const clock = manualClock();
  const records: LogRecord[] = [];
  const log = createLogger({ sink: { write: r => void records.push(r) }, salt: 'att', clock });
  const store = openStore(db, { now: () => clock.now(), extensions: laneExtensions() });
  const seed: StoreWrite[] = [
    { ...accountWrite },
    ...folderWrites,
    msg('r1', 't1', 0),
    {
      kind: 'attachments',
      accountId: ACCOUNT,
      remoteId: 'r1',
      list: [
        { remotePart: 'p1', name: 'notes.txt', mime: 'text/plain', size: 11, inline: false },
        { remotePart: 'p2', name: 'big.bin', mime: 'application/octet-stream', inline: false },
        { remotePart: 'p3', name: 'odd.bin', mime: 'odd', inline: false },
        { remotePart: 'p4', name: 'big.bin', mime: 'application/octet-stream', inline: false },
      ],
    },
  ];
  store.commit({ opId: 'seed', origin: 'sync', writes: seed });
  const blobs = memoryBlobs();
  const parts =
    opts.attachmentFiles === undefined
      ? memoryParts()
      : { port: opts.attachmentFiles, files: new Map<string, Uint8Array>(), calls: [] as string[] };
  const calls: string[] = [];
  let stalls = 0;
  const gate = {
    promise: undefined as Promise<void> | undefined,
    open: undefined as (() => void) | undefined,
  };
  const account: FakeAccount = {
    attachment(account, ref) {
      calls.push(`${account}/${ref.remoteMessageId}/${ref.part}`);
      const chunks = streams.get(ref.part);
      if (!chunks) return Promise.reject(new Error(`no part ${ref.part}`));
      return Promise.resolve(chunks());
    },
  };
  const streams = new Map<string, () => AsyncIterable<Uint8Array>>();
  const bytes = (s: string) =>
    async function* () {
      yield enc(s);
    };
  const held = async function* () {
    stalls++;
    await gate.promise;
    yield enc('late');
  };
  streams.set('p1', bytes('hello world'));
  streams.set('p3', async function* () {
    yield new Uint8Array(25 * 1024 * 1024);
    yield enc('more');
  });
  streams.set('p4', async function* () {
    yield new Uint8Array(25 * 1024 * 1024);
  });
  const engine = await createEngine({
    store,
    clock,
    log,
    ports: {
      accounts: account as never,
      blobFiles: blobs.files,
      attachmentFiles: parts.port,
    },
    validate: parseArgs as (m: string, a: unknown) => unknown,
  });
  const session = engine.connect();
  const listener = (clientId = 'c-1') =>
    engine.connect({ kind: 'listener', via: 'mcp', clientId, scopes: ['read', 'draft'] });
  const row = (remotePart: string) =>
    store.read(q =>
      q.get<{ state: string; path: string | null }>(
        'SELECT state, path FROM attachments WHERE remote_part = ?',
        remotePart,
      ),
    );
  return {
    engine,
    session,
    store,
    clock,
    calls,
    row,
    streams,
    gate,
    partFiles: parts.files,
    partCalls: parts.calls,
    file,
    blobs,
    listener,
    stalled: () => stalls,
    setHeld: () => {
      gate.promise = new Promise<void>(r => {
        gate.open = r;
      });
      streams.set('p2', held);
    },
    close: () => engine.close(),
  };
}

type AttachOut = { blobId: string; name: string; mime: string; size: number };

const get = (w: Awaited<ReturnType<typeof world>>, attachmentId: string) =>
  w.session.call('Attachment/get', {
    messageId: `${ACCOUNT}:r1`,
    attachmentId,
  }) as Promise<AttachOut>;

const blobGet = (w: Awaited<ReturnType<typeof world>>, blobId: string) =>
  w.session.call('Blob/get', { blobId }) as Promise<{ bytes: Uint8Array }>;

test('fetch: streams the part, caches it, commits present, and the handle reads through the cache', async () => {
  const w = await world();
  const got = await get(w, 'p1');
  assert.deepEqual(w.calls, [`${ACCOUNT}/r1/p1`]);
  const row = w.row('p1')!;
  assert.equal(row.state, 'present');
  assert.ok(row.path, 'a path was committed');
  const file = w.partFiles.get(row.path!);
  assert.equal(new TextDecoder().decode(file), 'hello world');
  const blob = await blobGet(w, got.blobId);
  assert.equal(new TextDecoder().decode(blob.bytes), 'hello world');
  assert.equal(got.name, 'notes.txt');
  assert.equal(got.mime, 'text/plain');
  assert.equal(got.size, 11);
  await w.close();
});

test('cache hit: a present row answers without a provider call', async () => {
  const w = await world();
  const first = await get(w, 'p1');
  assert.equal(w.calls.length, 1, 'the first get fetched');
  const second = await get(w, 'p1');
  assert.equal(w.calls.length, 1, 'the second get read the cache');
  assert.equal(first.blobId, second.blobId, 'same principal + path reuses the live handle');
  await w.close();
});

test('dedupe: two concurrent gets share one provider fetch but get their own handles', async () => {
  const w = await world();
  w.setHeld();
  const pending = Promise.all([get(w, 'p2'), get(w, 'p2')]);
  w.gate.open!();
  const [a, b] = await pending;
  assert.deepEqual(w.calls, [`${ACCOUNT}/r1/p2`], 'one fetch for two callers');
  assert.equal(a.blobId, b.blobId, 'same principal + path reuses the live handle');
  const [ra, rb] = await Promise.all([blobGet(w, a.blobId), blobGet(w, b.blobId)]);
  assert.equal(new TextDecoder().decode(ra.bytes), 'late');
  assert.equal(new TextDecoder().decode(rb.bytes), 'late');
  await w.close();
});

test('over 25 MB: tooLarge, and the row is not left fetching', async () => {
  const w = await world();
  const error = await get(w, 'p3').then(
    () => assert.fail('expected tooLarge'),
    (e: unknown) => e,
  );
  assert.ok(error instanceof ContractError);
  assert.equal(error.type, 'tooLarge');
  assert.match(error.message, /too large/i);
  assert.equal(w.row('p3')!.state, 'absent', 'the fetching marker is reverted');
  await w.close();
});

test('a stalled read times out on the total deadline and reverts to absent', async () => {
  const w = await world();
  w.setHeld();
  const pending = get(w, 'p2').then(
    () => assert.fail('expected cancellation'),
    (e: unknown) => e,
  );
  // The call dispatches asynchronously: wait until the fetch is actually stalled — the provider was
  // called AND the read's deadline timers are registered — before the clock moves.
  for (let i = 0; i < 100 && (w.calls.length === 0 || w.clock.pending() === 0); i++)
    await new Promise(r => setImmediate(r));
  for (let i = 0; i < 100 && w.stalled() === 0; i++) await new Promise(r => setImmediate(r));
  assert.equal(w.stalled(), 1, 'the fetch stalled mid-stream');
  w.clock.advance(120_000);
  const error = await pending;
  assert.ok(error instanceof ContractError);
  assert.equal(error.type, 'unavailable');
  assert.equal(w.row('p2')!.state, 'absent');
  await w.close();
});

test('without the attachment-files port, Attachment/get is unavailable', async () => {
  const file = tempDb();
  const clock = manualClock();
  const log = createLogger({ sink: { write: () => undefined }, salt: 's', clock });
  const store = openStore(file.open(), { now: () => clock.now(), extensions: laneExtensions() });
  store.commit({
    opId: 'seed',
    origin: 'sync',
    writes: [
      { ...accountWrite },
      ...folderWrites,
      msg('r1', 't1', 0),
      {
        kind: 'attachments',
        accountId: ACCOUNT,
        remoteId: 'r1',
        list: [{ remotePart: 'p1', name: 'n', mime: 'text/plain', inline: false }],
      },
    ],
  });
  const engine = await createEngine({
    store,
    clock,
    log,
    ports: { blobFiles: memoryBlobs().files },
    validate: parseArgs as (m: string, a: unknown) => unknown,
  });
  const error = await engine
    .connect()
    .call('Attachment/get', { messageId: `${ACCOUNT}:r1`, attachmentId: 'p1' })
    .then(
      () => assert.fail('expected unavailable'),
      (e: unknown) => e,
    );
  assert.ok(error instanceof ContractError);
  assert.equal(error.type, 'unavailable');
  await engine.close();
});

test('a refetch after an absent revert writes present again (opIds never replay a transition)', async () => {
  const w = await world();
  await get(w, 'p1');
  assert.equal(w.row('p1')!.state, 'present');
  // The file is lost behind the app's back and the provider stops answering: the fetch fails and the
  // row is reverted to absent. With replayed opIds every commit after the first would be a no-op.
  w.partFiles.delete('part-p1');
  w.streams.set('p1', () => {
    throw new Error('provider lost it');
  });
  await get(w, 'p1').catch(() => undefined);
  assert.equal(w.row('p1')!.state, 'absent');
  // The provider recovers: the re-fetch must commit present again — on the same cache path.
  w.streams.set('p1', async function* () {
    yield enc('hello again');
  });
  await get(w, 'p1');
  const row = w.row('p1')!;
  assert.equal(row.state, 'present');
  assert.equal(row.path, 'part-p1');
  const blob = await blobGet(w, (await get(w, 'p1')).blobId);
  assert.equal(new TextDecoder().decode(blob.bytes), 'hello again');
  await w.close();
});

test('a joined caller survives the starter going away: the shared fetch is not theirs to kill', async () => {
  const w = await world();
  w.setHeld();
  const starter = get(w, 'p2').then(
    () => assert.fail('the starter expected cancellation'),
    (e: unknown) => e,
  );
  const second = w.listener();
  const joined = second.call('Attachment/get', {
    messageId: `${ACCOUNT}:r1`,
    attachmentId: 'p2',
  }) as Promise<AttachOut>;
  for (let i = 0; i < 100 && w.stalled() === 0; i++) await new Promise(r => setImmediate(r));
  assert.equal(w.stalled(), 1, 'one shared fetch is stalled');
  w.session.close();
  const starterError = await starter;
  assert.ok(starterError instanceof ContractError);
  assert.equal(starterError.type, 'unavailable');
  w.gate.open!();
  const got = await joined;
  const blob = (await second.call('Blob/get', { blobId: got.blobId })) as {
    bytes: Uint8Array;
  };
  assert.equal(new TextDecoder().decode(blob.bytes), 'late');
  assert.equal(w.row('p2')!.state, 'present', 'the joined caller still lands a present row');
  await w.close();
});

test('attachment handles own no upload bytes: several big opens never spend the client quota', async () => {
  const w = await world();
  const client = w.listener('quota-client');
  for (let i = 0; i < 5; i++)
    await client.call('Attachment/get', {
      messageId: `${ACCOUNT}:r1`,
      attachmentId: 'p4',
    });
  // 5 x 25 MB would exceed a client's 100 MB blob budget if handles counted; they must not.
  const put = await client.call('Blob/put', { bytes: enc('x'), mime: 'text/plain' });
  assert.ok((put as { blobId: string }).blobId.startsWith('b_'));
  await w.close();
});

test('a fetching row left at quit is reset at start and the attachment opens again', async () => {
  const w = await world();
  w.store.commit({
    opId: 'seed-fetching',
    origin: 'local',
    writes: [
      {
        kind: 'attachmentState',
        accountId: ACCOUNT,
        remoteId: 'r1',
        remotePart: 'p1',
        state: 'fetching',
      },
    ],
  });
  assert.equal(w.row('p1')!.state, 'fetching');
  await w.close();
  // A new engine on the same store: the lane's start resets the stale row.
  const file = w.file;
  const clock = manualClock();
  const log = createLogger({ sink: { write: () => undefined }, salt: 're', clock });
  const store = openStore(file.open(), { now: () => clock.now(), extensions: laneExtensions() });
  const blobs = memoryBlobs();
  const parts = memoryParts();
  const engine = await createEngine({
    store,
    clock,
    log,
    ports: {
      accounts: {
        attachment: () =>
          Promise.resolve(
            (async function* () {
              yield enc('hello again');
            })(),
          ),
      } as never,
      blobFiles: blobs.files,
      attachmentFiles: parts.port,
    },
    validate: parseArgs as (m: string, a: unknown) => unknown,
  });
  const row = store.read(q =>
    q.get<{ state: string }>('SELECT state FROM attachments WHERE remote_part = ?', 'p1'),
  );
  assert.equal(row!.state, 'absent', 'the stale fetch was reset at start');
  const got = (await engine.connect().call('Attachment/get', {
    messageId: `${ACCOUNT}:r1`,
    attachmentId: 'p1',
  })) as { blobId: string };
  assert.ok(got.blobId.startsWith('b_'), 'the attachment opens again');
  await engine.close();
});

test('an infinite small-chunk stream stops at the cap and reverts to absent', async () => {
  const w = await world();
  w.streams.set('p3', async function* () {
    for (;;) yield new Uint8Array(64 * 1024);
  });
  const error = await get(w, 'p3').then(
    () => assert.fail('expected tooLarge'),
    (e: unknown) => e,
  );
  assert.ok(error instanceof ContractError);
  assert.equal(error.type, 'tooLarge');
  assert.equal(w.row('p3')!.state, 'absent');
  await w.close();
});

test('the row deleted mid-fetch answers notFound and removes the written file', async () => {
  const w = await world();
  w.setHeld();
  const pending = get(w, 'p2').then(
    () => assert.fail('expected notFound'),
    (e: unknown) => e,
  );
  for (let i = 0; i < 100 && w.stalled() === 0; i++) await new Promise(r => setImmediate(r));
  assert.equal(w.stalled(), 1, 'the fetch is mid-stream');
  w.store.commit({
    opId: 'gone',
    origin: 'sync',
    writes: [{ kind: 'attachments', accountId: ACCOUNT, remoteId: 'r1', list: [] }],
  });
  w.gate.open!();
  const error = await pending;
  assert.ok(error instanceof ContractError);
  assert.equal(error.type, 'notFound');
  assert.equal(w.partFiles.size, 0, 'the written file was removed, not orphaned');
  await w.close();
});
