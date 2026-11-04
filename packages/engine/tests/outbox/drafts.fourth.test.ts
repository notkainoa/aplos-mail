import test from 'node:test';
import assert from 'node:assert/strict';
import type { Draft, DraftFields } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { ACCOUNT, fields, gate, inWorld, MIN, SEC, type World } from './helpers';

/**
 * Time-3 fourth review round (the Integrator's Opus re-check): a copy that may hold the other device's version, or that
 * is a sent message, is never deleted (N2, N3, N4), and a draft whose text never arrived is honest about it (N1).
 */

const world = (fn: (w: World) => Promise<void> | void) => inWorld(fn, { drafts: true });

let ops = 0;
const next = () => `fourth-op-${++ops}`;

const service = (w: World) => w.first.outbox.drafts!;
const create = (w: World, f: DraftFields = fields()) => service(w).set(next(), { fields: f }).draft;
const edit = (w: World, d: Pick<Draft, 'id' | 'revision'>, f: DraftFields, close = false) =>
  service(w).set(next(), { id: d.id, baseRevision: d.revision, fields: f, close }).draft;

const read = (w: World, id: string): Draft => {
  const found = service(w).get([id]);
  assert.equal(found.notFound.length, 0, `draft ${id} exists`);
  return found.list[0];
};

const wait = async (w: World, ms: number) => {
  await w.clock.advance(ms);
  await w.settle();
};

function refused(fn: () => unknown, type: string): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ContractError, `a ContractError, got ${String(error)}`);
    assert.equal(error.type, type, error.message);
    return error.message;
  }
  assert.fail(`expected ${type}`);
}

/** `refused` for a refusal that arrives as a rejected promise. */
async function rejected(fn: () => Promise<unknown>, type: string): Promise<string> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof ContractError, `a ContractError, got ${String(error)}`);
    assert.equal(error.type, type, error.message);
    return error.message;
  }
  assert.fail(`expected ${type}`);
}

interface Row {
  id: string;
  revision: number;
  remote_draft_id: string | null;
  remote_message_id: string | null;
  remote_internet_id: string | null;
  origin: string;
  [k: string]: string | number | null;
}

const row = (w: World, id: string) =>
  w.first.store.read(q => q.get<Row>('SELECT * FROM drafts WHERE id = ?', id));

const count = (w: World) =>
  w.first.store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM drafts'))!.n;

interface Sync {
  incomplete?: true;
  conflict?: { theirsRevision: number; complete?: boolean; gone?: true; theirsMessageId?: string };
}

const syncOf = (w: World, id: string): Sync => {
  const data = w.first.store.read(q =>
    q.get<{ data: string }>('SELECT data FROM drafts WHERE id = ?', id),
  )!.data;
  return (JSON.parse(data) as { _sync: Sync })._sync;
};

let phones = 0;

/** What history reports when another device saves (or removes) a draft. */
function phone(
  w: World,
  remoteDraftId: string,
  messageId: string,
  content: { subject: string; html?: string; removed?: true } = { subject: 'From the phone' },
) {
  w.first.store.commit({
    opId: `fourth-phone-${++phones}`,
    origin: 'sync',
    writes: [
      {
        kind: 'remoteDraft',
        accountId: ACCOUNT,
        remoteDraftId,
        remoteMessageId: messageId,
        changedAt: w.clock.now(),
        ...(content.removed ? { removed: true as const } : {}),
        message: {
          remoteId: messageId,
          remoteThreadId: 'phone-thread',
          to: [{ address: 'jordan@mail.example' }],
          cc: [],
          subject: content.subject,
          snippet: 'only a snippet',
          date: w.clock.now(),
          internalDate: w.clock.now(),
          flags: { seen: true, flagged: false, draft: true, fromMe: true },
          ...(content.html !== undefined ? { html: content.html } : {}),
        },
      },
    ],
  });
}

async function synced(w: World) {
  const d = create(w);
  await wait(w, 5 * SEC);
  const r = row(w, d.id)!;
  assert.equal(r.synced_revision, d.revision, 'synced at its revision');
  return { draft: read(w, d.id), remoteDraftId: r.remote_draft_id! };
}

