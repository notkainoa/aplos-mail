import test from 'node:test';
import assert from 'node:assert/strict';
import type { Draft, DraftFields } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { ACCOUNT, fields, gate, inWorld, MIN, SEC, type World } from './helpers';

/**
 * Time-3 review fixes: what a resolved conflict leaves in the row, the removal of a discarded draft's copy, the upload
 * schedule around conflicts and lost replies, the mutations the first tests missed, and the cost of the deadline scan.
 */

const world = (fn: (w: World) => Promise<void> | void) => inWorld(fn, { drafts: true });

let ops = 0;
const next = () => `review-op-${++ops}`;
const HOUR = 60 * MIN;

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

const count = (w: World, instance = w.first) =>
  instance.store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM drafts'))!.n;

interface Sync {
  dueAt?: number;
  fingerprint?: string;
  uploading?: unknown;
  removing?: true;
  conflict?: { theirsRevision: number; complete?: boolean; theirsInternetId?: string };
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

/** What history reports when another device saves a draft. */
function phone(
  w: World,
  remoteDraftId: string,
  messageId: string,
  content: { subject: string; html?: string; removed?: true; internetId?: string } = {
    subject: 'From the phone',
  },
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
    opId: `review-phone-${++ops}`,
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
    internetId: r.remote_internet_id!,
  };
}

/** A synced draft edited here and then edited on the phone: the conflict state, with the phone's version delivered. */
async function conflicted(w: World, theirs: { html?: string; internetId?: string }) {
  const s = await synced(w);
  edit(w, s.draft, fields({ subject: 'Mine' }));
  const theirId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
  phone(w, s.remoteDraftId, theirId, { subject: 'Theirs', ...theirs });
  assert.ok(read(w, s.draft.id).conflict, 'a choice is needed');
  return { ...s, theirId };
}

// ---------------------------------------------------------------- keep mine

test('keep mine then an immediate send: the send is our content under a new id, never their copy', () =>
  world(async w => {
    const s = await conflicted(w, { html: '<p>Their body</p>', internetId: THEIRS_ID });
    service(w).resolve(next(), s.draft.id, 'keepMine');
    const r = row(w, s.draft.id)!;
    assert.equal(r.synced_revision, null, 'our content is not what the copy holds');
    assert.equal(r.remote_internet_id, null, 'and our old Message-ID no longer names it');
    assert.equal(r.remote_message_id, s.theirId, 'the upload will replace their copy knowingly');
    const sub = w.send(w.first, s.draft.id, { revision: read(w, s.draft.id).revision });
    assert.notEqual(sub.internetId, s.internetId, 'findSent looks for the id that really leaves');
    await wait(w, 15 * SEC);
    const payload = w.server.payloads[0];
    assert.equal(payload.internetId, sub.internetId);
    assert.equal(payload.remoteDraftId, undefined, 'their copy is not what is sent');
    assert.equal(payload.baseRemoteMessageId, undefined);
    assert.equal(header(payload.mime, 'Subject'), 'Mine', 'the pinned MIME is the local content');
  }));

// ---------------------------------------------------------------- take theirs

test('take theirs with their Message-ID known: the copy is theirs and a send leaves under their id', () =>
  world(async w => {
    const s = await conflicted(w, { html: '<p>Their body</p>', internetId: THEIRS_ID });
    const out = service(w).resolve(next(), s.draft.id, 'takeTheirs');
    assert.equal(out.draft.html, '<p>Their body</p>');
    const r = row(w, s.draft.id)!;
    assert.equal(r.remote_internet_id, THEIRS_ID, 'not our old id');
    assert.equal(r.synced_revision, r.revision);
    assert.equal(r.remote_message_id, s.theirId);
    const sub = w.send(w.first, s.draft.id, { revision: r.revision });
    assert.equal(sub.internetId, THEIRS_ID);
    await wait(w, 15 * SEC);
    const payload = w.server.payloads[0];
    assert.equal(payload.remoteDraftId, s.remoteDraftId);
    assert.equal(payload.baseRemoteMessageId, s.theirId);
  }));

