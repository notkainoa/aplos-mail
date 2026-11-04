import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT, fields, gate, SEC } from './helpers';
import type { CommitExtensionTx, RemoteDraftWrite } from '../../src/store';
import { provenOurs } from '../../src/outbox/draft-proof';
import {
  fingerprintOf,
  theirsFields,
  type DraftMeta,
  type DraftRow,
} from '../../src/outbox/draft-state';
import { messageOf } from '../../src/outbox/draft-body';
import { edit, fact, read, row, syncOf, synced, wait, world, type Fact } from './drafts.ports.kit';

/**
 * Gmail does not keep the Message-ID we upload (first live draft probe): it shows its own, and changes it with every
 * save, while the draft id stays. These tests run the draft engine against a provider like that: our own copy must be
 * recognised by the draft id plus the content proof, and a copy of another device must still not be.
 */

const OWN: Fact = {
  subject: 'Mine',
  html: '<p>Lunch at noon?</p>',
  to: [{ address: 'jordan@mail.example', name: 'Jordan' }],
};

const MINE = () => fields({ subject: 'Mine' });

test('gmail ids: the answer to an update is lost and history reports the new copy under Gmail’s Message-ID: it is our echo, no conflict', () =>
  world(async w => {
    w.remoteDrafts.state.gmailIds = true;
    const s = await synced(w);
    edit(w, s.draft, MINE(), true);
    w.remoteDrafts.script.push({ result: 'landedLost' });
    await wait(w, 5 * SEC);
    const copy = w.remoteDrafts.remote.get(s.remoteDraftId)!;
    assert.notEqual(copy.messageId, s.messageId, 'the update landed under a new message id');
    fact(w, s.remoteDraftId, copy.messageId, {
      ...OWN,
      internetId: copy.internetId,
      supersedes: [s.messageId],
    });
    assert.equal(read(w, s.draft.id).conflict, undefined, 'our own write is no remote edit');
    assert.equal(row(w, s.draft.id)!.remote_message_id, copy.messageId, 'the base moved to it');
    await wait(w, 60 * SEC);
    assert.equal(read(w, s.draft.id).conflict, undefined);
  }));

test('gmail ids: an earlier attempt’s copy reported while a newer upload runs is our echo (its content is a recent upload of ours)', () =>
  world(async w => {
    w.remoteDrafts.state.gmailIds = true;
    const s = await synced(w);
    const first = gate();
    const second = gate();
    w.remoteDrafts.script.push({ wait: first.wait, result: 'landedLost' }, { wait: second.wait });
    // Attempt A is held; the owner edits again; A lands and its answer is lost; the retry uploads the newer content.
    edit(w, s.draft, MINE(), true);
    await wait(w, 5 * SEC);
    edit(w, read(w, s.draft.id), fields({ subject: 'Newer' }), true);
    first.open();
    await w.settle();
    await wait(w, 60 * SEC);
    const copy = w.remoteDrafts.remote.get(s.remoteDraftId)!;
    // History reports attempt A's copy under Gmail’s Message-ID while the newer upload (attempt B) is still running.
    fact(w, s.remoteDraftId, copy.messageId, {
      ...OWN,
      internetId: copy.internetId,
      supersedes: [s.messageId],
    });
    assert.equal(read(w, s.draft.id).conflict, undefined, 'attempt A’s copy is ours');
    assert.equal(row(w, s.draft.id)!.remote_message_id, copy.messageId, 'the base moved to it');
    second.open();
    await w.settle();
  }));

test('gmail ids: a phone edit under a Message-ID we never used is still another device’s edit', () =>
  world(async w => {
    w.remoteDrafts.state.gmailIds = true;
    const s = await synced(w);
    edit(w, s.draft, MINE(), false);
    const phoneId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, phoneId, {
      ...OWN,
      subject: 'Phone edit',
      html: '<p>PHONE TEXT</p>',
      internetId: '<CAphone@mail.gmail.com>',
      supersedes: [s.messageId],
    });
    assert.ok(read(w, s.draft.id).conflict, 'the content is not that of any upload of ours');
  }));

test('gmail ids: while an upload is held open, a phone edit under a new Message-ID with other content is a conflict and the base does not move', () =>
  world(async w => {
    w.remoteDrafts.state.gmailIds = true;
    const s = await synced(w);
    const held = gate();
    w.remoteDrafts.script.push({ wait: held.wait });
    edit(w, s.draft, MINE(), true);
    await wait(w, 5 * SEC);
    assert.ok(syncOf(w, s.draft.id).uploading, 'the upload is running');
    // The draft id is the same and an upload of ours runs, but the content is the phone's own: nothing proves it ours.
    const phoneId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, phoneId, {
      ...OWN,
      subject: 'Phone edit',
      html: '<p>PHONE TEXT</p>',
      internetId: '<CAphone@mail.gmail.com>',
      supersedes: [s.messageId],
    });
    assert.ok(read(w, s.draft.id).conflict, 'the phone edit is asked about, not absorbed');
    assert.equal(
      row(w, s.draft.id)!.remote_message_id,
      s.messageId,
      'the base stayed where it was',
    );
    held.open();
    await w.settle();
  }));

