import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT, copyWrite, fields, gate, SEC } from './helpers';
import {
  count,
  create,
  edit,
  fact,
  read,
  row,
  service,
  syncOf,
  next,
  wait,
  world,
  type Fact,
} from './drafts.ports.kit';

/**
 * BINDING (c): a copy is adopted as this draft's own only when it is PROVEN ours: its Message-ID is the running upload's
 * (or a superseded attempt's) AND its content has the fingerprint of that upload. Otherwise it is shown as a remote draft
 * (a visible duplicate the owner can discard) and never replaced or deleted from here.
 */

const OWN: Fact = {
  subject: 'Lunch',
  html: '<p>Lunch at noon?</p>',
  to: [{ address: 'jordan@mail.example', name: 'Jordan' }],
};
const PHONE: Fact = { ...OWN, subject: 'Phone edit', html: '<p>Phone wrote this</p>' };
const REMOTE = `${ACCOUNT}:rd1`;
const shown = (w: Parameters<typeof count>[0], id: string) =>
  service(w).get([id]).notFound.length === 0;

/** A first create whose reply is lost after the copy landed (it is `rd1`). */
async function lostReply(w: Parameters<typeof count>[0]) {
  w.remoteDrafts.script.push({ result: 'landedLost' });
  const d = create(w, fields());
  await wait(w, 5 * SEC);
  const first = w.remoteDrafts.saves.at(-1)!;
  assert.equal(row(w, d.id)!.remote_draft_id, null, 'its reply was lost');
  assert.equal(w.remoteDrafts.remote.has('rd1'), true);
  return { d, first };
}

test('adopt (a): a lost-reply copy the phone edited (same Message-ID, other content) is not adopted, and survives an update and a discard', () =>
  world(async w => {
    const { d, first } = await lostReply(w);
    const phoneId = w.remoteDrafts.phoneEdit('rd1');
    fact(w, 'rd1', phoneId, { ...PHONE, internetId: first.internetId });
    assert.equal(row(w, d.id)!.remote_draft_id, null, 'not adopted');
    assert.equal(shown(w, REMOTE), true, 'shown as a remote draft');
    // An update of our draft makes its own copy; the phone's is left alone.
    edit(w, read(w, d.id), fields({ subject: 'Second' }), true);
    await wait(w, 5 * SEC);
    assert.equal(
      w.remoteDrafts.remote.get('rd1')?.messageId,
      phoneId,
      "the phone's copy is untouched",
    );
    // And a discard deletes only our own copy.
    service(w).destroy(next(), d.id);
    await w.settle();
    await wait(w, 5 * SEC);
    assert.equal(w.remoteDrafts.remote.has('rd1'), true, "the phone's copy survives the discard");
    assert.equal(w.remoteDrafts.removes.includes('rd1'), false);
  }));

test('adopt (b): a lost-reply copy that is unedited IS adopted (no duplicate), and the next upload updates it', () =>
  world(async w => {
    const { d, first } = await lostReply(w);
    fact(w, 'rd1', w.remoteDrafts.remote.get('rd1')!.messageId, {
      ...OWN,
      internetId: first.internetId,
    });
    assert.equal(row(w, d.id)!.remote_draft_id, 'rd1', 'adopted');
    assert.equal(shown(w, REMOTE), false, 'no duplicate');
    edit(w, read(w, d.id), fields({ subject: 'Second' }), true);
    await wait(w, 5 * SEC);
    assert.equal(w.remoteDrafts.saves.at(-1)!.remoteDraftId, 'rd1', 'an update, not a second copy');
    assert.equal(w.remoteDrafts.remote.size, 1);
  }));

test('adopt (c): a snippet-only copy (no body) is shown, not adopted, and a discard does not delete it', () =>
  world(async w => {
    const { d, first } = await lostReply(w);
    fact(w, 'rd1', w.remoteDrafts.remote.get('rd1')!.messageId, { internetId: first.internetId });
    assert.equal(row(w, d.id)!.remote_draft_id, null, 'not adopted without a body to compare');
    assert.equal(shown(w, REMOTE), true, 'shown');
    service(w).destroy(next(), d.id);
    await w.settle();
    await wait(w, 5 * SEC);
    assert.equal(w.remoteDrafts.remote.has('rd1'), true, 'never deleted from here');
  }));