test('take theirs without their Message-ID: nothing claims our old id, and the send is the pinned MIME', () =>
  world(async w => {
    const s = await conflicted(w, { html: '<p>Their body</p>' });
    const out = service(w).resolve(next(), s.draft.id, 'takeTheirs');
    assert.equal(out.draft.sync, 'synced');
    const r = row(w, s.draft.id)!;
    assert.equal(r.remote_internet_id, null);
    assert.equal(r.synced_revision, null);
    await wait(w, 30 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 1, 'nothing to upload');
    const sub = w.send(w.first, s.draft.id, { revision: r.revision });
    assert.notEqual(sub.internetId, s.internetId);
    await wait(w, 15 * SEC);
    assert.equal(w.server.payloads[0].remoteDraftId, undefined);
    assert.equal(header(w.server.payloads[0].mime, 'Subject'), 'Theirs');
  }));

test('an incomplete other version: take theirs and keep both are refused, nothing is lost, keep mine works', () =>
  world(async w => {
    const s = await conflicted(w, { internetId: THEIRS_ID });
    assert.equal(syncOf(w, s.draft.id).conflict?.complete, false);
    assert.equal(syncOf(w, s.draft.id).conflict?.theirsInternetId, THEIRS_ID);
    const before = count(w);
    const one = refused(() => service(w).resolve(next(), s.draft.id, 'takeTheirs'), 'unavailable');
    assert.match(one, /can't be read here/);
    refused(() => service(w).resolve(next(), s.draft.id, 'keepBoth'), 'unavailable');
    assert.equal(count(w), before, 'no second draft was made');
    const kept = read(w, s.draft.id);
    assert.equal(kept.subject, 'Mine', 'our text is intact');
    assert.ok(kept.conflict, 'the choice is still pending');
    service(w).resolve(next(), s.draft.id, 'keepMine');
    await w.settle();
    assert.equal(read(w, s.draft.id).conflict, undefined);
    assert.equal(w.remoteDrafts.saves.at(-1)?.baseRemoteMessageId, s.theirId);
  }));

test('a silent replace by their complete version takes their Message-ID, or forgets ours when it is unknown', () =>
  world(async w => {
    const s = await synced(w);
    phone(w, s.remoteDraftId, 'pm-2', { subject: 'Phone', html: '<p>Phone body</p>' });
    const first = row(w, s.draft.id)!;
    assert.equal(first.revision, s.draft.revision + 1);
    assert.equal(first.remote_internet_id, null, 'our id does not name their copy');
    assert.equal(first.synced_revision, null);
    assert.equal(read(w, s.draft.id).sync, 'synced');
    phone(w, s.remoteDraftId, 'pm-3', {
      subject: 'Phone again',
      html: '<p>Again</p>',
      internetId: THEIRS_ID,
    });
    const second = row(w, s.draft.id)!;
    assert.equal(second.remote_internet_id, THEIRS_ID);
    assert.equal(second.synced_revision, second.revision);
  }));

test("a refreshed phone draft whose Message-ID is not reported does not keep the previous copy's id", () =>
  world(async w => {
    phone(w, 'phone-1', 'pm-1', { subject: 'One', internetId: '<one@phone.example>' });
    const id = `${ACCOUNT}:phone-1`;
    assert.equal(row(w, id)!.remote_internet_id, '<one@phone.example>');
    phone(w, 'phone-1', 'pm-2', { subject: 'Two', html: '<p>Two</p>' });
    const r = row(w, id)!;
    assert.equal(r.remote_internet_id, null);
    assert.equal(r.synced_revision, null);
  }));

// ---------------------------------------------------------------- a discarded draft stays discarded

test('a discarded draft is not re-created by a late echo of its own copy', () =>
  world(async w => {
    const s = await synced(w);
    w.remoteDrafts.removeScript.push({ result: 'paused', until: w.clock.now() + 60 * SEC });
    service(w).destroy(next(), s.draft.id);
    assert.equal(service(w).get([s.draft.id]).notFound.length, 1, 'hidden at once');
    // History reports the copy again (our late echo) while the removal waits.
    w.first.store.commit({
      opId: `review-echo-${++ops}`,
      origin: 'sync',
      writes: [
        {
          kind: 'remoteDraft',
          accountId: ACCOUNT,
          remoteDraftId: s.remoteDraftId,
          remoteMessageId: s.messageId,
          internetId: s.internetId,
          changedAt: w.clock.now(),
        },
      ],
    });
    const ghost = `${ACCOUNT}:${s.remoteDraftId}`;
    assert.equal(service(w).get([ghost]).notFound.length, 1, 'no draft of another device appears');
    assert.equal(row(w, ghost), undefined);
    await wait(w, 90 * SEC);
    assert.deepEqual(w.remoteDrafts.removes, [s.remoteDraftId]);
    assert.equal(count(w), 0, 'the row goes once the copy is gone');
  }));

test('a discard that the process does not outlive still removes the copy after a restart', () =>
  world(async w => {
    const s = await synced(w);
    service(w).destroy(next(), s.draft.id);
    w.first.kill();
    assert.equal(w.remoteDrafts.removeAttempts.length, 0, 'the crash came first');
    const second = w.open();
    assert.equal(service(w, second).get([s.draft.id]).notFound.length, 1);
    await wait(w, 2 * SEC);
    assert.deepEqual(w.remoteDrafts.removes, [s.remoteDraftId]);
    assert.equal(w.remoteDrafts.remote.size, 0);
    assert.equal(count(w, second), 0);
  }));

test('a removal the provider keeps refusing is retried with a backoff and never abandoned', () =>
  world(async w => {
    const s = await synced(w);
    for (let i = 0; i < 5; i++)
      w.remoteDrafts.removeScript.push({ result: 'notSent', notSentClass: 'transient' });
    service(w).destroy(next(), s.draft.id);
    for (let i = 0; i < 30 && w.remoteDrafts.removeAttempts.length < 5; i++) await wait(w, MIN);
    assert.equal(w.remoteDrafts.removeAttempts.length, 5, 'five refusals');
    assert.equal(count(w), 1, 'the hidden row is kept');
    assert.equal(service(w).get([s.draft.id]).notFound.length, 1);
    assert.equal(w.remoteDrafts.remote.size, 1, 'the copy is still there');
    await wait(w, HOUR);
    assert.deepEqual(w.remoteDrafts.removes, [s.remoteDraftId], 'and then it goes');
    assert.equal(count(w), 0);
  }));

test('a permanent refusal keeps the hidden row, logs, and is asked again later', () =>
  world(async w => {
    const s = await synced(w);
    w.remoteDrafts.removeScript.push({ result: 'notSent', notSentClass: 'permission' });
    service(w).destroy(next(), s.draft.id);
    await wait(w, 2 * SEC);
    assert.equal(w.remoteDrafts.removeAttempts.length, 1);
    assert.ok(w.events('draft.sync_failed').length >= 1, 'logged');
    await wait(w, 2 * HOUR);
    assert.equal(count(w), 1, 'the row is kept, not abandoned');
    await wait(w, 26 * HOUR);
    assert.deepEqual(w.remoteDrafts.removes, [s.remoteDraftId]);
    assert.equal(count(w), 0);
  }));

test('a discard while the first upload runs removes the copy that upload makes, and survives a restart', () =>
  world(async w => {
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    const d = create(w);
    await wait(w, 5 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 1, 'in flight');
    service(w).destroy(next(), d.id);
    assert.equal(service(w).get([d.id]).notFound.length, 1);
    assert.equal(count(w), 1, 'the row waits for the upload to say what it made');
    g.open();
    await wait(w, 2 * SEC);
    assert.equal(w.remoteDrafts.remote.size, 0, 'the copy was removed');
    assert.equal(count(w), 0);
  }));

test('a discarded draft with a lost first upload takes the copy that history reports for it', () =>
  world(async w => {
    w.remoteDrafts.script.push({ result: 'landedLost' });
    const d = create(w);
    await wait(w, 5 * SEC);
    const internetId = w.remoteDrafts.saves[0].internetId;
    service(w).destroy(next(), d.id);
    // History reports the copy the lost reply hid, under the Message-ID of the upload.
    w.first.store.commit({
      opId: `review-echo-${++ops}`,
      origin: 'sync',
      writes: [
        {
          kind: 'remoteDraft',
          accountId: ACCOUNT,
          remoteDraftId: 'rd1',
          remoteMessageId: 'msg2',
          internetId,
          changedAt: w.clock.now(),
        },
      ],
    });
    assert.equal(service(w).get([`${ACCOUNT}:rd1`]).notFound.length, 1, 'no phantom draft');
    await wait(w, 2 * SEC);
    assert.deepEqual(w.remoteDrafts.removes, ['rd1']);
    assert.equal(count(w), 0);
  }));

test('a discarded draft is not sent, resolved or saved', () =>
  world(async w => {
    const s = await synced(w);
    w.remoteDrafts.removeScript.push({ result: 'paused', until: w.clock.now() + HOUR });
    service(w).destroy(next(), s.draft.id);
    refused(
      () =>
        service(w).set(next(), {
          id: s.draft.id,
          baseRevision: 1,
          fields: fields({ subject: 'x' }),
        }),
      'notFound',
    );
    refused(() => service(w).resolve(next(), s.draft.id, 'keepMine'), 'notFound');
    refused(() => service(w).destroy(next(), s.draft.id), 'notFound');
    refused(() => w.send(w.first, s.draft.id, { revision: 1 }), 'notFound');
  }));

// ---------------------------------------------------------------- the schedule around conflicts and lost replies

test('a draft in conflict with an upload due does not wake the timer over and over', () =>
  world(async w => {
    const d = create(w);
    await wait(w, 5 * SEC);
    const created = row(w, d.id)!;
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    const two = edit(w, d, fields({ subject: 'B' }), true);
    await wait(w, 1);
    assert.equal(w.remoteDrafts.saves.length, 2, 'revision 2 is in flight');
    edit(w, two, fields({ subject: 'C' }));
    phone(w, created.remote_draft_id!, 'phone-msg');
    assert.ok(read(w, d.id).conflict, 'the phone edit raised the choice');
    g.open();
    await w.settle();
    assert.equal(syncOf(w, d.id).dueAt, undefined, 'no upload is due while a choice is pending');
    const fired = w.events('timer.fired').length;
    await wait(w, 30 * SEC);
    assert.ok(
      w.events('timer.fired').length - fired < 3,
      'the source is not re-fired every second',
    );
    assert.equal(w.remoteDrafts.saves.length, 2, 'and nothing was uploaded over their copy');
    // Choosing makes it uploadable again.
    service(w).resolve(next(), d.id, 'keepMine');
    await w.settle();
    assert.equal(w.remoteDrafts.saves.length, 3);
    assert.equal(header(w.remoteDrafts.saves[2].mime, 'Subject'), 'C');
  }));

test('a conflicted row that somehow has an upload due still uploads nothing, and the due time is cleared', () =>
  world(async w => {
    const s = await synced(w);
    edit(w, s.draft, fields({ subject: 'Mine' }));
    phone(w, s.remoteDraftId, 'pm-9', { subject: 'Theirs' });
    assert.ok(read(w, s.draft.id).conflict);
    const db = w.file.open();
    const data = JSON.parse(
      (db.prepare('SELECT data FROM drafts WHERE id = ?').get(s.draft.id) as { data: string }).data,
    ) as { _sync: Sync };
    data._sync.dueAt = w.clock.now();
    db.prepare('UPDATE drafts SET data = ? WHERE id = ?').run(JSON.stringify(data), s.draft.id);
    db.close();
    w.first.outbox.closeDraft(s.draft.id);
    w.first.loop.changed('drafts');
    await wait(w, 5 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 1, 'nothing over their copy');
    assert.equal(syncOf(w, s.draft.id).dueAt, undefined);
  }));

test('a lost reply after the owner put the content back clears the synced mark so the draft is not shown as synced', () =>
  world(async w => {
    const s = await synced(w);
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait, result: 'landedLost' });
    const b = edit(w, s.draft, fields({ subject: 'B' }), true);
    await wait(w, 1);
    assert.equal(w.remoteDrafts.saves.length, 2, 'B is in flight');
    // The owner reverts to what the copy held before B: nothing looks due.
    const a = edit(w, b, fields());
    assert.equal(syncOf(w, a.id).dueAt, undefined);
    g.open();
    await w.settle();
    assert.equal(
      w.remoteDrafts.remote.get(s.remoteDraftId)?.internetId,
      w.remoteDrafts.saves[1].internetId,
      'B landed',
    );
    const meta = syncOf(w, a.id);
    assert.equal(meta.fingerprint, undefined, 'what the copy holds is no longer known');
    assert.notEqual(meta.dueAt, undefined, 'the current content is uploaded again');
    assert.equal(meta.uploading, undefined);
    assert.notEqual(read(w, a.id).sync, 'synced');
    await wait(w, 40 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 3, 'the current revision asked again');
    assert.equal(header(w.remoteDrafts.saves[2].mime, 'Subject'), 'Lunch');
    // B changed the copy under our base, so the choice is the owner's; keeping ours brings the copy back to A.
    assert.ok(read(w, a.id).conflict);
    service(w).resolve(next(), a.id, 'keepMine');
    await w.settle();
    assert.equal(read(w, a.id).sync, 'synced');
    assert.equal(
      w.remoteDrafts.remote.get(s.remoteDraftId)?.internetId,
      w.remoteDrafts.saves.at(-1)!.internetId,
    );
    assert.equal(header(w.remoteDrafts.saves.at(-1)!.mime, 'Subject'), 'Lunch');
  }));

