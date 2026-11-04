import test from 'node:test';
import assert from 'node:assert/strict';
import type { Draft, DraftFields } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import {
  ACCOUNT,
  assertIdsPerRevision,
  copyWrite,
  fields,
  inWorld,
  SEC,
  type World,
} from './helpers';

/** Time-3: local drafts with compare-and-set saves, serialized uploads, and the keep-mine/take-theirs/keep-both state. */

const world = (fn: (w: World) => Promise<void> | void) => inWorld(fn, { drafts: true });

let ops = 0;
const next = () => `draft-op-${++ops}`;

const service = (w: World, instance = w.first) => instance.outbox.drafts!;

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

const row = (w: World, id: string) =>
  w.first.store.read(q =>
    q.get<{
      revision: number;
      synced_revision: number | null;
      remote_draft_id: string | null;
      remote_message_id: string | null;
      remote_internet_id: string | null;
    }>('SELECT * FROM drafts WHERE id = ?', id),
  );

const header = (mime: Uint8Array, name: string) =>
  new RegExp(`^${name}: (.*)$`, 'm').exec(new TextDecoder().decode(mime))?.[1];

const changedFrames = async (w: World) => {
  await w.settle();
  return w.frames.filter(f => f.frame === 'Draft/changed');
};

/** What history reports when another device saves a draft. `html` is the body when the provider delivered it. */
function phone(
  w: World,
  remoteDraftId: string,
  messageId: string,
  content: { subject: string; html?: string; removed?: true } = { subject: 'From the phone' },
) {
  const message = {
    remoteId: messageId,
    remoteThreadId: 'phone-thread',
    to: [{ address: 'jordan@mail.example' }],
    cc: [],
    subject: content.subject,
    snippet: content.html ? 'body' : 'only a snippet',
    date: w.clock.now(),
    internalDate: w.clock.now(),
    flags: { seen: true, flagged: false, draft: true, fromMe: true },
    ...(content.html !== undefined ? { html: content.html } : {}),
  };
  w.first.store.commit({
    opId: `phone-${++ops}`,
    origin: 'sync',
    writes: [
      {
        kind: 'remoteDraft',
        accountId: ACCOUNT,
        remoteDraftId,
        remoteMessageId: messageId,
        changedAt: w.clock.now(),
        ...(content.removed ? { removed: true as const } : {}),
        message,
      },
    ],
  });
}

/** A draft made, left idle for 5 s and synced: the provider holds it. */
async function synced(w: World, f: DraftFields = fields()) {
  const d = create(w, f);
  await wait(w, 5 * SEC);
  const r = row(w, d.id)!;
  assert.equal(r.synced_revision, d.revision, 'synced at its revision');
  return {
    draft: read(w, d.id),
    remoteDraftId: r.remote_draft_id!,
    messageId: r.remote_message_id!,
  };
}

// ---------------------------------------------------------------- compare-and-set

test('two saves on one base: exactly one wins, the loser is told stateMismatch and the winner text survives', () =>
  world(async w => {
    const d = create(w);
    const a = service(w).set(next(), {
      id: d.id,
      baseRevision: 1,
      fields: fields({ subject: 'Winner' }),
    });
    assert.equal(a.draft.revision, 2);
    const message = refused(
      () =>
        service(w).set(next(), {
          id: d.id,
          baseRevision: 1,
          fields: fields({ subject: 'Loser' }),
        }),
      'stateMismatch',
    );
    assert.match(message, /changed in another window/);
    const now = read(w, d.id);
    assert.equal(now.subject, 'Winner');
    assert.equal(now.revision, 2);
  }));

test('two engines on one store save from one base: one commit wins, the other loses whole', () =>
  world(async w => {
    const second = w.open();
    const d = create(w);
    const results = [
      () =>
        service(w).set(next(), { id: d.id, baseRevision: 1, fields: fields({ subject: 'One' }) }),
      () =>
        service(w, second).set(next(), {
          id: d.id,
          baseRevision: 1,
          fields: fields({ subject: 'Two' }),
        }),
    ].map(run => {
      try {
        return run().draft;
      } catch (error) {
        assert.ok(error instanceof ContractError && error.type === 'stateMismatch');
        return undefined;
      }
    });
    assert.equal(results.filter(Boolean).length, 1, 'exactly one save won');
    const winner = results.find(Boolean)!;
    assert.equal(read(w, d.id).subject, winner.subject);
    assert.equal(read(w, d.id).revision, 2);
  }));

