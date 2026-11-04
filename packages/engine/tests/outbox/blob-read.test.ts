import test from 'node:test';
import assert from 'node:assert/strict';
import type { Draft, DraftFields, SubmissionAction } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { fakeClock } from '../../src/clock/module';
import { BLOB_READ_LIMIT_MS, loadBlobs } from '../../src/outbox/blob-read';
import { buildMime } from '../../src/outbox/mime';
import { copyWrite, fields, gate, inWorld, SEC, syncBlobSource, type World } from './helpers';

/**
 * Blob package 4: the outbox reads attachment bytes asynchronously. A send whose read is held open must never pin a
 * stale draft, never queue twice, never queue a message missing an attachment, and must leave every other command
 * exactly as it was. The draft upload must upload only the content its bytes were read for.
 */

/** A clock for the unit tests that never moves: no read there reaches the limit. */
const still = fakeClock(0);

const enc = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

let ops = 0;
const next = () => `blob-op-${++ops}`;

const CHANGED = 'This draft changed in another window. Reopen it before sending.';
const ON_ITS_WAY = 'This message is already on its way.';
const GONE_DRAFT = 'This draft no longer exists.';
const UNREADABLE = "Couldn't read an attachment. Try again.";
const GONE_FILE = 'The attachment "notes.txt" is no longer available. Attach it again, then send.';

function attach(w: World, name = 'notes.txt', body: string | null = 'hello') {
  if (body !== null) w.blobs.set(`blob-${name}`, enc(body));
  return { id: `att-${name}`, name, mime: 'text/plain', size: 5, blobId: `blob-${name}` };
}

const withFile = (w: World, extra: Partial<DraftFields> = {}) =>
  fields({ attachments: [attach(w)], ...extra });

async function rejected(promise: Promise<unknown>, type: string): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ContractError, `a ContractError, got ${String(error)}`);
    assert.equal(error.type, type, error.message);
    return error.message;
  }
  return assert.fail(`expected ${type}`);
}

const submissions = (w: World) =>
  w.first.store.read(q =>
    q.all<{ id: string; draft_id: string; revision: number; state: string; internet_id: string }>(
      'SELECT id, draft_id, revision, state, internet_id FROM submissions',
    ),
  );

const sendAction = (draftId: string, revision = 1): SubmissionAction => ({
  type: 'send',
  draftId,
  revision,
});

/** Starts a send whose blob read waits on a gate; the gate is consumed so later reads run free. */
function heldSend(w: World, draftId: string, revision = 1, opId = next()) {
  const g = gate();
  w.blobReads.hold = g.wait;
  const pending = w.first.outbox.service.set(opId, sendAction(draftId, revision));
  w.blobReads.hold = undefined;
  return { pending, open: g.open };
}

/** Boundaries are random per build: the same message built twice differs only there. */
function normalized(mime: Uint8Array) {
  const seen = new Map<string, string>();
  return text(mime).replace(/=_aplos_[0-9a-f]{24}/g, b => {
    if (!seen.has(b)) seen.set(b, `B${seen.size}`);
    return seen.get(b)!;
  });
}

// ---------------------------------------------------------------- loadBlobs

test('loadBlobs reads each distinct id once, concurrently, and leaves a missing blob out', async () => {
  const started: string[] = [];
  const g = gate();
  const source = {
    async get(id: string) {
      started.push(id);
      await g.wait;
      return id === 'gone' ? undefined : enc(id);
    },
  };
  const load = loadBlobs(source, ['a', 'b', 'a', 'gone'], still);
  await Promise.resolve();
  assert.deepEqual(started, ['a', 'b', 'gone'], 'every read started before any finished');
  g.open();
  const map = await load;
  assert.deepEqual([...map.keys()], ['a', 'b']);
  assert.notEqual(await loadBlobs(source, ['a'], still), map, 'a fresh map per load');
});

