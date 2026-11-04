import test from 'node:test';
import assert from 'node:assert/strict';
import type { CommitInput } from '../../src/store';
import { ACCOUNT, fields, gate, SEC } from './helpers';
import {
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
 * Three LOW follow-ups of the draft engine (the rule: the other device's only copy of a draft, or a sent message, is never
 * silently overwritten, deleted or resurrected): a discarded draft's adopted copy is still deleted, a copy that is already
 * sent is not "the same copy", and a phone reply finds its parent (the right one, and when it syncs late).
 */

const OWN: Fact = {
  subject: 'Lunch',
  html: '<p>Lunch at noon?</p>',
  to: [{ address: 'jordan@mail.example', name: 'Jordan' }],
};
const PHONE: Fact = { ...OWN, subject: 'Phone edit', html: '<p>Phone wrote this</p>' };
const REMOTE = `${ACCOUNT}:rd1`;
const shown = (w: Parameters<typeof create>[0], id: string) =>
  service(w).get([id]).notFound.length === 0;

// ---------------------------------------------------------------- 1: a discarded draft's adopted copy

test('a discarded draft that holds an adopted copy still deletes it when its running upload names a copy another row shows', () =>
  world(async w => {
    // The first create landed and its reply was lost; history shows the unedited copy and the draft adopts it (rd1).
    w.remoteDrafts.script.push({ result: 'landedLost' });
    const d = create(w, fields());
    await wait(w, 5 * SEC);
    const first = w.remoteDrafts.saves.at(-1)!;
    fact(w, 'rd1', w.remoteDrafts.remote.get('rd1')!.messageId, {
      ...OWN,
      internetId: first.internetId,
    });
    assert.equal(row(w, d.id)!.remote_draft_id, 'rd1', 'adopted');
    // An edit uploads again, and the provider answers with a NEW remote draft (an update that creates one).
    const hold = gate();
    w.remoteDrafts.script.push({ wait: hold.wait, renameTo: 'rd-b' });
    edit(w, read(w, d.id), fields({ subject: 'Second' }), true);
    await wait(w, 5 * SEC);
    // History shows that new draft as another version (a phone edit), then the owner discards our draft.
    fact(w, 'rd-b', 'msg-phone', { ...PHONE, internetId: '<phone-b@mail.example>' });
    service(w).destroy(next(), d.id);
    hold.open();
    await wait(w, 60 * SEC);
    assert.equal(w.remoteDrafts.removes.includes('rd1'), true, 'the adopted copy is deleted');
    assert.equal(w.remoteDrafts.remote.has('rd1'), false);
    assert.equal(row(w, d.id), undefined, 'and the hidden row ends');
    assert.equal(shown(w, `${ACCOUNT}:rd-b`), true, "the other row's copy is left alone");
    assert.equal(w.remoteDrafts.removes.includes('rd-b'), false);
  }));

test('a discarded draft with no copy of its own deletes nothing when its upload names a copy another row shows', () =>
  world(async w => {
    const hold = gate();
    w.remoteDrafts.script.push({ wait: hold.wait });
    const d = create(w, fields());
    await wait(w, 5 * SEC);
    const upload = w.remoteDrafts.saves.at(-1)!;
    fact(w, 'rd1', 'msg-phone', { ...PHONE, internetId: upload.internetId });
    service(w).destroy(next(), d.id);
    hold.open();
    await wait(w, 60 * SEC);
    assert.equal(row(w, d.id), undefined, 'the hidden row ends');
    assert.equal(w.remoteDrafts.removes.length, 0, 'nothing was deleted');
    assert.equal(shown(w, REMOTE), true, "the other row's copy stays");
  }));

// ---------------------------------------------------------------- 1b: a copy that is already sent is not the same copy

test('an early row whose send is done is not "the same copy" as the upload that names it', () =>
  world(async w => {
    const hold = gate();
    w.remoteDrafts.script.push({ wait: hold.wait });
    const d = create(w, fields());
    await wait(w, 5 * SEC);
    const upload = w.remoteDrafts.saves.at(-1)!;
    // History shows a complete copy (it differs from ours, so it is a draft of its own) before the reply arrives.
    fact(w, 'rd1', 'msg2', { ...PHONE, internetId: upload.internetId });
    assert.equal(shown(w, REMOTE), true);
    // The owner sends that row. Its hidden-row clean-up is held up, so the row is `sent` but not yet removing.
    for (let i = 0; i < 20; i++)
      w.faults.push((input: CommitInput) => input.writes[0]?.kind === 'draftDelete');
    await w.send(w.first, REMOTE, { revision: read(w, REMOTE).revision });
    await wait(w, 15 * SEC);
    const states = w.first.store.read(q =>
      q.all<{ state: string }>('SELECT state FROM submissions WHERE draft_id = ?', REMOTE),
    );
    assert.deepEqual(
      states.map(s => s.state),
      ['sent'],
    );
    assert.equal(syncOf(w, REMOTE).removing, undefined, 'not hidden yet');
    w.faults.length = 0;
    hold.open();
    await w.settle();
    assert.notEqual(
      row(w, d.id)!.remote_draft_id,
      'rd1',
      'our draft is not bound to the sent copy',
    );
    assert.notEqual(row(w, REMOTE), undefined, 'and the sent row was not dropped for it');
  }));

// ---------------------------------------------------------------- 2 and 3: the parent of a phone reply

type W = Parameters<typeof create>[0];
let replies = 0;

function parent(w: W, remoteId: string, thread: string) {
  w.first.store.commit({
    opId: `parent-${remoteId}`,
    origin: 'sync',
    writes: [
      {
        kind: 'message',
        accountId: ACCOUNT,
        remoteId,
        remoteThreadId: thread,
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
}

function phoneReply(w: W, messageId: string, subject = 'Re: Question', body = true) {
  w.first.store.commit({
    opId: `reply-${++replies}`,
    origin: 'sync',
    writes: [
      {
        kind: 'remoteDraft',
        accountId: ACCOUNT,
        remoteDraftId: 'rd-reply',
        remoteMessageId: messageId,
        remoteThreadId: 't-1',
        internetId: '<reply@phone.example>',
        changedAt: w.clock.now(),
        ...(body ? { html: '<p>Answer</p>' } : {}),
        message: {
          snippet: 'Ans',
          remoteId: messageId,
          remoteThreadId: 't-1',
          inReplyTo: '<original@mail.example>',
          from: { address: 'owner@mail.example' },
          to: [{ address: 'jordan@mail.example' }],
          cc: [],
          bcc: [],
          subject,
          hasAttachments: false,
          date: w.clock.now(),
          internalDate: w.clock.now(),
          flags: { seen: true, flagged: false, draft: true, fromMe: true },
        },
      },
    ],
  } as never);
}

const REPLY = `${ACCOUNT}:rd-reply`;

test('a Message-ID stored twice: the reply targets the message in the draft’s own thread, not the older one', () =>
  world(async w => {
    // The lower id (older) is in another thread; the one in the draft's thread is stored later.
    parent(w, 'other-1', 't-other');
    await wait(w, 10 * SEC);
    parent(w, 'mine-1', 't-1');
    phoneReply(w, 'pm-1');
    assert.equal(read(w, REPLY).replyToMessageId, `${ACCOUNT}:mine-1`);
    assert.equal(read(w, REPLY).mode, 'reply');
  }));

test('a Message-ID stored twice, none in the draft’s thread: the oldest stored message, deterministically', () =>
  world(async w => {
    parent(w, 'a-1', 't-a');
    await wait(w, 10 * SEC);
    parent(w, 'b-1', 't-b');
    phoneReply(w, 'pm-1');
    assert.equal(read(w, REPLY).replyToMessageId, `${ACCOUNT}:a-1`);
  }));

test('a phone reply whose parent syncs later becomes a reply to it when the draft is reported again', () =>
  world(async w => {
    phoneReply(w, 'pm-1');
    assert.equal(read(w, REPLY).mode, 'new', 'the parent is not stored yet');
    assert.equal(read(w, REPLY).replyToMessageId, undefined);
    const before = read(w, REPLY).revision;
    parent(w, 'orig-1', 't-1');
    phoneReply(w, 'pm-1'); // the same version again
    const d = read(w, REPLY);
    assert.equal(d.mode, 'reply');
    assert.equal(d.replyToMessageId, `${ACCOUNT}:orig-1`);
    assert.equal(d.threadId, `${ACCOUNT}:t-1`);
    assert.equal(d.revision, before + 1);
    // Once it is a reply, the same version again changes nothing.
    phoneReply(w, 'pm-1', 'Re: Question');
    assert.equal(read(w, REPLY).revision, before + 1);
  }));

test('a reply that a phone edits keeps its reply target', () =>
  world(async w => {
    parent(w, 'orig-1', 't-1');
    phoneReply(w, 'pm-1');
    phoneReply(w, 'pm-2', 'Re: Question (edited)');
    const d = read(w, REPLY);
    assert.equal(d.subject, 'Re: Question (edited)');
    assert.equal(d.replyToMessageId, `${ACCOUNT}:orig-1`);
  }));

test('the parent found on a same-version report that carries no body keeps the stored body', () =>
  world(async w => {
    phoneReply(w, 'pm-1');
    assert.equal(read(w, REPLY).html, '<p>Answer</p>');
    parent(w, 'orig-1', 't-1');
    phoneReply(w, 'pm-1', 'Re: Question', false); // the same version, reported without its body
    const d = read(w, REPLY);
    assert.equal(d.replyToMessageId, `${ACCOUNT}:orig-1`, 'the reply target was added');
    assert.equal(d.html, '<p>Answer</p>', 'and the stored body is untouched');
    assert.equal(syncOf(w, REPLY).incomplete, undefined, 'still a complete draft');
  }));

test('a late-found parent is not added while a send of the phone reply is queued: the draft still leaves Drafts once sent', () =>
  world(async w => {
    phoneReply(w, 'pm-1');
    assert.equal(read(w, REPLY).mode, 'new', 'the parent is not stored yet');
    const sub = await w.send(w.first, REPLY, { revision: read(w, REPLY).revision });
    const queued = read(w, REPLY).revision;
    // The parent syncs and history reports the same version again while the send waits.
    parent(w, 'orig-1', 't-1');
    phoneReply(w, 'pm-1');
    assert.equal(
      read(w, REPLY).revision,
      queued,
      'the revision did not move under the queued send',
    );
    await wait(w, 15 * SEC);
    assert.equal(w.get(sub.id).state, 'sent');
    assert.equal(service(w).get([REPLY]).notFound.length, 1, 'the sent draft is gone from Drafts');
  }));

test('a late-found parent is still added when no send is queued (control)', () =>
  world(async w => {
    phoneReply(w, 'pm-1');
    parent(w, 'orig-1', 't-1');
    phoneReply(w, 'pm-1');
    assert.equal(read(w, REPLY).mode, 'reply');
  }));