test("adopt (d): a superseded attempt's copy is adopted only on its own fingerprint", () =>
  world(async w => {
    const { d, first } = await lostReply(w);
    // An edit replaces the attempt (a new Message-ID): the first one is now only in `wrote`.
    w.remoteDrafts.script.push({ result: 'lost' });
    edit(w, read(w, d.id), fields({ subject: 'Second' }), true);
    await wait(w, 5 * SEC);
    assert.notEqual(w.remoteDrafts.saves.at(-1)!.internetId, first.internetId);
    // The copy of the FIRST attempt with the SECOND revision's content is not that attempt's copy.
    fact(w, 'rd1', 'msg-x', { ...OWN, subject: 'Second', internetId: first.internetId });
    assert.equal(row(w, d.id)!.remote_draft_id, null, 'wrong content: not adopted');
    assert.equal(shown(w, REMOTE), true);
  }));

test("adopt (d): a superseded attempt's copy with its own content is adopted", () =>
  world(async w => {
    const { d, first } = await lostReply(w);
    w.remoteDrafts.script.push({ result: 'lost' });
    edit(w, read(w, d.id), fields({ subject: 'Second' }), true);
    await wait(w, 5 * SEC);
    fact(w, 'rd1', w.remoteDrafts.remote.get('rd1')!.messageId, {
      ...OWN,
      internetId: first.internetId,
    });
    assert.equal(row(w, d.id)!.remote_draft_id, 'rd1', 'its own content: adopted');
    assert.equal(shown(w, REMOTE), false);
  }));

test("adopt: an unproven copy shown early is dropped when the upload's own reply names that very version", () =>
  world(async w => {
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    const d = create(w, fields());
    await wait(w, 5 * SEC);
    const upload = w.remoteDrafts.saves.at(-1)!;
    // History is faster than the reply and cannot show the body: shown for now (the copy's message id is `msg2`).
    fact(w, 'rd1', 'msg2', { internetId: upload.internetId });
    assert.equal(shown(w, REMOTE), true);
    g.open();
    await wait(w, 5 * SEC);
    assert.equal(row(w, d.id)!.remote_draft_id, 'rd1', 'the reply bound the copy to this draft');
    assert.equal(shown(w, REMOTE), false, 'the early row was the same copy and is gone');
    assert.equal(count(w), 1);
  }));

test('adopt: an early row that shows ANOTHER version (a phone edit) is kept, and the draft is not bound to it', () =>
  world(async w => {
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    const d = create(w, fields());
    await wait(w, 5 * SEC);
    const upload = w.remoteDrafts.saves.at(-1)!;
    fact(w, 'rd1', 'msg-phone', { ...PHONE, internetId: upload.internetId });
    g.open();
    await w.settle();
    assert.equal(shown(w, REMOTE), true, "the phone's version stays visible");
    assert.equal(w.remoteDrafts.remote.has('rd1'), true, 'and nothing deleted it');
    assert.equal(w.remoteDrafts.removes.includes('rd1'), false);
    // Its next upload makes a fresh copy of its own: it does not point back at the copy the other row holds.
    await wait(w, 60 * SEC);
    const next = w.remoteDrafts.saves.at(-1)!;
    assert.notEqual(next.internetId, upload.internetId);
    assert.equal(next.supersedes, undefined, "no supersedes pointing at the other row's copy");
    assert.equal(next.remoteDraftId, undefined, 'a create');
    assert.notEqual(row(w, d.id)!.remote_draft_id, null, 'and it ends up bound to its own copy');
    assert.notEqual(row(w, d.id)!.remote_draft_id, 'rd1');
    assert.equal(shown(w, REMOTE), true, "the phone's version is still shown");
  }));