test('loadBlobs: a read that rejects or throws fails the whole load as unavailable', async () => {
  const rejects = {
    get: async (id: string) => (id === 'bad' ? Promise.reject(new Error('EIO')) : enc(id)),
  };
  assert.equal(await rejected(loadBlobs(rejects, ['ok', 'bad'], still), 'unavailable'), UNREADABLE);
  const throws = {
    get: (id: string): Promise<Uint8Array | undefined> => {
      if (id === 'bad') throw new Error('EBADF');
      return Promise.resolve(enc(id));
    },
  };
  assert.equal(await rejected(loadBlobs(throws, ['bad'], still), 'unavailable'), UNREADABLE);
  assert.equal((await loadBlobs(undefined, ['a'], still)).size, 0, 'no source: every blob is gone');
  assert.equal(
    (
      await loadBlobs(
        syncBlobSource(() => enc('x')),
        ['a'],
        still,
      )
    ).get('a')?.length,
    1,
  );
});

// ---------------------------------------------------------------- the send

test('vii: a send with no attachments never reads a blob and is queued within the call', () =>
  inWorld(async w => {
    w.draft('d1');
    const pending = w.first.outbox.service.set(next(), sendAction('d1'));
    assert.equal(submissions(w).length, 1, 'the row is committed before the call returns');
    assert.equal((await pending).submission.state, 'queued');
    assert.deepEqual(w.blobReads.calls, [], 'the blob source was never asked');
  }));

test('a send with attachments pins the same MIME as a build from the same inputs', () =>
  inWorld(async w => {
    const f = withFile(w, { attachments: [attach(w), attach(w, 'b.txt', 'second')] });
    w.draft('d1', f);
    const { submission } = await w.act(w.first, sendAction('d1'));
    const row = w.raw(submission.id) as {
      mime: Uint8Array;
      internet_id: string;
      not_before: number;
    };
    const expected = buildMime({
      from: { address: 'owner@mail.example' },
      to: f.to,
      cc: f.cc,
      subject: f.subject,
      html: f.html,
      messageId: row.internet_id,
      date: row.not_before,
      attachments: f.attachments.map(a => ({
        name: a.name,
        mime: a.mime,
        bytes: w.blobs.get(a.blobId!)!,
        inline: a.inline,
        contentId: a.contentId,
      })),
    });
    assert.equal(normalized(row.mime), normalized(expected));
    assert.deepEqual(w.blobReads.calls, ['blob-notes.txt', 'blob-b.txt']);
  }));

test('i: a draft edited during the read is refused as changed, nothing is queued, and the new revision sends', () =>
  inWorld(async w => {
    w.draft('d1', withFile(w));
    const held = heldSend(w, 'd1');
    w.draft('d1', withFile(w, { subject: 'Edited' }), { revision: 2 });
    held.open();
    assert.equal(await rejected(held.pending, 'stateMismatch'), CHANGED);
    assert.equal(submissions(w).length, 0, 'no row');
    const sent = await w.send(w.first, 'd1', { revision: 2 });
    assert.equal(sent.state, 'queued');
    assert.match(text((w.raw(sent.id) as { mime: Uint8Array }).mime), /Subject: Edited/);
  }));

test('ii: the same send twice at once (double click, two windows) queues exactly one', () =>
  inWorld(async w => {
    w.draft('d1', withFile(w));
    const g = gate();
    w.blobReads.hold = g.wait;
    const a = w.first.outbox.service.set(next(), sendAction('d1'));
    const b = w.open().outbox.service.set(next(), sendAction('d1'));
    g.open();
    const [first, second] = await Promise.allSettled([a, b]);
    assert.equal(first.status, 'fulfilled');
    assert.equal(await rejected(b, 'stateMismatch'), ON_ITS_WAY);
    assert.equal(second.status, 'rejected');
    assert.equal(submissions(w).length, 1);
  }));

test('ii: the same opId sent twice at once answers both with the one submission', () =>
  inWorld(async w => {
    w.draft('d1', withFile(w));
    const g = gate();
    w.blobReads.hold = g.wait;
    const a = w.first.outbox.service.set('same-op', sendAction('d1'));
    const b = w.first.outbox.service.set('same-op', sendAction('d1'));
    g.open();
    const [x, y] = await Promise.all([a, b]);
    assert.equal(x.submission.id, y.submission.id);
    assert.equal(submissions(w).length, 1);
  }));

