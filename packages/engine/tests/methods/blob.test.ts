import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, type MethodName } from '@aplos/contract';
import type { LogRecord } from '@aplos/contract/log/events';
import { fakeClock } from '../../src/clock/module';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions, type Engine } from '../../src/index';
import type { Caller } from '../../src/methods/types';
import { BlobFilesError, type BlobFiles, type BlobHeader } from '../../src/ports';
import {
  BLOB_QUOTAS,
  BLOB_SENTENCES,
  BLOB_TIMES,
  cleanMime,
  cleanName,
} from '../../src/runtime/blobs';
import { openStore } from '../../src/store';
import { accountWrite, T0, tempDb } from '../store/helpers';

const MB = 1024 * 1024;
const HOUR = 3_600_000;

/** An in-memory `BlobFiles` with the host's contract: a copy in, a fresh copy out per `get`. */
function memoryFiles() {
  const stored = new Map<string, { header: BlobHeader; bytes: Uint8Array; mtimeMs: number }>();
  const calls: string[] = [];
  const gates: { get?: Promise<void>; put?: Promise<void>; remove?: Promise<void> } = {};
  let refuse: BlobFilesError | undefined;
  const files: BlobFiles = {
    async put(id, header, bytes) {
      calls.push(`put ${id}`);
      await gates.put;
      if (refuse) throw refuse;
      if (stored.has(id)) throw new BlobFilesError('exists');
      stored.set(id, { header: { ...header }, bytes: bytes.slice(), mtimeMs: header.createdAt });
    },
    async get(id) {
      calls.push(`get ${id}`);
      // Like a real read that already opened the file: a delete after this point does not stop it.
      const entry = stored.get(id);
      await gates.get;
      return entry && { header: { ...entry.header }, bytes: entry.bytes.slice() };
    },
    async remove(id) {
      calls.push(`remove ${id}`);
      await gates.remove;
      if (refuse) throw refuse;
      stored.delete(id);
    },
    async list() {
      return [...stored].map(([id, entry]) => ({
        id,
        header: { ...entry.header },
        mtimeMs: entry.mtimeMs,
      }));
    },
    async usage() {
      return [...stored.values()].reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
    },
  };
  return {
    files,
    stored,
    calls,
    gates,
    refuseWith: (error: BlobFilesError | undefined) => void (refuse = error),
  };
}

type Memory = ReturnType<typeof memoryFiles>;

/** The real engine over a temp store, the fake clock and `memory` as its host blob port. */
/** `null`: no host blob port at all. */
async function world(memory: Memory | null = memoryFiles(), start = T0, withSend = false) {
  const file = tempDb();
  const clock = fakeClock(start);
  const records: LogRecord[] = [];
  const log = createLogger({ sink: { write: r => void records.push(r) }, salt: 's', clock });
  const store = openStore(file.open(), { now: () => clock.now(), extensions: laneExtensions() });
  store.commit({ opId: 'setup', origin: 'sync', writes: [{ ...accountWrite }] });
  const engine: Engine = await createEngine({
    store,
    clock,
    log,
    ports: {
      ...(memory ? { blobFiles: memory.files } : {}),
      // A send port that never leaves (the row is only queued in these tests): without one, sending is unavailable.
      ...(withSend
        ? {
            send: {
              send: async () => {
                throw new Error('not in this test');
              },
              findSent: async () => ({ kind: 'absent', checkedAt: 0 }),
            } as never,
          }
        : {}),
    },
    validate: (method, args) => parseArgs(method as MethodName, args),
  });
  const db = file.open();
  const window = engine.connect();
  let drafts = 0;
  return {
    engine,
    clock,
    memory: memory!,
    records,
    window,
    listener: (clientId = 'mcp-1') =>
      engine.connect({ kind: 'listener', via: 'mcp', clientId, scopes: ['read', 'draft'] }),
    /** A draft row naming `blobIds`, with a submission in `state` when given; `removing` hides it. */
    draft(blobIds: string[], state?: string, removing = false) {
      const id = `d${++drafts}`;
      const attachments = blobIds.map((blobId, n) => ({
        id: `a${n}`,
        name: 'f.pdf',
        mime: 'application/pdf',
        size: 1,
        blobId,
      }));
      const data = removing ? { attachments, _sync: { removing: { at: T0 } } } : { attachments };
      db.prepare(
        'INSERT INTO drafts(id, account_id, revision, data, updated_at) VALUES(?, ?, 1, ?, ?)',
      ).run(id, accountWrite.id, JSON.stringify(data), T0);
      if (state)
        db.prepare(
          `INSERT INTO submissions(id, draft_id, account_id, internet_id, not_before, state) VALUES(?, ?, ?, ?, 1, ?)`,
        ).run(`s-${id}`, id, accountWrite.id, `<${id}@x>`, state);
      return id;
    },
    /** A draft row whose `data` is exactly `text` — including text that is not JSON at all. */
    rawDraft: (text: string) =>
      void db
        .prepare(
          'INSERT INTO drafts(id, account_id, revision, data, updated_at) VALUES(?, ?, 1, ?, ?)',
        )
        .run(`r${++drafts}`, accountWrite.id, text, T0),
    removeDraft: (id: string) => void db.prepare('DELETE FROM drafts WHERE id = ?').run(id),
    async cleanup() {
      db.close();
      await engine.close();
      store.close();
      file.cleanup();
    },
  };
}

