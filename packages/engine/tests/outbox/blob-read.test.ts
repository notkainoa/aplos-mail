import test from 'node:test';
import assert from 'node:assert/strict';
import type { Draft, DraftFields, SubmissionAction } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { loadBlobs } from '../../src/outbox/blob-read';
import { buildMime } from '../../src/outbox/mime';
import { copyWrite, fields, gate, inWorld, SEC, syncBlobSource, type World } from './helpers';

/**
 * Blob package 4: the outbox reads attachment bytes asynchronously. A send whose read is held open must never pin a
 * stale draft, never queue twice, never queue a message missing an attachment, and must leave every other command
 * exactly as it was. The draft upload must upload only the content its bytes were read for.
 */

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
  const load = loadBlobs(source, ['a', 'b', 'a', 'gone']);
  await Promise.resolve();
  assert.deepEqual(started, ['a', 'b', 'gone'], 'every read started before any finished');
  g.open();
  const map = await load;
  assert.deepEqual([...map.keys()], ['a', 'b']);
  assert.notEqual(await loadBlobs(source, ['a']), map, 'a fresh map per load');
});

test('loadBlobs: a read that rejects or throws fails the whole load as unavailable', async () => {
  const rejects = {
    get: async (id: string) => (id === 'bad' ? Promise.reject(new Error('EIO')) : enc(id)),
  };
  assert.equal(await rejected(loadBlobs(rejects, ['ok', 'bad']), 'unavailable'), UNREADABLE);
  const throws = {
    get: (id: string): Promise<Uint8Array | undefined> => {
      if (id === 'bad') throw new Error('EBADF');
      return Promise.resolve(enc(id));
    },
  };
  assert.equal(await rejected(loadBlobs(throws, ['bad']), 'unavailable'), UNREADABLE);
  assert.equal((await loadBlobs(undefined, ['a'])).size, 0, 'no source: every blob is gone');
  assert.equal(
    (
      await loadBlobs(
        syncBlobSource(() => enc('x')),
        ['a'],
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