test('iii: a draft sent from elsewhere during the read is on its way; nothing more is queued', () =>
  inWorld(async w => {
    w.draft('d1', withFile(w));
    const held = heldSend(w, 'd1');
    const other = await w.send(w.first, 'd1');
    held.open();
    assert.equal(await rejected(held.pending, 'stateMismatch'), ON_ITS_WAY);
    assert.deepEqual(
      submissions(w).map(s => s.id),
      [other.id],
    );
  }));

test('iii: a draft discarded during the read no longer exists; no row', () =>
  inWorld(
    async w => {
      const drafts = w.first.outbox.drafts!;
      const d = drafts.set(next(), { fields: withFile(w) }).draft;
      const held = heldSend(w, d.id, d.revision);
      drafts.destroy(next(), d.id);
      held.open();
      assert.equal(await rejected(held.pending, 'notFound'), GONE_DRAFT);
      assert.equal(submissions(w).length, 0);
    },
    { drafts: true },
  ));

test('the MIME is built from the draft as it is after the read: a copy synced meanwhile lends its Message-ID', () =>
  inWorld(
    async w => {
      const drafts = w.first.outbox.drafts!;
      const d: Draft = drafts.set(next(), { fields: withFile(w) }).draft;
      const held = heldSend(w, d.id, d.revision);
      await w.clock.advance(5 * SEC);
      await w.settle();
      const synced = w.first.store.read(q =>
        q.get<{ remote_internet_id: string; synced_revision: number }>(
          'SELECT remote_internet_id, synced_revision FROM drafts WHERE id = ?',
          d.id,
        ),
      )!;
      assert.equal(synced.synced_revision, d.revision, 'the copy was synced during the read');
      held.open();
      const { submission } = await held.pending;
      assert.equal(
        (w.raw(submission.id) as { internet_id: string }).internet_id,
        synced.remote_internet_id,
        'the same Message-ID a send made after the sync uses',
      );
    },
    { drafts: true },
  ));

test('iv: a blob that is gone keeps the notFound sentence and queues nothing', () =>
  inWorld(async w => {
    w.draft('d1', fields({ attachments: [attach(w, 'notes.txt', null)] }));
    assert.equal(await rejected(w.act(w.first, sendAction('d1')), 'notFound'), GONE_FILE);
    assert.equal(submissions(w).length, 0);
  }));

test('iv: bytes are never shared between sends: a blob removed after one send is gone for the next', () =>
  inWorld(async w => {
    w.draft('d1', withFile(w));
    w.draft('d2', withFile(w));
    await w.send(w.first, 'd1');
    w.blobs.delete('blob-notes.txt');
    assert.equal(await rejected(w.act(w.first, sendAction('d2')), 'notFound'), GONE_FILE);
    assert.equal(submissions(w).length, 1);
  }));

test('v: a read that fails is unavailable, queues nothing, and a retry sends', () =>
  inWorld(async w => {
    w.draft('d1', withFile(w));
    w.blobReads.fail = new Error('EIO');
    assert.equal(await rejected(w.act(w.first, sendAction('d1')), 'unavailable'), UNREADABLE);
    assert.equal(submissions(w).length, 0);
    w.blobReads.fail = undefined;
    assert.equal((await w.send(w.first, 'd1')).state, 'queued');
  }));

test('vi: undo, cancel and get of other submissions run at once while a send reads bytes', () =>
  inWorld(async w => {
    w.draft('d2');
    w.draft('d3');
    w.draft('d1', withFile(w));
    const other = await w.send(w.first, 'd2');
    const failed = await w.send(w.first, 'd3');
    w.first.store.commit({
      opId: 'fail-d3',
      origin: 'system',
      writes: [
        {
          kind: 'submission',
          op: 'move',
          id: failed.id,
          from: ['queued'],
          to: 'failed',
          set: {},
          why: 'test',
        },
      ],
    });
    const held = heldSend(w, 'd1');
    const undo = w.first.outbox.service.set(next(), { type: 'undo', submissionId: other.id });
    assert.equal(w.get(other.id).state, 'cancelled', 'the undo is done within its call');
    const cancel = w.first.outbox.service.set(next(), { type: 'cancel', submissionId: failed.id });
    assert.equal(w.get(failed.id).state, 'cancelled');
    const got = w.first.outbox.service.get([other.id, 'nope']);
    assert.deepEqual(got.notFound, ['nope']);
    assert.equal(submissions(w).length, 2, 'the held send has no row yet');
    assert.equal((await undo).submission.state, 'cancelled');
    assert.equal((await cancel).submission.state, 'cancelled');
    held.open();
    assert.equal((await held.pending).submission.state, 'queued');
  }));