type World = Awaited<ReturnType<typeof world>>;

const bytesOf = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

type Session = ReturnType<Engine['connect']>;
const put = (s: Session, bytes = bytesOf(10), mime = 'application/pdf', name?: string) =>
  s.call('Blob/put', name === undefined ? { bytes, mime } : { bytes, mime, name }) as Promise<{
    blobId: string;
    size: number;
  }>;
const get = (s: Session, blobId: string) =>
  s.call('Blob/get', { blobId }) as Promise<{
    bytes: Uint8Array;
    mime: string;
    name?: string;
    size: number;
  }>;
const release = (s: Session, blobId: string) => s.call('Blob/release', { blobId });

async function refused(promise: Promise<unknown>): Promise<{ type: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return (error as { body: { type: string; message: string } }).body;
  }
  assert.fail('expected a refusal');
}

const gone = { type: 'notFound', message: BLOB_SENTENCES.gone };

async function withWorld(
  fn: (w: World) => Promise<void>,
  memory?: Memory | null,
  withSend = false,
) {
  const w = await world(memory, undefined, withSend);
  try {
    await fn(w);
  } finally {
    await w.cleanup();
  }
}

test('Blob/put, get and release round-trip; the id is 128 random bits; mime and name are cleaned', () =>
  withWorld(async w => {
    const bytes = bytesOf(1000, 4);
    const out = await put(w.window, bytes, 'Application/PDF; charset=x', 'a/b\\c\u202Egnp.exe');
    assert.match(out.blobId, /^b_[0-9a-f]{32}$/);
    assert.equal(out.size, 1000);
    const read = await get(w.window, out.blobId);
    assert.deepEqual(read.bytes, bytes);
    assert.equal(read.mime, 'application/pdf');
    assert.equal(read.name, 'abcgnp.exe');
    assert.equal(read.size, 1000);
    const header = w.memory.stored.get(out.blobId)!.header;
    assert.deepEqual(header, {
      principal: 'app',
      kind: 'upload',
      mime: 'application/pdf',
      name: 'abcgnp.exe',
      size: 1000,
      createdAt: T0,
    });
    assert.deepEqual(await release(w.window, out.blobId), { ok: true });
    assert.equal(w.memory.stored.has(out.blobId), false);
    assert.deepEqual(await refused(get(w.window, out.blobId)), gone);
    assert.deepEqual(await refused(release(w.window, out.blobId)), gone);
    const other = await put(w.window);
    assert.notEqual(other.blobId, out.blobId);
  }));