// ---------------------------------------------------------------- N2: a sent copy that history reports is forgotten

test('N2: a phone edit raises a snippet conflict, the phone then sends that draft: the copy is forgotten, so discarding deletes nothing', () =>
  world(async w => {
    const s = await synced(w);
    edit(w, s.draft, fields({ subject: 'Mine' }));
    const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    phone(w, s.remoteDraftId, theirId, { subject: 'Theirs' });
    assert.equal(syncOf(w, s.draft.id).conflict?.complete, false, 'only a snippet of theirs');
    // The phone sends it: history reports the same message id as removed.
    phone(w, s.remoteDraftId, theirId, { subject: 'Theirs', removed: true });
    const r = row(w, s.draft.id)!;
    assert.equal(r.remote_draft_id, null, 'the id now names a sent message on JMAP');
    assert.equal(syncOf(w, s.draft.id).conflict?.gone, true);
    service(w).destroy(next(), s.draft.id);
    await wait(w, 5 * MIN);
    assert.deepEqual(w.remoteDrafts.removeAttempts, [], 'nothing asked to delete the remote id');
    assert.equal(count(w), 0);
  }));

// ---------------------------------------------------------------- N3: a sent draft's copy that holds their version stays

test('N3: a send created while an upload is in flight whose upload answers conflict does not delete their copy after the send', () =>
  world(async w => {
    const s = await synced(w);
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    const mine = edit(w, s.draft, fields({ subject: 'Mine' }), true);
    await wait(w, 1);
    const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    await w.send(w.first, s.draft.id, { revision: mine.revision });
    g.open();
    await w.settle();
    assert.ok(read(w, s.draft.id).conflict, 'the upload raised the conflict under the live send');
    await wait(w, 30 * SEC);
    assert.equal(w.server.payloads.length, 1, 'the message was sent');
    assert.deepEqual(w.remoteDrafts.removeAttempts, [], 'their copy is not deleted');
    assert.equal(w.remoteDrafts.remote.get(s.remoteDraftId)?.messageId, theirId);
    assert.equal(count(w), 0, 'the sent draft is gone');
  }));

test('N3: a phone edit during the undo hold does not get its copy deleted after the send', () =>
  world(async w => {
    const s = await synced(w);
    const mine = edit(w, s.draft, fields({ subject: 'Mine' }));
    await w.send(w.first, s.draft.id, { revision: mine.revision });
    const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    phone(w, s.remoteDraftId, theirId, { subject: 'Theirs', html: '<p>Their body</p>' });
    await wait(w, 30 * SEC);
    assert.equal(w.server.payloads.length, 1, 'the message was sent');
    assert.deepEqual(w.remoteDrafts.removeAttempts, [], 'their newer copy is not deleted');
    // The sent draft is gone and the phone's newer version shows as the other device's own draft.
    assert.equal(count(w), 1);
    const shown = read(w, `${ACCOUNT}:${s.remoteDraftId}`);
    assert.equal(shown.subject, 'Theirs');
    assert.equal(shown.origin, 'remote');
  }));

test('N3: a phone edit during the undo hold, then the owner discards the draft: the phone’s only complete version is not deleted', () =>
  world(async w => {
    const s = await synced(w);
    const mine = edit(w, s.draft, fields({ subject: 'Mine' }));
    const sub = await w.send(w.first, s.draft.id, { revision: mine.revision });
    const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    phone(w, s.remoteDraftId, theirId, { subject: 'Theirs', html: '<p>Their body</p>' });
    assert.equal(
      syncOf(w, s.draft.id).conflict,
      undefined,
      'no conflict while the send holds the draft',
    );
    service(w).destroy(next(), s.draft.id);
    assert.equal(w.get(sub.id).state, 'cancelled', 'discarding cancelled the send');
    assert.equal(service(w).get([s.draft.id]).notFound.length, 1, 'gone from every reader');
    await wait(w, 5 * MIN);
    assert.equal(w.server.payloads.length, 0, 'nothing was sent');
    assert.deepEqual(w.remoteDrafts.removeAttempts, [], 'the phone’s copy is left alone');
    assert.equal(w.remoteDrafts.remote.get(s.remoteDraftId)?.messageId, theirId);
    // The discarded draft is gone for good; the phone's version shows as its own draft, and nothing waits to delete it.
    assert.equal(count(w), 1);
    assert.equal(read(w, `${ACCOUNT}:${s.remoteDraftId}`).subject, 'Theirs');
    assert.equal(row(w, `${ACCOUNT}:${s.remoteDraftId}`)?.origin, 'remote');
  }));