test('adopt: an early row the owner has edited is never given up for the reply', () =>
  world(async w => {
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    const d = create(w, fields());
    await wait(w, 5 * SEC);
    const upload = w.remoteDrafts.saves.at(-1)!;
    fact(w, 'rd1', 'msg2', { ...PHONE, internetId: upload.internetId });
    const early = read(w, REMOTE);
    const { id: _i, rev: _r, revision: _v, updatedAt: _u, origin: _o, sync: _s, ...own } = early;
    edit(w, early, { ...own, subject: 'Mine on the copy' } as Parameters<typeof edit>[2], false);
    assert.equal(row(w, REMOTE)!.origin, 'local', 'the owner took it over');
    g.open();
    await wait(w, 5 * SEC);
    assert.equal(shown(w, REMOTE), true, 'the edited row is still there');
    assert.notEqual(
      row(w, d.id)!.remote_draft_id,
      'rd1',
      'and this draft is not bound to the same remote draft',
    );
  }));

test('adopt: a create-path conflict does not bind a draft to a copy another row already shows', () =>
  world(async w => {
    w.remoteDrafts.script.push({ result: 'landedLost' }, { result: 'conflictExisting' });
    const d = create(w, fields());
    await wait(w, 5 * SEC);
    const first = w.remoteDrafts.saves.at(-1)!;
    const phoneId = w.remoteDrafts.phoneEdit('rd1');
    fact(w, 'rd1', phoneId, { ...PHONE, internetId: first.internetId });
    assert.equal(shown(w, REMOTE), true);
    await wait(w, 5 * 60 * SEC);
    assert.equal(w.remoteDrafts.saves.length >= 2, true, 'the retry ran');
    assert.equal(row(w, d.id)!.remote_draft_id, null, 'not bound to the copy the other row shows');
    assert.equal(shown(w, REMOTE), true);
    assert.equal(w.remoteDrafts.remote.has('rd1'), true);
  }));

test('adopt: an early row that is being discarded is not given up for the reply either', () =>
  world(async w => {
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    const d = create(w, fields());
    await wait(w, 5 * SEC);
    const upload = w.remoteDrafts.saves.at(-1)!;
    fact(w, 'rd1', 'msg2', { ...PHONE, internetId: upload.internetId });
    assert.equal(shown(w, REMOTE), true);
    // The owner discards the duplicate; its removal of the copy is still in flight when our reply arrives.
    const hold = gate();
    w.remoteDrafts.removeScript.push({ wait: hold.wait });
    service(w).destroy(next(), REMOTE);
    await w.settle();
    await wait(w, 5 * SEC);
    g.open();
    await w.settle();
    assert.equal(
      row(w, d.id)!.remote_draft_id === 'rd1',
      false,
      'this draft is not bound to the copy being removed',
    );
    hold.open();
    await wait(w, 60 * SEC);
    assert.equal(count(w), 1, 'the discarded row is gone, ours is left');
    assert.notEqual(row(w, d.id)!.remote_draft_id, 'rd1');
    assert.notEqual(row(w, d.id)!.remote_draft_id, null, 'and it made a copy of its own');
  }));

// ---------------------------------------------------------------- follow-ups from the #164 and #156 reviews

test('a reply written on the phone keeps its reply target, so an edit uploaded from here stays in the thread', () =>
  world(async w => {
    w.first.store.commit({
      opId: 'seed-original',
      origin: 'sync',
      writes: [
        {
          kind: 'message',
          accountId: ACCOUNT,
          remoteId: 'orig-1',
          remoteThreadId: 't-1',
          internetId: '<original@mail.example>',
          to: [{ address: 'owner@mail.example' }],
          cc: [],
          subject: 'Question',
          date: w.clock.now(),
          internalDate: w.clock.now(),
          flags: { seen: true, flagged: false, draft: false, fromMe: false },
        },
      ],
    } as never);
    w.first.store.commit({
      opId: 'phone-reply',
      origin: 'sync',
      writes: [
        {
          kind: 'remoteDraft',
          accountId: ACCOUNT,
          remoteDraftId: 'rd-reply',
          remoteMessageId: 'pm-1',
          remoteThreadId: 't-1',
          internetId: '<reply@phone.example>',
          changedAt: w.clock.now(),
          html: '<p>Answer</p>',
          message: {
            remoteId: 'pm-1',
            remoteThreadId: 't-1',
            inReplyTo: '<original@mail.example>',
            from: { address: 'owner@mail.example' },
            to: [{ address: 'jordan@mail.example' }],
            cc: [],
            bcc: [],
            subject: 'Re: Question',
            hasAttachments: false,
            date: w.clock.now(),
            internalDate: w.clock.now(),
            flags: { seen: true, flagged: false, draft: true, fromMe: true },
          },
        },
      ],
    } as never);
    const d = read(w, `${ACCOUNT}:rd-reply`);
    assert.equal(d.mode, 'reply');
    assert.equal(d.replyToMessageId, `${ACCOUNT}:orig-1`);
    assert.equal(d.threadId, `${ACCOUNT}:t-1`);
  }));