// ---------------------------------------------------------------- the draft upload

const drafts = (w: World) => w.first.outbox.drafts!;

const draftRow = (w: World, id: string) =>
  w.first.store.read(q =>
    q.get<{ updated_at: number; synced_revision: number | null; data: string }>(
      'SELECT updated_at, synced_revision, data FROM drafts WHERE id = ?',
      id,
    ),
  )!;

test('viii: a draft copy loads its bytes and uploads the same MIME a build from the same inputs gives', () =>
  inWorld(
    async w => {
      const f = withFile(w);
      const d = drafts(w).set(next(), { fields: f }).draft;
      const updatedAt = draftRow(w, d.id).updated_at;
      await w.clock.advance(5 * SEC);
      await w.settle();
      const upload = w.remoteDrafts.saves[0];
      assert.equal(upload.revision, d.revision);
      const expected = buildMime({
        from: { address: 'owner@mail.example' },
        to: f.to,
        cc: f.cc,
        subject: f.subject,
        html: f.html,
        messageId: upload.internetId,
        date: updatedAt,
        attachments: [{ name: 'notes.txt', mime: 'text/plain', bytes: enc('hello') }],
      });
      assert.equal(normalized(upload.mime), normalized(expected));
      assert.equal(draftRow(w, d.id).synced_revision, d.revision);
    },
    { drafts: true },
  ));

test('viii: a blob that is gone leaves its attachment out of the copy, which is flagged partial', () =>
  inWorld(
    async w => {
      const f = fields({ attachments: [attach(w), attach(w, 'lost.txt', null)] });
      const d = drafts(w).set(next(), { fields: f }).draft;
      await w.clock.advance(5 * SEC);
      await w.settle();
      const mime = text(w.remoteDrafts.saves[0].mime);
      assert.match(mime, /notes\.txt/);
      assert.doesNotMatch(mime, /lost\.txt/);
      assert.equal(draftRow(w, d.id).synced_revision, null, 'partial: not this revision');
    },
    { drafts: true },
  ));

test('viii: a draft edited while its bytes load uploads only the new revision', () =>
  inWorld(
    async w => {
      const d = drafts(w).set(next(), { fields: withFile(w) }).draft;
      const g = gate();
      w.blobReads.hold = g.wait;
      await w.clock.advance(5 * SEC);
      w.blobReads.hold = undefined;
      assert.equal(w.blobReads.calls.length, 1, 'the upload is reading');
      const edited = drafts(w).set(next(), {
        id: d.id,
        baseRevision: d.revision,
        fields: withFile(w, { subject: 'Edited' }),
      }).draft;
      g.open();
      await w.settle();
      assert.equal(w.remoteDrafts.saves.length, 0, 'the stale read uploads nothing');
      await w.clock.advance(5 * SEC);
      await w.settle();
      assert.deepEqual(
        w.remoteDrafts.saves.map(s => s.revision),
        [edited.revision],
      );
      assert.match(text(w.remoteDrafts.saves[0].mime), /Subject: Edited/);
      assert.equal(draftRow(w, d.id).synced_revision, edited.revision);
    },
    { drafts: true },
  ));

test('viii: a version from another device reported while the bytes load is not uploaded over', () =>
  inWorld(
    async w => {
      const d = drafts(w).set(next(), { fields: withFile(w) }).draft;
      await w.clock.advance(5 * SEC);
      await w.settle();
      const synced = w.first.store.read(q =>
        q.get<{ remote_draft_id: string; remote_message_id: string }>(
          'SELECT remote_draft_id, remote_message_id FROM drafts WHERE id = ?',
          d.id,
        ),
      )!;
      const mine = drafts(w).set(next(), {
        id: d.id,
        baseRevision: d.revision,
        fields: withFile(w, { subject: 'Mine' }),
      }).draft;
      const g = gate();
      w.blobReads.hold = g.wait;
      await w.clock.advance(5 * SEC);
      w.blobReads.hold = undefined;
      const theirs = w.remoteDrafts.phoneEdit(synced.remote_draft_id);
      w.first.store.commit({
        opId: next(),
        origin: 'sync',
        writes: [
          copyWrite({
            remoteDraftId: synced.remote_draft_id,
            remoteMessageId: theirs,
            internetId: '<theirs@phone.example>',
            changedAt: w.clock.now(),
            content: fields({ subject: 'Theirs' }),
          }),
        ],
      });
      assert.ok(drafts(w).get([d.id]).list[0].conflict, 'the choice is raised');
      g.open();
      await w.settle();
      assert.equal(w.remoteDrafts.saves.length, 1, 'nothing uploaded over the other version');
      assert.equal(drafts(w).get([d.id]).list[0].revision, mine.revision);
    },
    { drafts: true },
  ));