test('gmail ids: a provider that keeps our Message-ID: a phone edit restoring an older attempt’s content under a newer attempt’s id is another device’s edit', () =>
  world(async w => {
    const s = await synced(w);
    const [g1, g2, g3] = [gate(), gate(), gate()];
    w.remoteDrafts.script.push(
      { wait: g1.wait, result: 'landedLost' },
      { wait: g2.wait, result: 'landedLost' },
      { wait: g3.wait },
    );
    // Attempts A and B each land and lose their answer while the owner keeps editing; C is the running upload.
    edit(w, s.draft, fields({ subject: 'Mine' }), true);
    await wait(w, 5 * SEC);
    edit(w, read(w, s.draft.id), fields({ subject: 'Second' }), true);
    g1.open();
    await w.settle();
    await wait(w, 60 * SEC);
    edit(w, read(w, s.draft.id), fields({ subject: 'Third' }), true);
    g2.open();
    await w.settle();
    await wait(w, 60 * SEC);
    // The copy shows attempt B's Message-ID (kept by the provider); the phone restored attempt A's content.
    const copy = w.remoteDrafts.remote.get(s.remoteDraftId)!;
    const [attemptA, attemptB] = Object.keys(syncOf(w, s.draft.id).prints ?? {});
    assert.equal(copy.internetId, attemptA, 'the provider holds attempt A’s copy');
    const phoneId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, phoneId, { ...OWN, internetId: attemptB, supersedes: [s.messageId] });
    assert.ok(
      read(w, s.draft.id).conflict,
      'a known Message-ID: the draft id alone proves nothing',
    );
    g3.open();
    await w.settle();
  }));

test('gmail ids: copyInternetId in the answer makes a later report under it, with the upload’s content, an echo', () =>
  world(async w => {
    w.remoteDrafts.state.gmailIds = true;
    w.remoteDrafts.state.reportCopy = true;
    const s = await synced(w);
    edit(w, s.draft, MINE(), true);
    await wait(w, 5 * SEC);
    const saved = row(w, s.draft.id)!;
    const copy = w.remoteDrafts.remote.get(s.remoteDraftId)!;
    assert.ok(syncOf(w, s.draft.id).wrote?.includes(copy.internetId), 'remembered next to ours');
    // Gmail re-reports the copy under a new message id and the same Message-ID, without saying what it replaces.
    const touched = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, touched, { ...OWN, internetId: copy.internetId });
    assert.equal(read(w, s.draft.id).conflict, undefined);
    assert.match(read(w, s.draft.id).subject, /Mine/, 'nothing replaced the draft');
    assert.equal(saved.revision, row(w, s.draft.id)!.revision, 'and no new revision was made');
  }));

test('gmail ids: without copyInternetId a bare report with a new message id and the upload’s content is not taken as our echo', () =>
  world(async w => {
    w.remoteDrafts.state.gmailIds = true;
    const s = await synced(w);
    edit(w, s.draft, MINE(), true);
    await wait(w, 5 * SEC);
    const copy = w.remoteDrafts.remote.get(s.remoteDraftId)!;
    const touched = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    const before = row(w, s.draft.id)!.revision;
    fact(w, s.remoteDraftId, touched, { ...OWN, internetId: copy.internetId });
    // Same content, new message id, nothing to say it is ours: the ordinary path (a clean draft takes the report).
    assert.equal(row(w, s.draft.id)!.remote_message_id, touched);
    assert.ok(
      row(w, s.draft.id)!.revision > before,
      'it went the ordinary way, not dropped as an echo',
    );
  }));

test('gmail ids: by the draft id alone only a RUNNING upload lets an older attempt’s content prove a copy (unit)', () => {
  const own = 'owner@mail.example';
  const base = fields({ subject: 'Mine' });
  const tx = { get: () => ({ address: own }) } as unknown as CommitExtensionTx;
  const w = {
    kind: 'remoteDraft',
    accountId: ACCOUNT,
    remoteDraftId: 'rd1',
    remoteMessageId: 'm9',
    changedAt: 1,
    internetId: '<CAstale@mail.gmail.com>',
    html: '<p>Lunch at noon?</p>',
    message: {
      remoteId: 'm9',
      to: [{ address: 'jordan@mail.example', name: 'Jordan' }],
      from: { address: own },
      cc: [],
      bcc: [],
      subject: 'Mine',
      snippet: 's',
      date: 1,
      internalDate: 1,
      flags: { seen: true, flagged: false, draft: true, fromMe: true },
      hasAttachments: false,
    },
  } as unknown as RemoteDraftWrite;
  const print = fingerprintOf(theirsFields(ACCOUNT, messageOf(w), base, own).fields);
  const row = { account_id: ACCOUNT, remote_draft_id: 'rd1', remote_internet_id: null } as DraftRow;
  const old: DraftMeta = { rev: 1, prints: { '<attemptA@mail.example>': print } };
  assert.equal(
    provenOurs(tx, row, old, base, w),
    false,
    'no upload running: an older attempt’s content proves nothing',
  );
  const running: DraftMeta = {
    ...old,
    uploading: { internetId: '<attemptB@mail.example>', revision: 3 },
  };
  assert.equal(
    provenOurs(tx, row, running, base, w),
    true,
    'while an upload runs, an attempt set aside does',
  );
  const keeps: DraftMeta = { ...running, wrote: ['<CAstale@mail.gmail.com>'] };
  assert.equal(
    provenOurs(tx, row, keeps, base, w),
    false,
    'a Message-ID this row used is keyed by its own attempt',
  );
  const bound = { ...row, remote_internet_id: '<CAstale@mail.gmail.com>' } as DraftRow;
  assert.equal(
    provenOurs(tx, bound, running, base, w),
    false,
    'the id the row is synced under counts as used',
  );
});