test('a reply buffer moved to a window never takes the bytes from the next read', () =>
  withWorld(async w => {
    const { blobId } = await put(w.window, bytesOf(4096, 5));
    const first = await get(w.window, blobId);
    assert.equal(first.bytes.byteOffset, 0);
    assert.equal(first.bytes.byteLength, first.bytes.buffer.byteLength, 'a whole buffer');
    structuredClone(first.bytes, { transfer: [first.bytes.buffer as ArrayBuffer] });
    assert.equal(first.bytes.byteLength, 0, 'moved');
    const second = await get(w.window, blobId);
    assert.equal(second.bytes.byteLength, 4096);
    assert.equal(second.bytes[4095], 5);

    // The runtime itself, as a port end that moves the buffer sees it: no read shares a buffer with another.
    const blobs = w.engine.services.blobs;
    const caller: Caller = { kind: 'window', scopes: ['read'] };
    const one = await blobs.get(caller, blobId);
    structuredClone(one.bytes, { transfer: [one.bytes.buffer] });
    const two = await blobs.get(caller, blobId);
    assert.equal(two.bytes.byteLength, 4096, 'a fresh buffer per read');
    assert.equal(two.bytes[0], 5);
  }));

test('principals: every window is the app; a listener sees only its own blobs, and a foreign blob is an unknown one', () =>
  withWorld(async w => {
    const mine = await put(w.window, bytesOf(10, 1));
    const otherWindow = w.engine.connect();
    assert.deepEqual((await get(otherWindow, mine.blobId)).bytes, bytesOf(10, 1));
    const mcp = w.listener('mcp-1');
    const unknown = `b_${'0'.repeat(32)}`;
    assert.deepEqual(await refused(get(mcp, mine.blobId)), await refused(get(mcp, unknown)));
    assert.deepEqual(await refused(get(mcp, mine.blobId)), gone);
    assert.deepEqual(await refused(release(mcp, mine.blobId)), gone);
    assert.equal(
      w.memory.stored.has(mine.blobId),
      true,
      'a listener cannot release a window’s blob',
    );

    const theirs = await put(mcp, bytesOf(10, 2));
    assert.equal(w.memory.stored.get(theirs.blobId)!.header.principal, 'client:mcp-1');
    assert.deepEqual((await get(mcp, theirs.blobId)).bytes, bytesOf(10, 2));
    assert.deepEqual(await refused(get(w.window, theirs.blobId)), gone);
    assert.deepEqual(await refused(get(w.listener('mcp-2'), theirs.blobId)), gone);
    const engine = w.engine.services.blobs;
    const asWindow: Caller = { kind: 'window', scopes: ['read'] };
    assert.equal(engine.owns(asWindow, mine.blobId), true);
    assert.equal(engine.owns(asWindow, theirs.blobId), false);
    assert.equal(
      engine.owns({ kind: 'listener', clientId: 'mcp-1', scopes: [] }, theirs.blobId),
      true,
    );
  }));

test('an id that is not a blob id never reaches the host, even one a host listed at start', async () => {
  const memory = memoryFiles();
  const bad = ['../x', `b_${'A'.repeat(32)}`, `b_${'a'.repeat(31)}`, 'b_x/../../y'];
  for (const id of bad)
    memory.stored.set(id, {
      header: { principal: 'app', kind: 'upload', mime: 'a/b', size: 1, createdAt: T0 },
      bytes: bytesOf(1),
      mtimeMs: T0,
    });
  const w = await world(memory);
  try {
    const caller: Caller = { kind: 'window', scopes: ['read'] };
    for (const blobId of bad) {
      assert.deepEqual(await refused(get(w.window, blobId)), gone);
      assert.equal(w.engine.services.blobs.owns(caller, blobId), false);
    }
    assert.deepEqual(await w.engine.services.blobs.load(bad), new Map());
    assert.deepEqual(
      w.memory.calls.filter(call => bad.some(id => call.endsWith(` ${id}`))),
      [],
    );
  } finally {
    await w.cleanup();
  }
});