// ---------------------------------------------------------------- mutations the first tests missed

test('an edit made while an upload runs is uploaded after it (the ack marks only the revision that was sent)', () =>
  world(async w => {
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    const d = create(w);
    await wait(w, 5 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 1);
    edit(w, d, fields({ subject: 'Newer' }));
    g.open();
    await w.settle();
    assert.equal(read(w, d.id).sync, 'pending', 'the newer edit is not synced yet');
    await wait(w, 6 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 2);
    assert.equal(header(w.remoteDrafts.saves[1].mime, 'Subject'), 'Newer');
    assert.equal(read(w, d.id).sync, 'synced');
    assert.equal(row(w, d.id)!.synced_revision, 2);
  }));

test('a remote change to a draft with a live send is left alone', () =>
  world(async w => {
    const s = await synced(w);
    w.send(w.first, s.draft.id, { revision: s.draft.revision });
    phone(w, s.remoteDraftId, 'pm-live', { subject: 'Phone', html: '<p>Phone</p>' });
    const kept = read(w, s.draft.id);
    assert.equal(kept.subject, 'Lunch');
    assert.equal(kept.revision, s.draft.revision);
    assert.equal(kept.conflict, undefined);
    phone(w, s.remoteDraftId, 'gone', { subject: 'x', removed: true });
    const still = read(w, s.draft.id);
    assert.equal(still.subject, 'Lunch', 'not deleted under the send');
    assert.equal(still.conflict, undefined);
  }));