test('N3: history reports the draft removed (the phone sent it) during our live send: their sent message is not deleted after ours', () =>
  world(async w => {
    const s = await synced(w);
    const mine = edit(w, s.draft, fields({ subject: 'Mine' }));
    await w.send(w.first, s.draft.id, { revision: mine.revision });
    const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    phone(w, s.remoteDraftId, theirId, { subject: 'Theirs', removed: true });
    await wait(w, 30 * SEC);
    assert.equal(w.server.payloads.length, 1, 'the message was sent');
    assert.deepEqual(
      w.remoteDrafts.removeAttempts,
      [],
      'the id may now name the phone’s sent message',
    );
    assert.equal(count(w), 0);
  }));

test('N3: a sent draft whose copy nobody touched still has the copy deleted', () =>
  world(async w => {
    const s = await synced(w);
    const mine = edit(w, s.draft, fields({ subject: 'Mine' }));
    await w.send(w.first, s.draft.id, { revision: mine.revision });
    await wait(w, 30 * SEC);
    assert.equal(w.server.payloads.length, 1);
    assert.deepEqual(w.remoteDrafts.removeAttempts, [s.remoteDraftId]);
  }));

// ---------------------------------------------------------------- N4: a forgotten copy marks the conflict gone

test('N4: an upload that answers gone while a conflict is open marks the conflict gone, so keep mine has no stale base', () =>
  world(async w => {
    const s = await synced(w);
    edit(w, s.draft, fields({ subject: 'Mine' }));
    const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    phone(w, s.remoteDraftId, theirId, { subject: 'Theirs', html: '<p>Their body</p>' });
    const revision = read(w, s.draft.id).revision;
    // An upload that started before the conflict was raised answers gone.
    w.first.store.commit({
      opId: `fourth-meta-${++phones}`,
      origin: 'sync',
      writes: [
        {
          kind: 'draft',
          op: 'meta',
          id: s.draft.id,
          patch: { uploading: { internetId: '<n4@mail.example>', revision } },
        },
      ],
    });
    w.first.store.commit({
      opId: `fourth-gone-${++phones}`,
      origin: 'sync',
      writes: [
        {
          kind: 'draft',
          op: 'conflict',
          id: s.draft.id,
          revision,
          internetId: '<n4@mail.example>',
          gone: true,
          at: w.clock.now(),
        },
      ],
    });
    assert.equal(row(w, s.draft.id)!.remote_draft_id, null, 'the ids were forgotten');
    assert.equal(syncOf(w, s.draft.id).conflict?.gone, true, 'and the conflict says so');
    service(w).resolve(next(), s.draft.id, 'keepMine');
    assert.equal(row(w, s.draft.id)!.remote_message_id, null, 'no base for the next upload');
  }));

// ---------------------------------------------------------------- N1: a draft whose text never arrived

const PHONE_ID = `${ACCOUNT}:phone-1`;