test('a replayed opId answers with the draft it made and changes nothing', () =>
  world(async w => {
    const first = service(w).set('op-fixed', { fields: fields() });
    const again = service(w).set('op-fixed', { fields: fields() });
    assert.equal(again.draft.id, first.draft.id);
    assert.equal(again.draft.revision, 1);
    const edited = service(w).set('op-edit', {
      id: first.draft.id,
      baseRevision: 1,
      fields: fields({ subject: 'Edited' }),
    });
    const replay = service(w).set('op-edit', {
      id: first.draft.id,
      baseRevision: 1,
      fields: fields({ subject: 'Edited' }),
    });
    assert.equal(replay.draft.revision, edited.draft.revision, 'no second bump');
  }));

test('saving the same content again is not a new revision', () =>
  world(async w => {
    const d = create(w);
    const same = edit(w, d, fields());
    assert.equal(same.revision, 1);
    assert.equal((await changedFrames(w)).length, 0);
  }));

// ---------------------------------------------------------------- the upload schedule

test('a draft is uploaded 5 s after the last change, not before, and every edit moves the wait', () =>
  world(async w => {
    const d = create(w);
    await wait(w, 4_900);
    assert.equal(w.remoteDrafts.saves.length, 0, 'not yet');
    const e = edit(w, d, fields({ subject: 'Lunch?' }));
    await wait(w, 4_900);
    assert.equal(w.remoteDrafts.saves.length, 0, 'the edit moved the wait');
    await wait(w, 200);
    assert.equal(w.remoteDrafts.saves.length, 1);
    assert.equal(w.remoteDrafts.saves[0].revision, e.revision);
    assert.equal(read(w, d.id).sync, 'synced');
    const r = row(w, d.id)!;
    assert.ok(r.remote_draft_id && r.remote_message_id && r.remote_internet_id);
    assert.equal(r.synced_revision, 2);
  }));

test('closing the editor uploads at once', () =>
  world(async w => {
    const d = create(w);
    edit(w, d, fields({ subject: 'Done' }), true);
    await w.settle();
    assert.equal(w.remoteDrafts.saves.length, 1, 'no 5 s wait on close');
    const d2 = create(w, fields({ subject: 'Second' }));
    w.first.outbox.closeDraft(d2.id);
    await w.settle();
    assert.equal(w.remoteDrafts.saves.length, 2);
    assert.equal(read(w, d2.id).sync, 'synced');
  }));

test('an empty draft is not uploaded', () =>
  world(async w => {
    const d = create(w, fields({ to: [], subject: '', html: '<p></p>' }));
    await wait(w, 10 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 0);
    assert.equal(read(w, d.id).sync, 'localOnly');
  }));

test('an unchanged content fingerprint skips the upload', () =>
  world(async w => {
    const s = await synced(w);
    assert.equal(w.remoteDrafts.saves.length, 1);
    // Edited and put back before the idle wait ends: the remote copy already holds this content.
    const b = edit(w, s.draft, fields({ subject: 'Different' }));
    await wait(w, 2 * SEC);
    edit(w, b, fields());
    await wait(w, 10 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 1, 'no upload for content the copy already holds');
    assert.equal(read(w, s.draft.id).sync, 'synced');
    assert.equal(read(w, s.draft.id).revision, 3);
  }));

test('a changed draft after a sync uploads again under its own Message-ID, never the previous revision id', () =>
  world(async w => {
    const s = await synced(w);
    edit(w, s.draft, fields({ subject: 'Second version' }));
    await wait(w, 5 * SEC);
    const [one, two] = w.remoteDrafts.saves;
    assert.notEqual(one.internetId, two.internetId, 'one Message-ID per revision');
    assert.equal(two.remoteDraftId, s.remoteDraftId, 'the same remote draft is replaced');
    assert.equal(two.baseRemoteMessageId, s.messageId, 'against the copy this device last wrote');
    assert.equal(header(two.mime, 'Message-ID'), two.internetId);
    assert.equal(header(two.mime, 'Subject'), 'Second version');
  }));

// ---------------------------------------------------------------- refused uploads never drop the draft