test('a changed revision during the upload keeps the old upload from marking the draft, and the new one goes on its own time', () =>
  world(async w => {
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait, result: 'lost' });
    const d = create(w);
    await wait(w, 5 * SEC);
    edit(w, d, fields({ subject: 'Newer' }));
    g.open();
    await w.settle();
    // The failed upload of revision 1 must not move the newer revision's wait (5 s after its save) to its own retry.
    await wait(w, 6 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 2, 'revision 2 uploaded on its own time');
    assert.equal(header(w.remoteDrafts.saves[1].mime, 'Subject'), 'Newer');
    assert.equal(read(w, d.id).sync, 'synced');
  }));

test('an upload is not started for a revision that changed before it was marked', () =>
  world(async w => {
    const d = create(w);
    const store = w.first.store;
    const commit = store.commit.bind(store);
    let raced = false;
    store.commit = input => {
      const write = input.writes[0] as { op?: string; patch?: { uploading?: unknown } };
      if (!raced && input.opId.startsWith('drafts:') && write.patch?.uploading) {
        raced = true;
        service(w).set(next(), { id: d.id, baseRevision: 1, fields: fields({ subject: 'Newer' }) });
      }
      return commit(input);
    };
    await wait(w, 5 * SEC);
    assert.ok(raced);
    assert.equal(w.remoteDrafts.saves.length, 0, 'the old revision is not uploaded');
    await wait(w, 6 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 1);
    assert.equal(header(w.remoteDrafts.saves[0].mime, 'Subject'), 'Newer');
  }));

