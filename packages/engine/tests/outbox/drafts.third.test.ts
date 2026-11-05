import test from 'node:test';
import assert from 'node:assert/strict';
import type { Draft, DraftFields } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { handlers } from '../../src/methods/draft';
import type { Caller, MethodContext } from '../../src/methods/types';
import type { CommitInput } from '../../src/store';
import { ACCOUNT, copyWrite, fields, gate, inWorld, MIN, SEC, type World } from './helpers';

/**
 * Time-3 third review round: a conflicted draft cannot be sent, a gone copy is forgotten before it is hidden, a late
 * upload result cannot undo a choice, a draft whose text never arrived is neither edited nor sent, Draft/destroy needs
 * `send` to cancel a send, and a copy that omits anything is not marked as the draft.
 */

const world = (fn: (w: World) => Promise<void> | void) => inWorld(fn, { drafts: true });

let ops = 0;
const next = () => `third-op-${++ops}`;

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

/** Asserts a `Submission/set` refusal (a rejected promise) by contract error type, and returns its sentence. */
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
  synced_revision: number | null;
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
  dueAt?: number;
  incomplete?: true;
  conflict?: { theirsRevision: number; complete?: boolean; theirsMessageId?: string };
}

const syncOf = (w: World, id: string): Sync => {
  const data = w.first.store.read(q =>
    q.get<{ data: string }>('SELECT data FROM drafts WHERE id = ?', id),
  )!.data;
  return (JSON.parse(data) as { _sync: Sync })._sync;
};

const header = (mime: Uint8Array, name: string) =>
  new RegExp(`^${name}: (.*)$`, 'm').exec(new TextDecoder().decode(mime))?.[1];

const THEIRS_ID = '<theirs@phone.example>';