test('a paused upload waits for the end of the pause, keeps the draft and uploads once then', () =>
  world(async w => {
    const until = w.clock.now() + 60 * SEC;
    w.remoteDrafts.script.push({ result: 'paused', until });
    const d = create(w);
    await wait(w, 5 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 1);
    assert.equal(read(w, d.id).sync, 'pending', 'the draft is still there, waiting');
    await wait(w, 50 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 1, 'no retry before the pause ends');
    await wait(w, 6 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 2);
    assert.equal(w.remoteDrafts.saves[1].internetId, w.remoteDrafts.saves[0].internetId);
    assert.equal(read(w, d.id).sync, 'synced');
    assert.equal(w.remoteDrafts.remote.size, 1);
  }));

test('a lost reply retries the same revision under the same Message-ID', () =>
  world(async w => {
    w.remoteDrafts.script.push({ result: 'lost' });
    const d = create(w);
    await wait(w, 5 * SEC);
    assert.equal(read(w, d.id).sync, 'pending');
    await wait(w, 31 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 2);
    assert.equal(w.remoteDrafts.saves[1].internetId, w.remoteDrafts.saves[0].internetId);
    assert.equal(read(w, d.id).sync, 'synced');
  }));

test('a refusal that will not change leaves the draft local with a problem, and the next edit tries again', () =>
  world(async w => {
    w.remoteDrafts.script.push({ result: 'notSent', notSentClass: 'permission' });
    const d = create(w);
    await wait(w, 5 * SEC);
    assert.equal(read(w, d.id).sync, 'failed');
    await wait(w, 5 * 60 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 1, 'not retried on its own');
    const e = edit(w, read(w, d.id), fields({ subject: 'Try again' }));
    assert.equal(e.sync, 'pending');
    await wait(w, 5 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 2);
    assert.equal(read(w, d.id).sync, 'synced');
  }));

test('a restart resumes a pending upload exactly once', () =>
  world(async w => {
    const d = create(w);
    await wait(w, 2 * SEC);
    w.first.kill();
    const second = w.open();
    assert.equal(w.remoteDrafts.saves.length, 0);
    await wait(w, 3 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 1, 'the other instance uploaded it');
    assert.equal(read(w, d.id).sync, 'synced');
    await wait(w, 60 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 1, 'and only once');
    assert.ok(second);
  }));

test('a crash during an upload resumes it under the same Message-ID', () =>
  world(async w => {
    let release!: () => void;
    w.remoteDrafts.script.push({ wait: new Promise<void>(resolve => (release = resolve)) });
    const d = create(w);
    await wait(w, 5 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 1);
    w.first.kill();
    w.open();
    await wait(w, 1 * SEC);
    release();
    await wait(w, 1 * SEC);
    const [hung, again] = w.remoteDrafts.saves;
    assert.equal(again.internetId, hung.internetId, 'an unrecorded create is recognised by its id');
    assert.equal(read(w, d.id).sync, 'synced');
  }));

// ---------------------------------------------------------------- message ids and the send

test('Message-IDs stay per revision through sync and send, and a synced revision is sent under its own id', () =>
  world(async w => {
    const s = await synced(w);
    const first = s.draft;
    const sub1 = await w.send(w.first, first.id, { revision: first.revision });
    assert.equal(sub1.internetId, w.remoteDrafts.saves[0].internetId, 'sent under the copy id');
    await w.act(w.first, { type: 'undo', submissionId: sub1.id });
    const second = edit(w, read(w, first.id), fields({ subject: 'Revised' }));
    await wait(w, 5 * SEC);
    const sub2 = await w.send(w.first, first.id, { revision: second.revision });
    assert.equal(sub2.internetId, w.remoteDrafts.saves[1].internetId);
    assert.notEqual(sub2.internetId, sub1.internetId);
    assertIdsPerRevision(w, first.id);
    await wait(w, 10 * SEC);
    assert.equal(w.get(sub2.id).state, 'sent');
    assert.equal(w.server.worst(), 1);
    const left = w.server.payloads[0];
    assert.equal(left.remoteDraftId, s.remoteDraftId);
  }));

