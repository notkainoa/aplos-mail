import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, type MethodName } from '@aplos/contract';
import type { LogRecord } from '@aplos/contract/log/events';
import { fakeClock } from '../../src/clock/module';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions, type Engine } from '../../src/index';
import { BlobFilesError, type BlobFiles, type BlobHeader } from '../../src/ports';
import { BLOB_SENTENCES } from '../../src/runtime/blobs';
import { openStore } from '../../src/store';
import { accountWrite, T0, tempDb } from '../store/helpers';

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
const release = (s: Session, blobId: string) => s.call('Blob/release', { blobId });

async function refused(promise: Promise<unknown>): Promise<{ type: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return (error as { body: { type: string; message: string } }).body;
  }
  assert.fail('expected a refusal');
}

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

// ---- Blob package 4: Draft/set's ownership check and the outbox's read through services.blobs ----

const ATTACH_AGAIN = { type: 'notFound', message: `${BLOB_SENTENCES.gone} Attach it again.` };

function fieldsWith(blobIds: string[], subject = 'Lunch') {
  return {
    accountId: accountWrite.id,
    mode: 'new' as const,
    to: [{ address: 'jordan@mail.example', name: 'Jordan' }],
    cc: [],
    bcc: [],
    subject,
    html: '<p>Lunch at noon?</p>',
    attachments: blobIds.map((blobId, n) => ({
      id: `att${n}`,
      name: 'menu.pdf',
      mime: 'application/pdf',
      size: 10,
      blobId,
    })),
    signature: false,
  };
}

let opCounter = 0;
const setDraft = (
  s: Session,
  fields: ReturnType<typeof fieldsWith>,
  existing?: { id: string; revision: number },
) =>
  s.call('Draft/set', {
    opId: `blob4-op-${++opCounter}`,
    ...(existing ? { id: existing.id, baseRevision: existing.revision } : {}),
    fields,
  }) as Promise<{ draft: { id: string; revision: number } }>;

test('Draft/set: a new attachment must be a blob the caller made; any window may attach any window’s file (one app principal)', () =>
  withWorld(async w => {
    const { blobId } = await put(w.window);
    const second = w.engine.connect();
    const saved = await setDraft(second, fieldsWith([blobId]));
    assert.equal(saved.draft.revision, 1);
    assert.deepEqual(
      await refused(setDraft(w.window, fieldsWith(['b_' + '0'.repeat(32)]))),
      ATTACH_AGAIN,
    );
    assert.deepEqual(await refused(setDraft(w.window, fieldsWith(['nonsense']))), ATTACH_AGAIN);
  }));

test('Draft/set: a listener cannot attach a window’s file by id, nor another client’s; its own file works', () =>
  withWorld(async w => {
    const windowBlob = await put(w.window);
    const alice = w.listener('alice');
    const bob = w.listener('bob');
    const aliceBlob = await put(alice);
    assert.deepEqual(await refused(setDraft(alice, fieldsWith([windowBlob.blobId]))), ATTACH_AGAIN);
    assert.deepEqual(await refused(setDraft(bob, fieldsWith([aliceBlob.blobId]))), ATTACH_AGAIN);
    assert.ok((await setDraft(alice, fieldsWith([aliceBlob.blobId]))).draft.id);
    assert.deepEqual(
      await refused(setDraft(w.window, fieldsWith(['b_' + 'f'.repeat(32)]))),
      ATTACH_AGAIN,
    );
  }));

test('Draft/set: only NEW blob ids are checked; a draft keeps saving after its file lost its owner, and a changed id is checked', () =>
  withWorld(async w => {
    const first = await put(w.window);
    const saved = await setDraft(w.window, fieldsWith([first.blobId]));
    // The file is released (no live send): the draft still names it, and an edit of the subject does not ask again.
    await release(w.window, first.blobId);
    const edited = await setDraft(w.window, fieldsWith([first.blobId], 'Lunch?'), saved.draft);
    assert.equal(edited.draft.revision, 2);
    // Swapping in a file the caller does not own is refused, and nothing is saved.
    const foreign = await put(w.listener('carol'));
    assert.deepEqual(
      await refused(setDraft(w.window, fieldsWith([foreign.blobId]), edited.draft)),
      ATTACH_AGAIN,
    );
    const still = (await w.window.call('Draft/get', { ids: [saved.draft.id] })) as {
      list: { revision: number }[];
    };
    assert.equal(still.list[0].revision, 2);
  }));

test('Draft/set: with the host blob port absent every attachment with a blob id is refused', () =>
  withWorld(async w => {
    assert.deepEqual(
      await refused(setDraft(w.window, fieldsWith(['b_' + 'a'.repeat(32)]))),
      ATTACH_AGAIN,
    );
    assert.ok(
      (await setDraft(w.window, fieldsWith([]))).draft.id,
      'a draft with no attachments still saves',
    );
  }, null));

