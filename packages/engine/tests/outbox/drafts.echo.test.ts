import test from 'node:test';
import assert from 'node:assert/strict';
import type { CommitInput } from '../../src/store';
import { ACCOUNT, fields, gate, SEC } from './helpers';
import {
  create,
  edit,
  fact,
  next,
  read,
  row,
  service,
  syncOf,
  synced,
  wait,
  world,
  type Fact,
} from './drafts.ports.kit';

/**
 * End-to-end review HIGH 1 (probe P4a): a provider that KEEPS our Message-ID across a phone edit (Gmail is believed to)
 * reports the edit under a new message id and our Message-ID. That is no echo of our upload unless its content is ours.
 */

const OWN: Fact = {
  subject: 'Lunch',
  html: '<p>Lunch at noon?</p>',
  to: [{ address: 'jordan@mail.example', name: 'Jordan' }],
};
const PHONE: Fact = { ...OWN, subject: 'Phone edit', html: '<p>PHONE TEXT</p>' };
const refused = (fn: () => unknown) => assert.throws(fn, /./);

test('echo: a phone edit under our Message-ID with a new message id is shown as a conflict with both bodies', () =>
  world(async w => {
    const s = await synced(w);
    // The owner has an unsent local edit when the phone's edit (same Message-ID, new message id, body delivered) arrives.
    edit(w, s.draft, fields({ subject: 'Mine' }), false);
    const phoneId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, phoneId, { ...PHONE, internetId: s.internetId });
    const d = read(w, s.draft.id);
    assert.ok(d.conflict, 'the edit is not dropped as an echo');
    assert.equal(syncOf(w, s.draft.id).conflict?.complete, true, 'and both bodies are available');
    service(w).resolve(next(), s.draft.id, 'takeTheirs');
    assert.match(read(w, s.draft.id).html, /PHONE TEXT/);
  }));

test('echo: the same phone edit on a clean draft is shown, not hidden', () =>
  world(async w => {
    const s = await synced(w);
    const phoneId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, phoneId, { ...PHONE, internetId: s.internetId });
    assert.match(read(w, s.draft.id).html, /PHONE TEXT/);
    assert.equal(row(w, s.draft.id)!.remote_message_id, phoneId);
  }));

test('echo: a report with no body under our Message-ID and a new message id is not taken as our echo', () =>
  world(async w => {
    const s = await synced(w);
    edit(w, s.draft, fields({ subject: 'Mine' }), false);
    const phoneId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, phoneId, { internetId: s.internetId });
    assert.ok(read(w, s.draft.id).conflict, 'the owner is asked');
  }));

test('echo (probe P4a): when the other version never arrived whole, keep mine makes a NEW copy and the phone edit survives', () =>
  world(async w => {
    const s = await synced(w);
    const phoneId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    // History never reports the phone edit again; the owner edits and the upload meets the changed copy.
    edit(w, s.draft, fields({ subject: 'Mine' }), true);
    await wait(w, 5 * SEC);
    const d = read(w, s.draft.id);
    assert.ok(d.conflict, 'the upload found the copy changed');
    refused(() => service(w).resolve(next(), s.draft.id, 'takeTheirs'));
    service(w).resolve(next(), s.draft.id, 'keepMine');
    await w.settle();
    const last = w.remoteDrafts.saves.at(-1)!;
    assert.equal(
      last.remoteDraftId,
      undefined,
      'a new copy, not an update over the unseen version',
    );
    assert.equal(
      w.remoteDrafts.remote.get(s.remoteDraftId)?.messageId,
      phoneId,
      'the phone edit is untouched',
    );
    assert.equal(read(w, s.draft.id).sync, 'synced');
  }));

test('echo: our own copy still counts as our echo when its content is ours', () =>
  world(async w => {
    const s = await synced(w);
    // History re-reports our own copy under a new message id (a normalised re-save) with the same content.
    fact(w, s.remoteDraftId, 'msg-same', { ...OWN, internetId: s.internetId });
    assert.equal(read(w, s.draft.id).conflict, undefined);
    assert.match(read(w, s.draft.id).html, /Lunch at noon/);
  }));

test("log: a removal with no draft row that keeps failing is logged without the provider's draft id", () =>
  world(async w => {
    const g = gate();
    w.remoteDrafts.script.push({ wait: g.wait });
    const d = create(w, fields());
    await wait(w, 5 * SEC);
    service(w).destroy(next(), d.id);
    w.first.store.commit({
      opId: next(),
      origin: 'system',
      writes: [{ kind: 'draftDelete', id: d.id, at: w.clock.now(), final: true }],
    });
    for (let i = 0; i < 5; i++) w.remoteDrafts.removeScript.push({ result: 'notSent' });
    g.open();
    await wait(w, 5 * 60 * SEC);
    const failed = w.events('draft.sync_failed');
    assert.ok(failed.length > 0, 'the failure was logged');
    for (const r of failed) {
      const text = JSON.stringify(r);
      assert.equal(text.includes('rd1'), false, 'the provider draft id is not written');
      assert.match(String(r.data?.draft), /^r[0-9a-f]{16}$/);
    }
  }));

test('a send that is done but whose clean-up has not run still pins the draft: a phone edit is held, then shown as a draft of its own', () =>
  world(async w => {
    const s = await synced(w);
    // The hidden-row clean-up is held up, so the submission is `sent` at the current revision but the draft row remains.
    for (let i = 0; i < 20; i++)
      w.faults.push((input: CommitInput) => input.writes[0]?.kind === 'draftDelete');
    w.send(w.first, s.draft.id, { revision: read(w, s.draft.id).revision });
    await wait(w, 15 * SEC);
    const states = w.first.store.read(q =>
      q.all<{ state: string }>('SELECT state FROM submissions WHERE draft_id = ?', s.draft.id),
    );
    assert.deepEqual(
      states.map(r => r.state),
      ['sent'],
    );
    const revision = row(w, s.draft.id)!.revision;
    const phoneId = w.remoteDrafts.phoneEdit(s.remoteDraftId);
    fact(w, s.remoteDraftId, phoneId, { ...PHONE, internetId: 'theirs-id@phone.example' });
    assert.equal(
      row(w, s.draft.id)!.revision,
      revision,
      'the sent draft was not rewritten under its send',
    );
    assert.equal(
      typeof (syncOf(w, s.draft.id) as { changedElsewhere?: unknown }).changedElsewhere,
      'object',
      'the report is held',
    );
    w.faults.length = 0;
    await wait(w, 30 * SEC);
    assert.match(
      read(w, `${ACCOUNT}:${s.remoteDraftId}`).html,
      /PHONE TEXT/,
      'and shown once the draft is gone',
    );
  }));