test('viii: a failed read leaves the draft without a problem and uploads on a later try', () =>
  inWorld(
    async w => {
      const d = drafts(w).set(next(), { fields: withFile(w) }).draft;
      w.blobReads.fail = new Error('EIO');
      await w.clock.advance(5 * SEC);
      await w.settle();
      assert.equal(w.remoteDrafts.saves.length, 0);
      assert.equal(w.blobReads.calls.length, 1, 'asked once, then again only after the retry wait');
      await w.clock.advance(20 * SEC);
      await w.settle();
      assert.equal(w.blobReads.calls.length, 1, 'not before the retry wait');
      const meta = (JSON.parse(draftRow(w, d.id).data) as { _sync: { problem?: unknown } })._sync;
      assert.equal(meta.problem, undefined, 'no lasting problem');
      assert.notEqual(drafts(w).get([d.id]).list[0].sync, 'failed');
      w.blobReads.fail = undefined;
      await w.clock.advance(60 * SEC);
      await w.settle();
      assert.equal(w.remoteDrafts.saves.length, 1);
      assert.equal(draftRow(w, d.id).synced_revision, d.revision);
    },
    { drafts: true },
  ));

test('viii: a draft sent while its copy loads bytes is not uploaded under the send', () =>
  inWorld(
    async w => {
      const d = drafts(w).set(next(), { fields: withFile(w) }).draft;
      const g = gate();
      w.blobReads.hold = g.wait;
      await w.clock.advance(5 * SEC);
      w.blobReads.hold = undefined;
      assert.equal(w.blobReads.calls.length, 1, 'the upload is reading');
      const sent = await w.send(w.first, d.id, { revision: d.revision });
      g.open();
      await w.settle();
      assert.equal(w.remoteDrafts.saves.length, 0, 'a draft a send pins uploads nothing');
      assert.equal(w.get(sent.id).state, 'queued');
    },
    { drafts: true },
  ));

// ---------------------------------------------------------------- review round: the read's time limit

test('loadBlobs: a read still running at the limit fails as unavailable; one done just before it works', async () => {
  const clock = fakeClock(0);
  const hung = { get: () => new Promise<Uint8Array | undefined>(() => {}) };
  const load = rejected(loadBlobs(hung, ['a'], clock), 'unavailable');
  await clock.advance(BLOB_READ_LIMIT_MS);
  assert.equal(await load, UNREADABLE);
  const slow = {
    get: (id: string) => clock.sleep(BLOB_READ_LIMIT_MS - 1).then(() => enc(id)),
  };
  const ok = loadBlobs(slow, ['b'], clock);
  await clock.advance(BLOB_READ_LIMIT_MS - 1);
  assert.equal(text((await ok).get('b')!), 'b');
});

test('a send whose read hangs is unavailable at the limit; a late answer queues nothing; a later send works', () =>
  inWorld(async w => {
    w.draft('d1', withFile(w));
    const held = heldSend(w, 'd1');
    const outcome = rejected(held.pending, 'unavailable');
    await w.clock.advance(BLOB_READ_LIMIT_MS);
    assert.equal(await outcome, UNREADABLE);
    held.open();
    await w.settle();
    assert.equal(submissions(w).length, 0, 'the late answer changes nothing');
    assert.equal((await w.send(w.first, 'd1')).state, 'queued');
    assert.equal(submissions(w).length, 1);
  }));