test('caps: 25 MB per file, then the principal’s quota, counted with the puts still in flight', () =>
  withWorld(async w => {
    const over = await refused(put(w.window, new Uint8Array(25 * MB + 1)));
    assert.deepEqual(over, { type: 'tooLarge', message: BLOB_SENTENCES.tooLarge });
    const exact = await put(w.window, new Uint8Array(25 * MB));
    assert.equal(exact.size, 25 * MB);
    await release(w.window, exact.blobId);

    const quota = { type: 'tooLarge', message: BLOB_SENTENCES.quota };
    const mcp = w.listener();
    // 51 puts at once from one client: the reservation lets exactly 50 through.
    let open!: () => void;
    w.memory.gates.put = new Promise<void>(resolve => (open = resolve));
    const all = Array.from({ length: BLOB_QUOTAS.client.count + 1 }, () => put(mcp, bytesOf(1)));
    open();
    const settled = await Promise.allSettled(all);
    assert.equal(settled.filter(s => s.status === 'fulfilled').length, BLOB_QUOTAS.client.count);
    const rejected = settled.find(s => s.status === 'rejected') as PromiseRejectedResult;
    assert.deepEqual(rejected.reason.body, quota);
    // Another client has its own quota; the windows theirs.
    await put(w.listener('mcp-2'));
    await put(w.window);

    // Bytes: four 25 MB files fill a client's 100 MB, a fifth byte does not fit.
    const big = w.listener('mcp-3');
    for (let i = 0; i < 4; i++) await put(big, new Uint8Array(25 * MB));
    assert.deepEqual(await refused(put(big, bytesOf(1))), quota);

    // The host's own folder cap or disk floor reads the same.
    w.memory.refuseWith(new BlobFilesError('diskFull'));
    assert.deepEqual(await refused(put(w.window)), quota);
    w.memory.refuseWith(undefined);
  }));

test('release: a blob a waiting send names stays (FR-7); one only a draft names may go', () =>
  withWorld(async w => {
    const waiting = await put(w.window);
    const drafted = await put(w.window);
    const sent = await put(w.window);
    w.draft([waiting.blobId], 'queued');
    w.draft([drafted.blobId]);
    w.draft([sent.blobId], 'sent');
    for (const state of ['scheduled', 'sending', 'uncertain', 'failed', 'suspended']) {
      const blob = await put(w.window);
      w.draft([blob.blobId], state);
      assert.deepEqual(await refused(release(w.window, blob.blobId)), {
        type: 'stateMismatch',
        message: BLOB_SENTENCES.waiting,
      });
    }
    assert.deepEqual(await refused(release(w.window, waiting.blobId)), {
      type: 'stateMismatch',
      message: BLOB_SENTENCES.waiting,
    });
    assert.equal(w.memory.stored.has(waiting.blobId), true);
    assert.deepEqual(await release(w.window, drafted.blobId), { ok: true });
    assert.deepEqual(await release(w.window, sent.blobId), { ok: true });
  }));

test('a closed window takes its unheld blobs with it; a held one stays, for every window', () =>
  withWorld(async w => {
    const session = w.engine.connect();
    const held = await put(session);
    const loose = await put(session);
    const others = await put(w.window);
    w.draft([held.blobId]);
    session.close();
    await w.clock.flush();
    assert.deepEqual(await refused(get(w.window, loose.blobId)), gone);
    assert.equal(w.memory.stored.has(loose.blobId), false);
    assert.equal((await get(w.window, held.blobId)).size, 10);
    assert.equal(
      (await get(w.window, others.blobId)).size,
      10,
      'another window’s blob is not touched',
    );
  }));

test('a put that finishes after its window closed is undone', () =>
  withWorld(async w => {
    const session = w.engine.connect();
    let open!: () => void;
    w.memory.gates.put = new Promise<void>(resolve => (open = resolve));
    const pending = put(session);
    await w.clock.flush();
    session.close();
    open();
    await refused(pending);
    await w.clock.flush();
    assert.equal(w.memory.stored.size, 0);
  }));

test('the sweep: unheld uploads go 24 h after they were made, original handles 30 min after their last read', () =>
  withWorld(async w => {
    const blobs = w.engine.services.blobs;
    const caller: Caller = { kind: 'window', scopes: ['read'] };
    const kept = await put(w.window);
    const loose = await put(w.window);
    w.draft([kept.blobId]);
    const original = await blobs.put({
      caller,
      connectionId: 'none',
      kind: 'original',
      bytes: bytesOf(5),
      mime: 'message/rfc822',
      name: 'Hello.eml',
    });
    await w.clock.advance(20 * 60_000);
    await blobs.get(caller, original.blobId);
    await w.clock.advance(20 * 60_000);
    assert.equal(w.memory.stored.has(original.blobId), true, 'read 20 min ago');
    await w.clock.advance(20 * 60_000);
    assert.equal(w.memory.stored.has(original.blobId), false, 'unread for 30 min and a sweep');
    await w.clock.advance(23 * HOUR);
    assert.equal(w.memory.stored.has(loose.blobId), false, 'an unheld upload after 24 h');
    assert.equal(w.memory.stored.has(kept.blobId), true, 'a held upload stays');
    assert.equal((await get(w.window, kept.blobId)).size, 10);
  }));