test('N1: editing a draft whose text never arrived saves a new local draft and leaves the other device’s untouched', () =>
  world(async w => {
    phone(w, 'phone-1', 'pm-1', { subject: 'Written on the phone' });
    const d = read(w, PHONE_ID);
    const opId = next();
    const edited = fields({ subject: 'Edited on the Mac' });
    const out = service(w).set(opId, { id: PHONE_ID, baseRevision: d.revision, fields: edited });
    assert.notEqual(out.draft.id, PHONE_ID, 'a new id: the client switches to it');
    assert.equal(out.draft.subject, 'Edited on the Mac');
    assert.equal(out.draft.origin, 'local');
    const made = row(w, out.draft.id)!;
    assert.equal(made.remote_draft_id, null);
    assert.equal(made.remote_message_id, null);
    assert.equal(syncOf(w, out.draft.id).incomplete, undefined);
    // The phone's draft is as it was.
    const theirs = read(w, PHONE_ID);
    assert.equal(theirs.subject, 'Written on the phone');
    assert.equal(theirs.revision, d.revision);
    assert.equal(syncOf(w, PHONE_ID).incomplete, true);
    // The same op again answers with the same new draft.
    const again = service(w).set(opId, { id: PHONE_ID, baseRevision: d.revision, fields: edited });
    assert.equal(again.draft.id, out.draft.id);
    assert.equal(count(w), 2);
    // The new draft uploads as a copy of its own; nothing is written over the phone's.
    await wait(w, 30 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 1);
    assert.equal(w.remoteDrafts.saves[0].remoteDraftId, undefined, 'a create');
    // A save on a stale base is still refused.
    refused(
      () => service(w).set(next(), { id: PHONE_ID, baseRevision: d.revision + 5, fields: edited }),
      'stateMismatch',
    );
  }));

test('N1: sending a draft whose text never arrived says so honestly', () =>
  world(async w => {
    phone(w, 'phone-1', 'pm-1', { subject: 'Written on the phone' });
    const d = read(w, PHONE_ID);
    const sentence = await rejected(
      () => w.send(w.first, PHONE_ID, { revision: d.revision }),
      'unavailable',
    );
    assert.match(sentence, /written on another device/);
    assert.match(sentence, /isn't available here yet/);
    assert.doesNotMatch(sentence, /Try again in a moment/);
  }));

test('N1: a draft whose text never arrived reports incomplete: true, and loses the flag when the body arrives', () =>
  world(async w => {
    phone(w, 'phone-1', 'pm-1', { subject: 'Written on the phone' });
    assert.equal(read(w, PHONE_ID).incomplete, true);
    assert.equal(read(w, PHONE_ID).sync, 'synced');
    phone(w, 'phone-1', 'pm-1', { subject: 'Written on the phone', html: '<p>Full</p>' });
    assert.equal(read(w, PHONE_ID).incomplete, undefined);
    assert.equal(read(w, PHONE_ID).sync, 'synced');
    // A local draft never carries the flag.
    const mine = service(w).set(next(), { fields: fields({ subject: 'Mine' }) });
    assert.equal(mine.draft.incomplete, undefined);
  }));

test('N1: discarding a draft whose text never arrived forgets the local row and leaves the provider’s copy alone', () =>
  world(async w => {
    phone(w, 'phone-1', 'pm-1', { subject: 'Written on the phone' });
    w.remoteDrafts.remote.set('phone-1', { messageId: 'pm-1', internetId: 'x', revision: 1 });
    service(w).destroy(next(), PHONE_ID);
    assert.equal(service(w).get([PHONE_ID]).notFound.length, 1, 'gone from every reader');
    assert.equal(count(w), 0, 'no hidden row waiting to delete anything');
    await wait(w, 5 * MIN);
    assert.deepEqual(w.remoteDrafts.removeAttempts, [], 'the provider copy is not deleted');
    assert.ok(w.remoteDrafts.remote.has('phone-1'));
  }));

test('N1: discarding a draft whose text did arrive still deletes the provider’s copy', () =>
  world(async w => {
    phone(w, 'phone-1', 'pm-1', { subject: 'Written on the phone', html: '<p>Full</p>' });
    w.remoteDrafts.remote.set('phone-1', { messageId: 'pm-1', internetId: 'x', revision: 1 });
    service(w).destroy(next(), PHONE_ID);
    await wait(w, 5 * SEC);
    assert.deepEqual(w.remoteDrafts.removeAttempts, ['phone-1']);
  }));