test('a draft upload whose read hangs is not stuck: it ends at the limit, a late answer uploads nothing, it retries', () =>
  inWorld(
    async w => {
      const d = drafts(w).set(next(), { fields: withFile(w) }).draft;
      const g = gate();
      w.blobReads.hold = g.wait;
      await w.clock.advance(5 * SEC);
      w.blobReads.hold = undefined;
      await w.clock.advance(BLOB_READ_LIMIT_MS);
      let idle = false;
      void w.first.outbox.idle().then(() => {
        idle = true;
      });
      await w.settle();
      assert.ok(idle, 'no upload is left running');
      g.open();
      await w.settle();
      assert.equal(w.remoteDrafts.saves.length, 0, 'the late answer uploads nothing');
      await w.clock.advance(30 * SEC);
      await w.settle();
      assert.equal(w.remoteDrafts.saves.length, 1, 'the retry reads again and uploads');
      assert.equal(draftRow(w, d.id).synced_revision, d.revision);
    },
    { drafts: true },
  ));

// ---------------------------------------------------------------- review round: an unreadable blob stops retrying

const readFails = (w: World, id: string) =>
  (JSON.parse(draftRow(w, id).data) as { _sync: { readFails?: number; problem?: unknown } })._sync;

/** One more upload attempt: waits out the retry delay (the first one, the 5 s edit wait). */
async function attempt(w: World, ms = 30 * SEC) {
  await w.clock.advance(ms);
  await w.settle();
}

test('an unreadable blob retries four times, then the fifth failure shows the problem and retries stop', () =>
  inWorld(
    async w => {
      const d = drafts(w).set(next(), { fields: withFile(w) }).draft;
      w.blobReads.fail = new Error('EIO');
      await attempt(w, 5 * SEC);
      for (let i = 2; i <= 4; i++) await attempt(w);
      assert.equal(readFails(w, d.id).readFails, 4);
      assert.equal(readFails(w, d.id).problem, undefined, 'still retrying');
      assert.equal(w.events('draft.sync_failed').length, 4, 'every failure is logged');
      await attempt(w);
      assert.equal(w.blobReads.calls.length, 5);
      assert.equal(drafts(w).get([d.id]).list[0].sync, 'failed', 'the visible problem');
      await attempt(w);
      await attempt(w, 10 * 60 * SEC);
      assert.equal(w.blobReads.calls.length, 5, 'no more retries');
      assert.equal(w.remoteDrafts.saves.length, 0);
    },
    { drafts: true },
  ));

test('a successful read resets the failed-read count', () =>
  inWorld(
    async w => {
      const d = drafts(w).set(next(), { fields: withFile(w) }).draft;
      w.blobReads.fail = new Error('EIO');
      await attempt(w, 5 * SEC);
      await attempt(w);
      assert.equal(readFails(w, d.id).readFails, 2);
      w.blobReads.fail = undefined;
      await attempt(w);
      assert.equal(w.remoteDrafts.saves.length, 1);
      assert.equal(readFails(w, d.id).readFails, undefined);
    },
    { drafts: true },
  ));

test('an edit resets the failed-read count', () =>
  inWorld(
    async w => {
      const d = drafts(w).set(next(), { fields: withFile(w) }).draft;
      w.blobReads.fail = new Error('EIO');
      await attempt(w, 5 * SEC);
      await attempt(w);
      assert.equal(readFails(w, d.id).readFails, 2);
      drafts(w).set(next(), {
        id: d.id,
        baseRevision: d.revision,
        fields: withFile(w, { subject: 'Edited' }),
      });
      assert.equal(readFails(w, d.id).readFails, undefined);
    },
    { drafts: true },
  ));

// ---------------------------------------------------------------- review round: no gap before the upload's mark

/** Records whether the upload's mark (`uploading`) was ever committed while a send pinned the draft. */
function watchMarks(w: World) {
  const seen = { marks: 0, whileLive: 0 };
  w.faults.push(input => {
    const marks = input.writes.some(
      x => x.kind === 'draft' && 'patch' in x && !!(x.patch as { uploading?: unknown }).uploading,
    );
    if (!marks) return false;
    seen.marks++;
    const live = w.first.store.read(q =>
      q.get("SELECT 1 FROM submissions WHERE state NOT IN ('sent', 'cancelled')"),
    );
    if (live) seen.whileLive++;
    return false;
  });
  return seen;
}

