import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT, fields, gate, SEC } from './helpers';
import {
  count,
  create,
  edit,
  fact,
  read,
  row,
  service,
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

test("adopt: an unproven copy shown early is dropped when the upload's own reply names the same remote draft", () =>
  world(async w => {
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    const d = create(w, fields());
    await wait(w, 5 * SEC);
    const upload = w.remoteDrafts.saves.at(-1)!;
    // History is faster than the reply and cannot show the body: shown for now.
    fact(w, 'rd1', 'msg-early', { internetId: upload.internetId });
    assert.equal(shown(w, REMOTE), true);
    g.open();
    await wait(w, 5 * SEC);
    assert.equal(row(w, d.id)!.remote_draft_id, 'rd1', 'the reply bound the copy to this draft');
    assert.equal(shown(w, REMOTE), false, 'the early row was the same copy and is gone');
    assert.equal(count(w), 1);
  }));