test('a refusal for an old revision does not mark the newer one as failed', () =>
  world(async w => {
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait, result: 'notSent', notSentClass: 'permission' });
    const d = create(w);
    await wait(w, 5 * SEC);
    edit(w, d, fields({ subject: 'Newer' }));
    g.open();
    await w.settle();
    assert.notEqual(read(w, d.id).sync, 'failed');
    await wait(w, 6 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 2);
    assert.equal(read(w, d.id).sync, 'synced');
  }));

test('a conflict found for an old revision is not raised: the newer revision finds it on its own upload', () =>
  world(async w => {
    const s = await synced(w);
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    const two = edit(w, s.draft, fields({ subject: 'B' }), true);
    await wait(w, 1);
    assert.equal(w.remoteDrafts.saves.length, 2);
    w.remoteDrafts.phoneEdit(s.remoteDraftId);
    edit(w, two, fields({ subject: 'C' }));
    g.open();
    await w.settle();
    assert.equal(read(w, s.draft.id).conflict, undefined, 'revision 2 is not the draft any more');
    await wait(w, 6 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 3, 'revision 3 uploaded');
    const d = read(w, s.draft.id);
    assert.equal(d.conflict?.theirsRevision, 1);
    assert.equal(d.subject, 'C');
  }));

test('the upload fingerprint covers Bcc and attachments: a Bcc-only and an attachment-only change both upload', () =>
  world(async w => {
    const s = await synced(w);
    const bcc = [{ address: 'quiet@mail.example' }];
    const withBcc = edit(w, s.draft, fields({ bcc }));
    await wait(w, 5 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 2, 'a Bcc-only change uploads');
    assert.match(header(w.remoteDrafts.saves[1].mime, 'Bcc') ?? '', /quiet@mail\.example/);
    w.blobs.set('blob-1', new TextEncoder().encode('hello'));
    const attachment = {
      id: 'att-1',
      name: 'notes.txt',
      mime: 'text/plain',
      size: 5,
      blobId: 'blob-1',
    };
    edit(w, withBcc, fields({ bcc, attachments: [attachment] }));
    await wait(w, 5 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 3, 'an attachment-only change uploads');
    assert.match(new TextDecoder().decode(w.remoteDrafts.saves[2].mime), /notes\.txt/);
  }));