for (const order of ['upload first', 'send first'] as const)
  test(`reads ending in the same tick (${order}): the upload is never marked while a send pins the draft`, () =>
    inWorld(
      async w => {
        const d = drafts(w).set(next(), { fields: withFile(w) }).draft;
        const g = gate();
        w.blobReads.hold = g.wait;
        const send = () => w.first.outbox.service.set(next(), sendAction(d.id, d.revision));
        const early = order === 'send first' ? send() : undefined;
        await w.clock.advance(5 * SEC);
        const sending = early ?? send();
        assert.equal(w.blobReads.calls.length, 2, 'both are reading');
        w.blobReads.hold = undefined;
        const seen = watchMarks(w);
        g.open();
        assert.equal((await sending).submission.state, 'queued');
        await w.settle();
        assert.equal(seen.whileLive, 0, 'no mark under a live send');
        assert.equal(w.remoteDrafts.saves.length, seen.marks, 'every upload was marked first');
      },
      { drafts: true },
    ));

// ---------------------------------------------------------------- review round 2: a failing read of a draft that went away

const syncMeta = (w: World, id: string) => {
  const row = w.first.store.read(q =>
    q.get<{ data: string }>('SELECT data FROM drafts WHERE id = ?', id),
  );
  return row && (JSON.parse(row.data) as { _sync: Record<string, unknown> })._sync;
};

const rawData = (w: World, id: string) =>
  w.first.store.read(q => q.get<{ data: string }>('SELECT data FROM drafts WHERE id = ?', id))
    ?.data;

/** A synced draft edited here, its upload's read held open (and failing once released, or hanging until the limit). */
async function failingUpload(w: World, how: 'rejects' | 'hangs') {
  const d = drafts(w).set(next(), { fields: withFile(w) }).draft;
  await attempt(w, 5 * SEC);
  assert.equal(w.remoteDrafts.saves.length, 1, 'the first copy is up');
  const edited = drafts(w).set(next(), {
    id: d.id,
    baseRevision: d.revision,
    fields: withFile(w, { subject: 'Edited' }),
  }).draft;
  const g = gate();
  w.blobReads.hold = g.wait;
  if (how === 'rejects') w.blobReads.fail = new Error('EIO');
  await w.clock.advance(5 * SEC);
  w.blobReads.hold = undefined;
  assert.equal(w.blobReads.calls.length, 2, 'the second upload is reading');
  /** Ends the read: released to fail, or left hanging past the limit. */
  const finish = async () => {
    if (how === 'rejects') g.open();
    else await w.clock.advance(BLOB_READ_LIMIT_MS);
    await w.settle();
    w.blobReads.fail = undefined;
  };
  return { draft: edited, finish };
}

/** A normal draft created afterwards syncs: the drafts timer is not held by the one that went away. */
async function anotherSyncs(w: World) {
  const before = w.remoteDrafts.saves.length;
  const other = drafts(w).set(next(), { fields: fields({ subject: 'Another' }) }).draft;
  await attempt(w, 5 * SEC);
  assert.equal(w.remoteDrafts.saves.length, before + 1, 'another draft uploads');
  assert.equal(draftRow(w, other.id).synced_revision, other.revision);
}

for (const how of ['rejects', 'hangs'] as const)
  test(`a draft discarded while its read fails (${how}): nothing is written on the hidden row, the discard completes`, () =>
    inWorld(
      async w => {
        const { draft, finish } = await failingUpload(w, how);
        const removal = gate();
        w.remoteDrafts.removeScript.push({ wait: removal.wait });
        drafts(w).destroy(next(), draft.id);
        const hidden = rawData(w, draft.id);
        assert.equal(syncMeta(w, draft.id)?.removing, true, 'hidden while its copy is removed');
        await finish();
        assert.equal(rawData(w, draft.id), hidden, 'the failed read wrote nothing');
        assert.equal(syncMeta(w, draft.id)?.dueAt, undefined);
        assert.equal(syncMeta(w, draft.id)?.readFails, undefined);
        assert.equal(w.events('draft.sync_failed').length, 1, 'the failure is still logged');
        // Past the retry wait a failed read would have asked for: the timer has nothing stale to fire.
        await attempt(w, 31 * SEC);
        const due = await w.first.sources.get('drafts')!.next();
        assert.ok(
          due === undefined || due > w.clock.now(),
          `the drafts timer is not held (${due})`,
        );
        removal.open();
        await attempt(w, 1);
        assert.equal(rawData(w, draft.id), undefined, 'the discard completed');
        await anotherSyncs(w);
      },
      { drafts: true },
    ));