test('a draft with a live send is locked: save, resolve and sync wait, and discarding cancels a send that has not started', () =>
  world(async w => {
    const d = create(w);
    const sub = await w.send(w.first, d.id);
    const message = refused(
      () =>
        service(w).set(next(), {
          id: d.id,
          baseRevision: 1,
          fields: fields({ subject: 'Edited while sending' }),
        }),
      'stateMismatch',
    );
    assert.match(message, /Undo or cancel/);
    assert.equal(read(w, d.id).submissionId, sub.id);
    // The upload due inside the undo window does not run: the send pins the revision.
    await w.clock.advance(5 * SEC);
    await w.settle();
    assert.equal(w.remoteDrafts.saves.length, 0);
    const gone = service(w).destroy(next(), d.id);
    assert.equal(gone.undoable, false);
    assert.equal(w.get(sub.id).state, 'cancelled', 'discarding cancels the queued send');
    assert.equal(service(w).get([d.id]).notFound.length, 1);
    await wait(w, 20 * SEC);
    assert.equal(w.server.deliveries.size, 0, 'nothing was sent');
  }));

test('a draft whose send is sending cannot be discarded or resolved', () =>
  world(async w => {
    const d = create(w);
    let release!: () => void;
    w.server.script.push({ wait: new Promise<void>(resolve => (release = resolve)) });
    await w.send(w.first, d.id);
    await w.clock.advance(10 * SEC);
    refused(() => service(w).destroy(next(), d.id), 'conflict');
    refused(
      () => service(w).set(next(), { id: d.id, baseRevision: 1, fields: fields({ subject: 'x' }) }),
      'conflict',
    );
    refused(() => service(w).resolve(next(), d.id, 'keepMine'), 'stateMismatch');
    release();
    await w.settle();
    assert.equal(w.server.worst(), 1);
  }));

test('a sent draft leaves Drafts; the remote draft its send consumed is not deleted again', () =>
  world(async w => {
    const s = await synced(w);
    const sub = await w.send(w.first, s.draft.id, { revision: s.draft.revision });
    await wait(w, 10 * SEC);
    assert.equal(w.get(sub.id).state, 'sent');
    assert.equal(service(w).get([s.draft.id]).notFound.length, 1, 'cleaned up');
    assert.deepEqual(w.server.consumed, [s.remoteDraftId], 'the send used the remote draft');
    assert.deepEqual(w.remoteDrafts.removeAttempts, []);
  }));

test('discarding a synced draft deletes the remote copy, and a paused removal is retried', () =>
  world(async w => {
    const s = await synced(w);
    service(w).destroy(next(), s.draft.id);
    await w.settle();
    assert.deepEqual(w.remoteDrafts.removes, [s.remoteDraftId]);
    assert.equal(w.remoteDrafts.remote.size, 0);
  }));

// ---------------------------------------------------------------- other devices

test("another device's draft shows in Drafts, never in a thread", () =>
  world(async w => {
    phone(w, 'phone-draft-1', 'pm-1', { subject: 'Written on the phone' });
    const id = `${ACCOUNT}:phone-draft-1`;
    const d = read(w, id);
    assert.equal(d.origin, 'remote');
    assert.equal(d.subject, 'Written on the phone');
    assert.equal(d.incomplete, true, 'its text has not arrived yet');
    assert.equal(
      d.sync,
      'synced',
      'it matches the provider; the incomplete flag says the text is missing',
    );
    const threads = w.first.store.read(q =>
      q.get<{ n: number }>('SELECT count(*) AS n FROM threads'),
    );
    const messages = w.first.store.read(q =>
      q.get<{ n: number }>('SELECT count(*) AS n FROM messages'),
    );
    assert.equal(threads?.n, 0);
    assert.equal(messages?.n, 0);
    assert.equal((await changedFrames(w)).length, 1);
    await wait(w, 30 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 0, 'never uploaded back');
    // Its text has not arrived (a snippet only): an edit of it forks (drafts.fourth.test.ts), never uploads the snippet.
    phone(w, 'phone-draft-1', 'pm-1', {
      subject: 'Written on the phone',
      html: '<p>Full text</p>',
    });
    // Opening it and editing makes it ours: the edit goes to the same remote draft.
    const e = edit(w, read(w, id), { ...fields(), subject: 'Edited here' });
    assert.equal(e.origin, 'local');
    w.remoteDrafts.remote.set('phone-draft-1', { messageId: 'pm-1', internetId: 'x', revision: 1 });
    await wait(w, 5 * SEC);
    assert.equal(w.remoteDrafts.saves[0].remoteDraftId, 'phone-draft-1');
    assert.equal(w.remoteDrafts.saves[0].baseRemoteMessageId, 'pm-1');
  }));