test('a hidden draft holds its blobs only while a submission is still live', () =>
  withWorld(async w => {
    const blobs = w.engine.services.blobs;
    const caller: Caller = { kind: 'window', scopes: ['read'] };
    const dead = await put(w.window);
    const sending = await put(w.window);
    const kept = await put(w.window);
    const stopped = await put(w.window);
    w.draft([dead.blobId], undefined, true);
    w.draft([sending.blobId], 'sending', true);
    w.draft([kept.blobId], 'sent', true);
    w.draft([stopped.blobId], 'cancelled', true);
    // FR-7: a hidden row with a live submission cannot be released either.
    await assert.rejects(blobs.release(caller, sending.blobId));
    // A removing row with a live submission keeps its blob; 'sent'/'cancelled' do not.
    await w.clock.advance(24 * HOUR + 60_000);
    assert.equal(w.memory.stored.has(dead.blobId), false, 'hidden, nothing live');
    assert.equal(w.memory.stored.has(sending.blobId), true, 'hidden but still sending');
    assert.equal(w.memory.stored.has(kept.blobId), false, 'hidden, send settled');
    assert.equal(w.memory.stored.has(stopped.blobId), false, 'hidden, send cancelled');
  }));

test('a draft row with unreadable data does not wedge the blob runtime', () =>
  withWorld(async w => {
    const loose = await put(w.window);
    w.rawDraft('{not json');
    // release runs references(): a malformed row is read as empty, not as a store error that
    // would leave every Blob/* call answering `unavailable`.
    assert.deepEqual(await release(w.window, loose.blobId), { ok: true });
  }));

test('at start the index is rebuilt: held blobs stay, unheld originals go, unheld uploads go after 24 h', async () => {
  const memory = memoryFiles();
  const first = await world(memory);
  const caller: Caller = { kind: 'window', scopes: ['read'] };
  const held = await put(first.window);
  const fresh = await put(first.window);
  const original = await first.engine.services.blobs.put({
    caller,
    connectionId: 'x',
    kind: 'original',
    bytes: bytesOf(3),
    mime: 'message/rfc822',
  });
  const old = `b_${'e'.repeat(32)}`;
  memory.stored.set(old, {
    header: { principal: 'app', kind: 'upload', mime: 'a/b', size: 1, createdAt: T0 - 25 * HOUR },
    bytes: bytesOf(1),
    mtimeMs: T0,
  });
  const heldOld = `b_${'f'.repeat(32)}`;
  memory.stored.set(heldOld, {
    header: { principal: 'app', kind: 'upload', mime: 'a/b', size: 1, createdAt: T0 - 25 * HOUR },
    bytes: bytesOf(1),
    mtimeMs: T0,
  });
  first.draft([held.blobId, heldOld]);
  // The engine restarts on the same store and the same blob folder (the windows' connections are gone).
  const second = await createEngine({
    store: first.engine.services.store,
    clock: first.clock,
    log: createLogger({ sink: { write: () => undefined }, salt: 's', clock: first.clock }),
    ports: { blobFiles: memory.files },
  });
  try {
    await first.clock.flush();
    const window = second.connect();
    assert.equal((await get(window, held.blobId)).size, 10);
    assert.equal((await get(window, heldOld)).size, 1);
    assert.equal((await get(window, fresh.blobId)).size, 10, 'a fresh upload survives a restart');
    assert.deepEqual(await refused(get(window, original.blobId)), gone);
    assert.deepEqual(await refused(get(window, old)), gone);
    assert.equal(memory.stored.has(original.blobId), false);
    assert.equal(memory.stored.has(old), false);
  } finally {
    await second.close();
    await first.cleanup();
  }
});