// ---------------------------------------------------------------- the cost of the deadline scan

function insertMany(w: World, n: number) {
  const db = w.file.open();
  const insert = db.prepare(
    `INSERT INTO drafts(id, account_id, revision, data, origin, updated_at) VALUES(?, ?, 1, ?, 'local', ?)`,
  );
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) {
    const f = fields({ subject: `Bulk ${i}` });
    insert.run(`bulk-${i}`, ACCOUNT, JSON.stringify(f), w.clock.now() - i);
  }
  db.exec('COMMIT');
  db.close();
}

/** Counts the multi-row queries (`all`) the engine runs on `drafts`. */
function watchScans(w: World) {
  const store = w.first.store as { read: (fn: (q: unknown) => unknown) => unknown };
  const read = store.read.bind(store);
  const scans: string[] = [];
  store.read = fn =>
    read(q => {
      const proxy = new Proxy(q as object, {
        get(target, prop) {
          const value = (target as Record<string | symbol, unknown>)[prop];
          if (typeof value !== 'function') return value;
          if (prop !== 'all') return value.bind(target);
          return (sql: string, ...args: unknown[]) => {
            if (/\bdrafts\b/.test(sql)) scans.push(sql);
            return (value as (...a: unknown[]) => unknown).call(target, sql, ...args);
          };
        },
      });
      return fn(proxy);
    });
  return scans;
}

test('with 2,000 drafts a save does not scan them all, and an upload still goes at its time', () =>
  world(async w => {
    insertMany(w, 2_000);
    const d = create(w);
    await w.settle();
    const scans = watchScans(w);
    let latest: Pick<Draft, 'id' | 'revision'> = d;
    for (let i = 0; i < 20; i++) {
      latest = edit(w, latest, fields({ subject: `Typing ${i}` }));
      await wait(w, 100);
    }
    assert.equal(scans.length, 0, `saves ran ${scans.length} scans of the drafts table`);
    await wait(w, 5 * SEC);
    assert.equal(w.remoteDrafts.saves.length, 1);
    assert.equal(header(w.remoteDrafts.saves[0].mime, 'Subject'), 'Typing 19');
  }));

test('a due time written by another process is found by the periodic scan within a minute', () =>
  world(async w => {
    const d = create(w);
    await w.settle();
    // Another process makes a draft due (the engine here saw no write for it).
    insertMany(w, 1);
    const db = w.file.open();
    const stored = db.prepare('SELECT data FROM drafts WHERE id = ?').get('bulk-0') as {
      data: string;
    };
    const data = JSON.parse(stored.data) as Record<string, unknown>;
    data._sync = { rev: 1, dueAt: w.clock.now() + 1_000 };
    db.prepare('UPDATE drafts SET data = ? WHERE id = ?').run(JSON.stringify(data), 'bulk-0');
    db.close();
    await wait(w, 61 * SEC);
    // Any change to a draft makes the source look again.
    edit(w, read(w, d.id), fields({ subject: 'Poke' }));
    await wait(w, 6 * SEC);
    const subjects = w.remoteDrafts.saves.map(s => header(s.mime, 'Subject'));
    assert.ok(
      subjects.includes('Bulk 0'),
      `the other process's draft uploaded (${subjects.join(', ')})`,
    );
  }));