test('our own upload coming back in history is not a remote edit, even before its result is recorded', () =>
  world(async w => {
    let release!: () => void;
    w.remoteDrafts.script.push({ wait: new Promise<void>(resolve => (release = resolve)) });
    const d = create(w);
    await wait(w, 5 * SEC);
    const upload = w.remoteDrafts.saves[0];
    // History reports the new copy while the save call has not returned.
    w.first.store.commit({
      opId: `phone-${++ops}`,
      origin: 'sync',
      writes: [
        copyWrite({
          remoteDraftId: 'rd-new',
          remoteMessageId: 'm-new',
          internetId: upload.internetId,
          changedAt: w.clock.now(),
        }),
      ],
    });
    assert.equal(service(w).get([`${ACCOUNT}:rd-new`]).notFound.length, 1, 'no phantom draft');
    release();
    await wait(w, 1 * SEC);
    const r = row(w, d.id)!;
    phone(w, r.remote_draft_id!, r.remote_message_id!, { subject: 'echo' });
    assert.equal(read(w, d.id).conflict, undefined);
    assert.equal(read(w, d.id).subject, 'Lunch', 'an echo changes nothing');
  }));

test('a remote edit of a draft nobody changed here replaces it only when the body came with it', () =>
  world(async w => {
    const s = await synced(w);
    phone(w, s.remoteDraftId, 'pm-2', { subject: 'Phone version', html: '<p>Phone body</p>' });
    const d = read(w, s.draft.id);
    assert.equal(d.subject, 'Phone version');
    assert.equal(d.html, '<p>Phone body</p>');
    assert.equal(d.revision, s.draft.revision + 1);
    assert.equal(d.conflict, undefined);
    assert.equal(d.sync, 'synced');
    const frame = (await changedFrames(w)).at(-1);
    assert.equal(frame?.frame === 'Draft/changed' && frame.conflict, false);
    // Without the body nothing is replaced silently: the owner chooses.
    phone(w, s.remoteDraftId, 'pm-3', { subject: 'Metadata only' });
    const asked = read(w, s.draft.id);
    assert.ok(asked.conflict, 'a choice is needed');
    assert.equal(asked.subject, 'Phone version', 'the local text is intact');
  }));

test('lost draft: a remote edit never overwrites an unsynced local edit without the choice', () =>
  world(async w => {
    const s = await synced(w);
    const local = edit(w, s.draft, fields({ subject: 'My unsynced words' }));
    phone(w, s.remoteDraftId, 'pm-2', { subject: 'Phone words', html: '<p>Phone body</p>' });
    const d = read(w, local.id);
    assert.equal(d.subject, 'My unsynced words', 'the local edit is intact');
    assert.ok(d.conflict);
    assert.equal(d.conflict.theirsRevision, 1);
    const frame = (await changedFrames(w)).at(-1);
    assert.ok(frame?.frame === 'Draft/changed' && frame.conflict && frame.draft?.conflict);
    // While a choice is pending nothing is uploaded over their copy.
    const before = w.remoteDrafts.saves.length;
    await wait(w, 60 * SEC);
    assert.equal(w.remoteDrafts.saves.length, before);
  }));

test('keep mine: the draft uploads over their copy', () =>
  world(async w => {
    const s = await synced(w);
    edit(w, s.draft, fields({ subject: 'Mine' }));
    const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    phone(w, s.remoteDraftId, theirId, { subject: 'Theirs' });
    const out = service(w).resolve(next(), s.draft.id, 'keepMine');
    assert.equal(out.draft.subject, 'Mine');
    assert.equal(out.draft.conflict, undefined);
    assert.equal(out.copyId, undefined);
    await w.settle();
    const last = w.remoteDrafts.saves.at(-1)!;
    // Their version was only reported by its subject, never shown whole: it is not overwritten, a new copy is made.
    assert.equal(last.remoteDraftId, undefined, 'a new copy');
    assert.equal(last.baseRemoteMessageId, undefined);
    assert.equal(
      w.remoteDrafts.remote.get(s.remoteDraftId)?.messageId,
      theirId,
      'theirs is intact',
    );
    assert.equal(read(w, s.draft.id).sync, 'synced');
    const frame = (await changedFrames(w)).at(-1);
    assert.equal(frame?.frame === 'Draft/changed' && frame.conflict, false);
  }));