/** What history reports when another device saves (or removes) a draft. */
function phone(
  w: World,
  remoteDraftId: string,
  messageId: string,
  content: { subject: string; html?: string; removed?: true; internetId?: string } = {
    subject: 'From the phone',
  },
) {
  w.first.store.commit({
    opId: `third-phone-${++ops}`,
    origin: 'sync',
    writes: [
      {
        kind: 'remoteDraft',
        accountId: ACCOUNT,
        remoteDraftId,
        remoteMessageId: messageId,
        changedAt: w.clock.now(),
        ...(content.internetId !== undefined ? { internetId: content.internetId } : {}),
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

async function synced(w: World, f: DraftFields = fields()) {
  const d = create(w, f);
  await wait(w, 5 * SEC);
  const r = row(w, d.id)!;
  assert.equal(r.synced_revision, d.revision, 'synced at its revision');
  return {
    draft: read(w, d.id),
    remoteDraftId: r.remote_draft_id!,
    messageId: r.remote_message_id!,
    internetId: r.remote_internet_id!,
  };
}

/** A synced draft edited here and then edited on the phone: the conflict state, with the phone's version delivered. */
async function conflicted(w: World, theirs: { html?: string; internetId?: string }) {
  const s = await synced(w);
  const mine = edit(w, s.draft, fields({ subject: 'Mine' }));
  const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
  phone(w, s.remoteDraftId, theirId, { subject: 'Theirs', ...theirs });
  assert.ok(read(w, s.draft.id).conflict, 'a choice is needed');
  return { ...s, mine, theirId };
}

const attachment = (w: World, name = 'notes.txt', blob = true) => {
  if (blob) w.blobs.set(`blob-${name}`, new TextEncoder().encode('hello'));
  return { id: `att-${name}`, name, mime: 'text/plain', size: 5, blobId: `blob-${name}` };
};

// ---------------------------------------------------------------- 3: a gone copy is forgotten before it is hidden

test('3: a gone copy reported by history is forgotten, so discarding the draft deletes nothing at the provider', () =>
  world(async w => {
    const s = await synced(w);
    edit(w, s.draft, fields({ subject: 'Mine' }));
    phone(w, s.remoteDraftId, 'pm-gone', { subject: 'x', removed: true });
    assert.equal(read(w, s.draft.id).conflict?.theirsRevision, 1, 'the choice is raised');
    const r = row(w, s.draft.id)!;
    assert.equal(r.remote_draft_id, null, 'the id now names a sent message on some providers');
    assert.equal(r.remote_message_id, null);
    service(w).destroy(next(), s.draft.id);
    await wait(w, 5 * MIN);
    assert.deepEqual(w.remoteDrafts.removeAttempts, [], 'nothing asked to delete the remote id');
    assert.equal(count(w), 0, 'the row goes at once');
  }));

test('3: a gone copy reported by an upload result is forgotten too, and keep mine then creates a new copy', () =>
  world(async w => {
    const s = await synced(w);
    w.remoteDrafts.remote.delete(s.remoteDraftId);
    edit(w, s.draft, fields({ subject: 'Mine' }), true);
    await wait(w, 1);
    assert.ok(read(w, s.draft.id).conflict, 'the choice is raised');
    assert.equal(row(w, s.draft.id)!.remote_draft_id, null);
    const other = create(w, fields({ subject: 'Other' }));
    service(w).destroy(next(), s.draft.id);
    await wait(w, 5 * MIN);
    assert.deepEqual(w.remoteDrafts.removeAttempts, [], 'no removal of the old id');
    assert.equal(read(w, other.id).subject, 'Other');
  }));

test('3: keep mine on a gone copy makes a fresh remote draft', () =>
  world(async w => {
    const s = await synced(w);
    edit(w, s.draft, fields({ subject: 'Mine' }));
    phone(w, s.remoteDraftId, 'pm-gone', { subject: 'x', removed: true });
    service(w).resolve(next(), s.draft.id, 'keepMine');
    await wait(w, 40 * SEC);
    const upload = w.remoteDrafts.saves.at(-1)!;
    assert.equal(upload.remoteDraftId, undefined, 'a create, not a replace of the gone id');
    assert.equal(read(w, s.draft.id).sync, 'synced');
  }));

// ---------------------------------------------------------------- 2: a conflicted draft is not sent

test('2: a draft with a version from another device waiting is not sent', () =>
  world(async w => {
    const s = await conflicted(w, { html: '<p>Their body</p>', internetId: THEIRS_ID });
    const sentence = await rejected(
      () => w.send(w.first, s.draft.id, { revision: read(w, s.draft.id).revision }),
      'stateMismatch',
    );
    assert.match(sentence, /other device/);
    await wait(w, 5 * MIN);
    assert.deepEqual(w.remoteDrafts.removeAttempts, [], 'their copy is untouched');
    assert.ok(w.remoteDrafts.remote.has(s.remoteDraftId));
    // After the choice the send goes.
    service(w).resolve(next(), s.draft.id, 'keepMine');
    await w.send(w.first, s.draft.id, { revision: read(w, s.draft.id).revision });
  }));

test('2: a conflict that lands between the send check and its commit stops the send', () =>
  world(async w => {
    const s = await synced(w);
    const mine = edit(w, s.draft, fields({ subject: 'Mine' }));
    let fired = false;
    w.faults.push((input: CommitInput) => {
      if (fired || input.writes[0]?.kind !== 'submission') return false;
      fired = true;
      const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
      phone(w, s.remoteDraftId, theirId, { subject: 'Theirs', html: '<p>Their body</p>' });
      return false;
    });
    await rejected(() => w.send(w.first, s.draft.id, { revision: mine.revision }), 'stateMismatch');
    assert.ok(fired, 'the conflict arrived inside the window');
    assert.equal(w.server.payloads.length, 0);
    assert.ok(read(w, s.draft.id).conflict);
  }));

// ---------------------------------------------------------------- 1: a draft whose text never arrived

test('1: a draft written on another device without its text is not sent until the text arrives (N1: an edit forks)', () =>
  world(async w => {
    phone(w, 'phone-1', 'pm-1', { subject: 'Written on the phone' });
    const id = `${ACCOUNT}:phone-1`;
    const d = read(w, id);
    assert.equal(syncOf(w, id).incomplete, true);
    await rejected(() => w.send(w.first, id, { revision: d.revision }), 'unavailable');
    await wait(w, 30 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 0, 'nothing of the snippet was uploaded');
    // The text arrives (the same copy, now with its body).
    phone(w, 'phone-1', 'pm-1', { subject: 'Written on the phone', html: '<p>The full text</p>' });
    const full = read(w, id);
    assert.equal(full.html, '<p>The full text</p>');
    assert.equal(syncOf(w, id).incomplete, undefined);
    const two = edit(w, full, fields({ subject: 'Edited on the Mac', html: full.html }));
    assert.equal(two.subject, 'Edited on the Mac');
  }));

test('1: a newer phone version that arrives without its text makes the draft incomplete again', () =>
  world(async w => {
    phone(w, 'phone-1', 'pm-1', { subject: 'One', html: '<p>Body one</p>' });
    const id = `${ACCOUNT}:phone-1`;
    assert.equal(syncOf(w, id).incomplete, undefined);
    phone(w, 'phone-1', 'pm-2', { subject: 'Two' });
    assert.equal(syncOf(w, id).incomplete, true);
    const d = read(w, id);
    await rejected(() => w.send(w.first, id, { revision: d.revision }), 'unavailable');
  }));

// ---------------------------------------------------------------- 4: a late upload result cannot undo a choice

test('4: an upload that returns a conflict after keep mine does not bring the conflict back', () =>
  world(async w => {
    const s = await synced(w);
    const first = w.remoteDrafts.saves.length;
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    edit(w, s.draft, fields({ subject: 'Mine' }), true);
    await wait(w, 1);
    assert.equal(w.remoteDrafts.saves.length, first + 1, 'the upload is in flight');
    const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    phone(w, s.remoteDraftId, theirId, {
      subject: 'Theirs',
      html: '<p>Their body</p>',
      internetId: THEIRS_ID,
    });
    assert.ok(read(w, s.draft.id).conflict, 'history raised the choice');
    service(w).resolve(next(), s.draft.id, 'keepMine');
    g.open();
    await w.settle();
    assert.equal(read(w, s.draft.id).conflict, undefined, 'the old result did not undo the choice');
    await wait(w, 40 * SEC);
    assert.equal(w.remoteDrafts.saves.length, first + 2, 'keep mine uploaded once');
    assert.equal(header(w.remoteDrafts.saves.at(-1)!.mime, 'Subject'), 'Mine');
    assert.equal(read(w, s.draft.id).sync, 'synced');
  }));

test('4: an upload that returns a conflict after history raised one keeps their version, so take theirs still works', () =>
  world(async w => {
    const s = await synced(w);
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    edit(w, s.draft, fields({ subject: 'Mine' }), true);
    await wait(w, 1);
    const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    phone(w, s.remoteDraftId, theirId, {
      subject: 'Theirs',
      html: '<p>Their body</p>',
      internetId: THEIRS_ID,
    });
    g.open();
    await w.settle();
    const c = syncOf(w, s.draft.id).conflict;
    assert.equal(c?.complete, true, 'their version is still there');
    const out = service(w).resolve(next(), s.draft.id, 'takeTheirs');
    assert.equal(out.draft.html, '<p>Their body</p>');
  }));

test("4: a conflict from an upload that history already described is merged into history's", () =>
  world(async w => {
    const s = await synced(w);
    w.remoteDrafts.script.push({ result: 'conflictBare' });
    edit(w, s.draft, fields({ subject: 'Mine' }), true);
    await wait(w, 1);
    assert.equal(syncOf(w, s.draft.id).conflict?.complete, undefined, 'only the bare conflict');
    const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    // Their version arrives afterwards: it fills the conflict in instead of being skipped.
    phone(w, s.remoteDraftId, theirId, { subject: 'Theirs', html: '<p>Their body</p>' });
    assert.equal(syncOf(w, s.draft.id).conflict?.complete, true);
    const out = service(w).resolve(next(), s.draft.id, 'takeTheirs');
    assert.equal(out.draft.html, '<p>Their body</p>');
  }));

// ---------------------------------------------------------------- 5: Draft/destroy needs send to cancel a send

const caller = (scopes: Caller['scopes']): Caller => ({
  kind: 'listener',
  via: 'http',
  clientId: 'c1',
  scopes,
});

const destroyAs = (w: World, who: Caller, id: string) =>
  handlers['Draft/destroy']({ opId: next(), id }, {
    caller: who,
    services: { draftBox: service(w) },
  } as unknown as MethodContext);

test('5: a caller with only draft cannot cancel the owner’s queued send by discarding the draft', () =>
  world(async w => {
    const d = create(w);
    const sub = await w.send(w.first, d.id, { revision: d.revision });
    try {
      destroyAs(w, caller(['draft']), d.id);
      assert.fail('expected forbidden');
    } catch (error) {
      assert.ok(error instanceof ContractError);
      assert.equal(error.type, 'forbidden');
    }
    assert.equal(w.get(sub.id).state, 'queued', 'the send is still queued');
    assert.equal(service(w).get([d.id]).notFound.length, 0, 'the draft is still there');
    // With send as well the discard cancels it.
    destroyAs(w, caller(['draft', 'send']), d.id);
    assert.equal(w.get(sub.id).state, 'cancelled');
    assert.equal(service(w).get([d.id]).notFound.length, 1);
  }));

test('5: a caller with only draft still discards a draft that has no send', () =>
  world(async w => {
    const d = create(w);
    destroyAs(w, caller(['draft']), d.id);
    assert.equal(service(w).get([d.id]).notFound.length, 1);
  }));

// ---------------------------------------------------------------- 6: a copy that omits anything is not the draft

test('6: a copy uploaded without an attachment it could not read is not marked as the draft', () =>
  world(async w => {
    const d = create(w, fields({ attachments: [attachment(w, 'lost.txt', false)] }));
    await wait(w, 5 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 1, 'the copy was uploaded');
    assert.doesNotMatch(new TextDecoder().decode(w.remoteDrafts.saves[0].mime), /lost\.txt/);
    const r = row(w, d.id)!;
    assert.ok(r.remote_draft_id, 'the copy is known (it is deleted with the draft)');
    assert.equal(r.synced_revision, null, 'but it is not this revision');
    assert.notEqual(read(w, d.id).sync, 'synced');
  }));

test('6: taking their version (a copy that has no attachments) does not bring my removed attachment back', () =>
  world(async w => {
    const s = await synced(w, fields({ attachments: [attachment(w)] }));
    edit(w, s.draft, fields({ subject: 'Mine', attachments: [attachment(w)] }));
    const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    phone(w, s.remoteDraftId, theirId, {
      subject: 'Theirs',
      html: '<p>Their body</p>',
      internetId: THEIRS_ID,
    });
    service(w).resolve(next(), s.draft.id, 'takeTheirs');
    const r = row(w, s.draft.id)!;
    assert.equal(r.remote_internet_id, THEIRS_ID);
    assert.deepEqual(
      read(w, s.draft.id).attachments,
      [],
      'the file the phone removed stays removed',
    );
    assert.equal(r.synced_revision, r.revision, 'and the draft is exactly their copy');
  }));

test('6: a phone edit of a draft with my attachments is a conflict, never a silent replace that puts them back', () =>
  world(async w => {
    const s = await synced(w, fields({ attachments: [attachment(w)] }));
    phone(w, s.remoteDraftId, 'pm-2', {
      subject: 'Phone',
      html: '<p>Phone body</p>',
      internetId: THEIRS_ID,
    });
    const r = row(w, s.draft.id)!;
    assert.equal(r.revision, s.draft.revision, 'not replaced');
    assert.equal(r.remote_message_id, s.messageId, 'the base did not move');
    assert.ok(read(w, s.draft.id).conflict, 'the owner chooses');
  }));

// ---------------------------------------------------------------- 7: Bcc stays out of draft copies

test('7: the draft copy carries no Bcc, and a draft with Bcc is sent as the pinned MIME, never as the copy', () =>
  world(async w => {
    const bcc = [{ address: 'quiet@mail.example' }];
    const s = await synced(w, fields({ bcc }));
    assert.equal(header(w.remoteDrafts.saves[0].mime, 'Bcc'), undefined, 'no Bcc in the copy');
    const sub = await w.send(w.first, s.draft.id, { revision: s.draft.revision });
    await wait(w, 15 * SEC);
    assert.equal(w.get(sub.id).state, 'sent');
    const payload = w.server.payloads[0];
    assert.equal(payload.remoteDraftId, undefined, 'the copy would leave without its Bcc');
    assert.deepEqual(w.server.consumed, []);
    assert.ok(payload.envelope.rcpt.includes('quiet@mail.example'), 'the envelope has the Bcc');
  }));

test('7: a Bcc-only change is still saved and uploaded', () =>
  world(async w => {
    const s = await synced(w);
    edit(w, s.draft, fields({ bcc: [{ address: 'quiet@mail.example' }] }));
    await wait(w, 5 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 2);
    assert.equal(read(w, s.draft.id).bcc[0].address, 'quiet@mail.example');
  }));

// ---------------------------------------------------------------- 8: an unanswered create, then an edit

test('8: a create that got no answer, then an edit: the first copy is recognised as ours when its content is, shown otherwise', () =>
  world(async w => {
    w.remoteDrafts.script.push({ result: 'landedLost' });
    const d = create(w);
    await wait(w, 5 * SEC);
    const firstId = w.remoteDrafts.saves[0].internetId;
    assert.equal(w.remoteDrafts.remote.size, 1, 'the first create landed');
    edit(w, d, fields({ subject: 'Edited' }));
    await wait(w, 6 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 2, 'the edit uploaded before history reported');
    const [remoteDraftId, copy] = [...w.remoteDrafts.remote.entries()][0];
    // The report carries the first revision's content: it is our own first copy, nothing to show.
    w.first.store.commit({
      opId: 'third-own-first-copy',
      origin: 'sync',
      writes: [
        copyWrite({
          remoteDraftId,
          remoteMessageId: copy.messageId,
          internetId: firstId,
          changedAt: w.clock.now(),
        }),
      ],
    });
    assert.equal(
      service(w).get([`${ACCOUNT}:${remoteDraftId}`]).notFound.length,
      1,
      'no phantom draft from our own first copy',
    );
  }));

test('8: the same report with no body cannot be proven ours, so it is shown (never hidden, never replaced)', () =>
  world(async w => {
    w.remoteDrafts.script.push({ result: 'landedLost' });
    const d = create(w);
    await wait(w, 5 * SEC);
    const firstId = w.remoteDrafts.saves[0].internetId;
    edit(w, d, fields({ subject: 'Edited' }));
    await wait(w, 6 * SEC);
    const [remoteDraftId, copy] = [...w.remoteDrafts.remote.entries()][0];
    phone(w, remoteDraftId, copy.messageId, { subject: 'echo', internetId: firstId });
    assert.equal(service(w).get([`${ACCOUNT}:${remoteDraftId}`]).notFound.length, 0, 'shown');
  }));

// ---------------------------------------------------------------- 9: keep mine after a conflict that named no copy

test('9: keep mine after a conflict that named no remote message id uploads without a stale base', () =>
  world(async w => {
    const s = await synced(w);
    w.remoteDrafts.phoneEdit(s.remoteDraftId);
    w.remoteDrafts.script.push({ result: 'conflictBare' });
    edit(w, s.draft, fields({ subject: 'Mine' }), true);
    await wait(w, 1);
    assert.ok(read(w, s.draft.id).conflict);
    service(w).resolve(next(), s.draft.id, 'keepMine');
    await wait(w, 40 * SEC);
    const upload = w.remoteDrafts.saves.at(-1)!;
    assert.equal(upload.baseRemoteMessageId, undefined, 'the old base is not asserted again');
    assert.equal(read(w, s.draft.id).conflict, undefined);
    assert.equal(read(w, s.draft.id).sync, 'synced');
  }));

// ---------------------------------------------------------------- 10: a discard between the send check and its commit

test('10: a draft discarded between the send check and its commit is not sent', () =>
  world(async w => {
    const s = await synced(w);
    let fired = false;
    w.faults.push((input: CommitInput) => {
      if (fired || input.writes[0]?.kind !== 'submission') return false;
      fired = true;
      service(w).destroy(next(), s.draft.id);
      return false;
    });
    await rejected(() => w.send(w.first, s.draft.id, { revision: s.draft.revision }), 'notFound');
    assert.ok(fired);
    assert.equal(w.server.payloads.length, 0);
  }));