test('TOCTOU: a release is complete in its own turn; a read racing it and a Draft/set check after it see no blob', () =>
  withWorld(async w => {
    const blobs = w.engine.services.blobs;
    const caller: Caller = { kind: 'window', scopes: ['read'] };
    const { blobId } = await put(w.window);
    let open!: () => void;
    w.memory.gates.get = new Promise<void>(resolve => (open = resolve));
    const reading = get(w.window, blobId);
    await w.clock.flush();
    // The host's delete hangs: the index entry is already gone, so Draft/set's ownership check refuses it now.
    let removed!: () => void;
    w.memory.gates.remove = new Promise<void>(resolve => (removed = resolve));
    const releasing = release(w.window, blobId);
    await w.clock.flush();
    assert.ok(w.memory.calls.includes(`remove ${blobId}`), 'the delete has started');
    assert.equal(blobs.owns(caller, blobId), false);
    assert.equal(w.memory.stored.has(blobId), true, 'and has not finished');
    removed();
    w.memory.gates.remove = undefined;
    open();
    assert.deepEqual(await releasing, { ok: true });
    assert.deepEqual(await refused(reading), gone, 'no stale bytes after a release');

    // The other order: the draft (with its send) lands first, then the release is refused.
    const second = await put(w.window);
    w.draft([second.blobId], 'queued');
    assert.deepEqual((await refused(release(w.window, second.blobId))).type, 'stateMismatch');
    assert.equal(blobs.owns(caller, second.blobId), true);
  }));

test('the outbox reads a draft’s blobs by id, whatever their principal', () =>
  withWorld(async w => {
    const a = await put(w.listener(), bytesOf(3, 1));
    const b = await put(w.window, bytesOf(4, 2));
    const loaded = await w.engine.services.blobs.load([a.blobId, b.blobId, a.blobId, 'b_nope']);
    assert.deepEqual([...loaded.keys()], [a.blobId, b.blobId]);
    assert.deepEqual(loaded.get(b.blobId), bytesOf(4, 2));
  }));

test('without a host blob port every Blob/* method is unavailable', () =>
  withWorld(async w => {
    const absent = { type: 'unavailable', message: 'This part of Aplos is not running yet.' };
    assert.deepEqual(await refused(put(w.window)), absent);
    assert.deepEqual(await refused(get(w.window, `b_${'0'.repeat(32)}`)), absent);
    assert.deepEqual(await refused(release(w.window, `b_${'0'.repeat(32)}`)), absent);
  }, null));

test('reads in flight are capped: two per principal, a shared byte budget for clients; the rest answer a retryable busy', () =>
  withWorld(async w => {
    const busy = {
      type: 'unavailable',
      message: BLOB_SENTENCES.busy,
      retryAfterMs: 1000,
    };
    const small = await put(w.window, bytesOf(10));
    const mcp = w.listener();
    const theirs = await put(mcp, bytesOf(10));
    let open!: () => void;
    w.memory.gates.get = new Promise<void>(resolve => (open = resolve));
    const first = get(w.window, small.blobId);
    const second = get(w.window, small.blobId);
    assert.deepEqual(await refused(get(w.window, small.blobId)), busy);
    // Another principal has its own two.
    const third = get(mcp, theirs.blobId);
    open();
    await Promise.all([first, second, third]);
    assert.equal(
      (await get(w.window, small.blobId)).size,
      10,
      'a slot frees when its reply is out',
    );

    // Bytes: clients share 32 MB (one 25 MB read always fits, a second client's does not), and a client looping
    // reads on its own big blobs never makes the owner's windows busy.
    const clients = [w.listener('mcp-2'), w.listener('mcp-3')];
    const ids: string[] = [];
    for (const session of clients) ids.push((await put(session, new Uint8Array(25 * MB))).blobId);
    const mine = await put(w.window, new Uint8Array(25 * MB));
    w.memory.gates.get = new Promise<void>(resolve => (open = resolve));
    const a = get(clients[0], ids[0]);
    assert.deepEqual(await refused(get(clients[1], ids[1])), busy);
    const owner = [get(w.window, mine.blobId), get(w.window, mine.blobId)];
    open();
    await Promise.all([a, ...owner]);
    assert.equal((await get(clients[1], ids[1])).size, 25 * MB);
    // A client looping two reads on its own 25 MB blob: the window's reads still go through every time.
    for (let round = 0; round < 3; round++) {
      w.memory.gates.get = new Promise<void>(resolve => (open = resolve));
      const loop = [get(clients[0], ids[0]), get(clients[0], ids[0])];
      const windowRead = get(w.window, mine.blobId);
      open();
      const settled = await Promise.allSettled([...loop, windowRead]);
      assert.equal(settled[2].status, 'fulfilled', 'the owner is never starved by a client');
    }
    // A refused or failed read gives its slot back too.
    await refused(get(w.window, `b_${'0'.repeat(32)}`));
    await Promise.all([get(w.window, small.blobId), get(w.window, small.blobId)]);
  }));