test('a phone draft that answers a message we do not hold stays a plain draft', () =>
  world(async w => {
    fact(w, 'rd-x', 'pm-1', { ...OWN, internetId: '<x@phone.example>' });
    assert.equal(read(w, `${ACCOUNT}:rd-x`).mode, 'new');
    assert.equal(read(w, `${ACCOUNT}:rd-x`).replyToMessageId, undefined);
  }));

test('an unproven copy shown for an attempt takes that id out of `earlier`, so the next create does not offer it', () =>
  world(async w => {
    const { d, first } = await lostReply(w);
    w.remoteDrafts.script.push({ result: 'lost' });
    edit(w, read(w, d.id), fields({ subject: 'Second' }), true);
    await wait(w, 5 * SEC);
    assert.deepEqual((syncOf(w, d.id) as { earlier?: string[] }).earlier, [first.internetId]);
    // The first attempt's copy comes back unproven (the phone edited it): shown, and no longer offered.
    fact(w, 'rd1', 'msg-phone', { ...PHONE, internetId: first.internetId });
    assert.equal((syncOf(w, d.id) as { earlier?: string[] }).earlier, undefined);
    assert.equal(shown(w, REMOTE), true);
  }));

test('a copy that does not say whether it has attachments is not proven ours', () =>
  world(async w => {
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    const d = create(w, fields());
    await wait(w, 5 * SEC);
    const upload = w.remoteDrafts.saves.at(-1)!;
    // Our own content, but the adapter reports nothing about attachments (neither true nor false).
    const copy = copyWrite({
      remoteDraftId: 'rd1',
      remoteMessageId: 'msg2',
      internetId: upload.internetId,
      changedAt: w.clock.now(),
    }) as unknown as { message: { hasAttachments?: boolean } };
    delete copy.message.hasAttachments;
    w.first.store.commit({ opId: 'no-attachment-report', origin: 'sync', writes: [copy] } as never);
    assert.equal(row(w, d.id)!.remote_draft_id, null, 'not adopted without a report');
    g.open();
    await w.settle();
  }));

test('a reply that names a remote draft another row shows is not bound even when this draft already holds a different copy', () =>
  world(async w => {
    const g = gate();
    w.remoteDrafts.script.push({ result: 'landedLost' }, { wait: g.wait });
    const d = create(w, fields());
    await wait(w, 5 * SEC);
    const first = w.remoteDrafts.saves.at(-1)!;
    // The edit's create (a new Message-ID) is still running when the first attempt's copy is proven and adopted.
    edit(w, read(w, d.id), fields({ subject: 'Second' }), true);
    await wait(w, 5 * SEC);
    const second = w.remoteDrafts.saves.at(-1)!;
    assert.notEqual(second.internetId, first.internetId);
    // History shows the second attempt's copy as the phone's version first (unproven: shown) ...
    fact(w, 'rd3', 'msg-phone', { ...PHONE, internetId: second.internetId });
    assert.equal(shown(w, `${ACCOUNT}:rd3`), true);
    // ... and then the first attempt's copy is proven and adopted.
    const firstMessage = w.remoteDrafts.remote.get('rd1')!.messageId;
    fact(w, 'rd1', firstMessage, { ...OWN, internetId: first.internetId });
    assert.equal(row(w, d.id)!.remote_draft_id, 'rd1', "the first attempt's copy was adopted");
    g.open();
    await w.settle();
    assert.equal(
      row(w, d.id)!.remote_draft_id,
      'rd1',
      'not re-bound to the copy the other row shows',
    );
    assert.equal(shown(w, `${ACCOUNT}:rd3`), true, 'and that row is kept');
  }));