test('take theirs: the draft becomes their version', () =>
  world(async w => {
    const s = await synced(w);
    edit(w, s.draft, fields({ subject: 'Mine' }));
    const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    phone(w, s.remoteDraftId, theirId, { subject: 'Theirs', html: '<p>Their body</p>' });
    const out = service(w).resolve(next(), s.draft.id, 'takeTheirs');
    assert.equal(out.draft.subject, 'Theirs');
    assert.equal(out.draft.html, '<p>Their body</p>');
    assert.equal(out.draft.conflict, undefined);
    assert.equal(out.draft.sync, 'synced');
    await wait(w, 30 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 1, 'nothing to upload: the copy is theirs already');
  }));

test('keep both: mine stays in place and theirs becomes a second draft', () =>
  world(async w => {
    const s = await synced(w);
    edit(w, s.draft, fields({ subject: 'Mine' }));
    const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    phone(w, s.remoteDraftId, theirId, { subject: 'Theirs', html: '<p>Their body</p>' });
    const out = service(w).resolve(next(), s.draft.id, 'keepBoth');
    assert.equal(out.draft.subject, 'Mine');
    assert.ok(out.copyId);
    const copy = read(w, out.copyId);
    assert.equal(copy.subject, 'Theirs');
    assert.equal(copy.origin, 'local');
    assert.notEqual(copy.id, s.draft.id);
    await wait(w, 5 * SEC);
    const uploaded = w.remoteDrafts.saves.slice(1);
    assert.equal(uploaded.length, 2, 'both drafts are uploaded');
    assert.equal(new Set(uploaded.map(u => u.remoteDraftId ?? 'new')).size, 2);
    assert.equal(w.remoteDrafts.remote.size, 2);
  }));

test('an upload that finds the copy changed (history not here yet) raises the same choice and writes nothing', () =>
  world(async w => {
    const s = await synced(w);
    const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    edit(w, s.draft, fields({ subject: 'Mine' }));
    await wait(w, 5 * SEC);
    const d = read(w, s.draft.id);
    assert.ok(d.conflict, 'the conflict state is raised');
    assert.equal(
      w.remoteDrafts.remote.get(s.remoteDraftId)?.messageId,
      theirId,
      'their copy was not overwritten',
    );
    assert.equal(d.subject, 'Mine');
    const frame = (await changedFrames(w)).at(-1);
    assert.ok(frame?.frame === 'Draft/changed' && frame.conflict);
    refused(() => service(w).resolve(next(), s.draft.id, 'takeTheirs'), 'unavailable');
    service(w).resolve(next(), s.draft.id, 'keepMine');
    await w.settle();
    assert.equal(read(w, s.draft.id).sync, 'synced');
    // The conflict named no body, so their version was never seen: keep mine makes a new copy and leaves it alone.
    assert.equal(w.remoteDrafts.saves.at(-1)?.remoteDraftId, undefined);
    assert.equal(
      w.remoteDrafts.remote.get(s.remoteDraftId)?.messageId,
      theirId,
      'theirs is intact',
    );
  }));

test('a copy deleted elsewhere while edited here asks, and keep mine uploads it as a new draft', () =>
  world(async w => {
    const s = await synced(w);
    edit(w, s.draft, fields({ subject: 'Mine' }));
    phone(w, s.remoteDraftId, 'gone', { subject: 'x', removed: true });
    const d = read(w, s.draft.id);
    assert.ok(d.conflict);
    service(w).resolve(next(), s.draft.id, 'keepMine');
    await w.settle();
    const last = w.remoteDrafts.saves.at(-1)!;
    assert.equal(last.remoteDraftId, undefined, 'created again, by the owner choice');
    assert.equal(read(w, s.draft.id).subject, 'Mine');
    assert.equal(read(w, s.draft.id).sync, 'synced');
  }));

test('a copy deleted elsewhere is deleted here when nothing was changed here', () =>
  world(async w => {
    const s = await synced(w);
    phone(w, s.remoteDraftId, 'gone', { subject: 'x', removed: true });
    assert.equal(service(w).get([s.draft.id]).notFound.length, 1);
  }));

test('resolving a draft that has no other version is refused', () =>
  world(async w => {
    const d = create(w);
    const message = refused(() => service(w).resolve(next(), d.id, 'keepMine'), 'stateMismatch');
    assert.match(message, /no other version/);
  }));