test('a send reads the attachment through services.blobs and pins its bytes in the MIME', () =>
  withWorld(
    async w => {
      const payload = new Uint8Array(300).map((_, i) => (i * 7) % 251);
      const { blobId } = await put(w.window, payload);
      const saved = await setDraft(w.window, fieldsWith([blobId]));
      await w.window.call('Submission/set', {
        opId: `blob4-send-${++opCounter}`,
        action: { type: 'send', draftId: saved.draft.id, revision: saved.draft.revision },
      });
      const db = w.engine.services.store.read(q =>
        q.get<{ mime: Uint8Array }>(
          'SELECT mime FROM submissions WHERE draft_id = ?',
          saved.draft.id,
        ),
      );
      const text = Buffer.from(db!.mime).toString('latin1');
      assert.ok(
        text.includes(Buffer.from(payload).toString('base64').slice(0, 60)),
        'the bytes are in the MIME',
      );
      // Held by the queued send: the file cannot be released from under it.
      assert.equal((await refused(release(w.window, blobId))).type, 'stateMismatch');
    },
    undefined,
    true,
  ));

test('a send whose file is gone is refused with the attach-again sentence and queues nothing', () =>
  withWorld(
    async w => {
      const { blobId } = await put(w.window);
      const saved = await setDraft(w.window, fieldsWith([blobId]));
      w.memory.stored.delete(blobId);
      const error = await refused(
        w.window.call('Submission/set', {
          opId: `blob4-send-${++opCounter}`,
          action: { type: 'send', draftId: saved.draft.id, revision: saved.draft.revision },
        }),
      );
      assert.equal(error.type, 'notFound');
      assert.match(error.message, /Attach it again/);
      const rows = w.engine.services.store.read(q =>
        q.all<{ id: string }>('SELECT id FROM submissions WHERE draft_id = ?', saved.draft.id),
      );
      assert.equal(rows.length, 0);
    },
    undefined,
    true,
  ));

test('Draft/set: EVERY new id is checked, in any position (a mixed request is refused whole)', () =>
  withWorld(async w => {
    const windowBlob = await put(w.window);
    const alice = w.listener('alice');
    const mine = await put(alice);
    const mine2 = await put(alice);
    assert.deepEqual(
      await refused(setDraft(alice, fieldsWith([mine.blobId, windowBlob.blobId]))),
      ATTACH_AGAIN,
    );
    assert.deepEqual(
      await refused(setDraft(alice, fieldsWith([windowBlob.blobId, mine.blobId]))),
      ATTACH_AGAIN,
    );
    assert.deepEqual(
      await refused(setDraft(alice, fieldsWith([mine.blobId, mine2.blobId, windowBlob.blobId]))),
      ATTACH_AGAIN,
    );
    assert.ok(
      (await setDraft(alice, fieldsWith([mine.blobId, mine2.blobId]))).draft.id,
      'two own files',
    );
  }));

test('Draft/set: the already-attached exemption is per draft: a file another draft names is still foreign', () =>
  withWorld(async w => {
    const windowBlob = await put(w.window);
    await setDraft(w.window, fieldsWith([windowBlob.blobId])); // draft A names it
    const alice = w.listener('alice');
    const mine = await put(alice);
    const own = await setDraft(alice, fieldsWith([mine.blobId])); // draft B, alice's own
    assert.deepEqual(
      await refused(setDraft(alice, fieldsWith([mine.blobId, windowBlob.blobId]), own.draft)),
      ATTACH_AGAIN,
    );
    assert.deepEqual(
      await refused(setDraft(alice, fieldsWith([windowBlob.blobId]))),
      ATTACH_AGAIN,
      'a new draft naming it',
    );
  }));

test('a listener client sends a draft with its OWN file: the outbox reads it whoever made it', () =>
  withWorld(
    async w => {
      const alice = w.engine.connect({
        kind: 'listener',
        via: 'http',
        clientId: 'alice',
        scopes: ['read', 'draft', 'send'],
      });
      const payload = new Uint8Array(200).map((_, i) => (i * 5) % 241);
      const { blobId } = await put(alice, payload);
      const saved = await setDraft(alice, fieldsWith([blobId]));
      await alice.call('Submission/set', {
        opId: `blob4-send-${++opCounter}`,
        action: { type: 'send', draftId: saved.draft.id, revision: saved.draft.revision },
      });
      const row = w.engine.services.store.read(q =>
        q.get<{ mime: Uint8Array }>(
          'SELECT mime FROM submissions WHERE draft_id = ?',
          saved.draft.id,
        ),
      );
      const text = Buffer.from(row!.mime).toString('latin1');
      assert.ok(
        text.includes(Buffer.from(payload).toString('base64').slice(0, 60)),
        'its bytes are in the MIME',
      );
    },
    undefined,
    true,
  ));

test('Draft/set: a replayed create is refused for NOTHING released since — it answers with the draft it made', () =>
  withWorld(async w => {
    const { blobId } = await put(w.window);
    const opId = `blob4-replay-${++opCounter}`;
    const fields = fieldsWith([blobId]);
    const first = (await w.window.call('Draft/set', { opId, fields })) as {
      draft: { id: string; revision: number };
    };
    assert.equal(first.draft.revision, 1);
    // The caller releases the blob outright. A live send would still refuse, but a replayed create
    // must not re-check ownership — the stored row already names the id.
    await w.window.call('Blob/release', { blobId });
    const replay = (await w.window.call('Draft/set', { opId, fields })) as {
      draft: { id: string; revision: number };
    };
    assert.equal(replay.draft.id, first.draft.id, 'the replay returns the draft it made');
    assert.equal(replay.draft.revision, 1);
    // And a create with a FRESH opId naming a released blob is still refused.
    assert.deepEqual(await refused(setDraft(w.window, fieldsWith([blobId]))), ATTACH_AGAIN);
  }));