test('a release whose file delete fails still answers ok: the release already happened', () =>
  withWorld(async w => {
    const { blobId } = await put(w.window);
    w.memory.refuseWith(new BlobFilesError('io'));
    assert.deepEqual(await release(w.window, blobId), { ok: true });
    w.memory.refuseWith(undefined);
    assert.deepEqual(await refused(get(w.window, blobId)), gone);
    assert.ok(
      w.records.some(r => r.event === 'rpc.failed' && JSON.stringify(r).includes('Blob/remove')),
    );
  }));

test('at start a creation time ahead of the clock counts from now, so the upload still ends', async () => {
  const memory = memoryFiles();
  const future = `b_${'9'.repeat(32)}`;
  memory.stored.set(future, {
    header: {
      principal: 'app',
      kind: 'upload',
      mime: 'a/b',
      size: 1,
      createdAt: T0 + 365 * 24 * HOUR,
    },
    bytes: bytesOf(1),
    mtimeMs: T0,
  });
  const w = await world(memory);
  try {
    assert.equal((await get(w.window, future)).size, 1, 'fresh for now');
    await w.clock.advance(24 * HOUR + BLOB_TIMES.sweepMs);
    assert.equal(memory.stored.has(future), false, 'gone 24 h after the start, not a year later');
  } finally {
    await w.cleanup();
  }
});

test('a blob the host cannot read right now answers notFound but stays known, and reads again later', () =>
  withWorld(async w => {
    const { blobId } = await put(w.window, bytesOf(6, 3));
    const kept = w.memory.stored.get(blobId)!;
    w.memory.stored.delete(blobId);
    assert.deepEqual(await refused(get(w.window, blobId)), gone);
    w.memory.stored.set(blobId, kept);
    assert.deepEqual((await get(w.window, blobId)).bytes, bytesOf(6, 3));
  }));

test('mime and name cleaning', () => {
  assert.equal(cleanMime('IMAGE/png'), 'image/png');
  assert.equal(cleanMime('text/html; charset=utf-8'), 'text/html');
  for (const bad of ['', 'png', 'a/b/c', 'text/ html', '<script>/x', 'x'.repeat(300) + '/y', 7])
    assert.equal(cleanMime(bad), 'application/octet-stream', String(bad));
  assert.equal(cleanName('../../etc/passwd'), '....etcpasswd');
  assert.equal(cleanName('a\u0000b\u0007c\u009fd'), 'abcd');
  assert.equal(cleanName('invoice\u202Efdp.exe'), 'invoicefdp.exe');
  assert.equal(cleanName('a\u2028b\u2029c\uFEFFd\u200Be\u2066f'), 'abcdef', 'Zl, Zp, Cf');
  assert.equal(cleanName('  report.pdf  '), 'report.pdf');
  assert.equal(cleanName('x'.repeat(400))?.length, 255);
  assert.equal(cleanName('😀'.repeat(300)), '😀'.repeat(255), 'never splits a character');
  for (const empty of ['', '   ', '/', '..', '.', '\u0000', undefined, 3])
    assert.equal(cleanName(empty), undefined, String(empty));
});

test('the sweep is a source on the timer loop, every 10 minutes', () =>
  withWorld(async w => {
    const source = w.engine.services.blobs.source;
    assert.equal(source.id, 'blobs');
    assert.equal(await source.next(), w.clock.now() + BLOB_TIMES.sweepMs);
    await w.clock.advance(BLOB_TIMES.sweepMs);
    assert.equal(await source.next(), w.clock.now() + BLOB_TIMES.sweepMs);
  }));