test('the copy removed on another device while the read fails: the failed read writes nothing', () =>
  inWorld(
    async w => {
      const { draft, finish } = await failingUpload(w, 'rejects');
      const r = w.first.store.read(q =>
        q.get<{ remote_draft_id: string; remote_message_id: string; remote_internet_id: string }>(
          'SELECT remote_draft_id, remote_message_id, remote_internet_id FROM drafts WHERE id = ?',
          draft.id,
        ),
      )!;
      w.first.store.commit({
        opId: next(),
        origin: 'sync',
        writes: [
          {
            ...copyWrite({
              remoteDraftId: r.remote_draft_id,
              remoteMessageId: 'gone-msg',
              internetId: r.remote_internet_id,
              changedAt: w.clock.now(),
            }),
            removed: true,
          } as never,
        ],
      });
      const after = rawData(w, draft.id);
      await finish();
      assert.equal(rawData(w, draft.id), after, 'the failed read wrote nothing');
      assert.equal(syncMeta(w, draft.id)?.readFails, undefined);
      await anotherSyncs(w);
    },
    { drafts: true },
  ));

test('a draft a send pins while its upload read fails: the failed read writes nothing', () =>
  inWorld(
    async w => {
      const { draft, finish } = await failingUpload(w, 'rejects');
      // The upload's read took its failure when it started; the send's own read works.
      w.blobReads.fail = undefined;
      const sent = await w.send(w.first, draft.id, { revision: draft.revision });
      const pinned = rawData(w, draft.id);
      await finish();
      assert.equal(rawData(w, draft.id), pinned, 'the failed read wrote nothing');
      assert.equal(syncMeta(w, draft.id)?.readFails, undefined);
      assert.equal(w.get(sent.id).state, 'queued');
      await anotherSyncs(w);
    },
    { drafts: true },
  ));

test('backstop: a meta write never gives a hidden (removing) draft a due time or a failed-read count', () =>
  inWorld(
    async w => {
      const d = drafts(w).set(next(), { fields: fields() }).draft;
      await attempt(w, 5 * SEC);
      const removal = gate();
      w.remoteDrafts.removeScript.push({ wait: removal.wait });
      drafts(w).destroy(next(), d.id);
      const hidden = rawData(w, d.id);
      assert.equal(syncMeta(w, d.id)?.removing, true);
      for (const patch of [{ dueAt: w.clock.now() }, { readFails: 1 }])
        assert.throws(() =>
          w.first.store.commit({
            opId: next(),
            origin: 'system',
            writes: [{ kind: 'draft', op: 'meta', id: d.id, patch } as never],
          }),
        );
      assert.equal(rawData(w, d.id), hidden);
      removal.open();
      await attempt(w, 1);
    },
    { drafts: true },
  ));

test('loadBlobs: a read that REJECTS after the limit raises no unhandled rejection, and the limit timer is disarmed on success', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const clock = fakeClock(0);
    let reject!: (error: Error) => void;
    const hung = new Promise<Uint8Array>((_, no) => {
      reject = no;
    });
    const late = loadBlobs({ get: () => hung }, ['b1'], clock);
    const failed = assert.rejects(
      late,
      (e: unknown) => e instanceof ContractError && e.type === 'unavailable',
    );
    await clock.advance(BLOB_READ_LIMIT_MS);
    await failed;
    reject(new Error('the host failed after the limit'));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, [], 'abandoning the read left no unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('loadBlobs: a load that succeeds disarms its limit timer', async () => {
  const clock = fakeClock(0);
  const before = clock.pending?.() ?? 0;
  const map = await loadBlobs({ get: async () => new Uint8Array([1, 2, 3]) }, ['b1'], clock);
  assert.equal(map.size, 1);
  assert.equal(clock.pending?.() ?? 0, before, 'no timer is left armed');
});
