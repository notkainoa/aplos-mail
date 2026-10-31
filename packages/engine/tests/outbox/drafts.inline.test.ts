import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT } from './helpers';
import { fact, read, row, syncOf, synced, world } from './drafts.ports.kit';

/**
 * BINDING (4): inline parts. A copy whose body points at an inline part (`cid:`) is not complete: its image is not
 * delivered, so building a draft from it would show a broken reference and a replace would drop this device's own
 * inline image.
 */

const CID = '<p>Look <img src="cid:photo@phone.example"></p>';

test('inline: a clean draft is not replaced silently by a copy that points at an inline image', () =>
  world(async w => {
    const s = await synced(w);
    fact(w, s.remoteDraftId, 'msg-phone', {
      subject: 'Lunch',
      html: CID,
      to: [{ address: 'jordan@mail.example', name: 'Jordan' }],
      internetId: '<phone@phone.example>',
    });
    const d = read(w, s.draft.id);
    assert.equal(d.html, '<p>Lunch at noon?</p>', 'our body is untouched');
    assert.ok(d.conflict, 'the owner is asked');
    assert.equal(
      syncOf(w, s.draft.id).conflict?.complete,
      false,
      'and take theirs is not offered as complete',
    );
    assert.equal(row(w, s.draft.id)!.remote_message_id, s.messageId);
  }));

test('inline: a copy without inline references is still replaced silently (control)', () =>
  world(async w => {
    const s = await synced(w);
    fact(w, s.remoteDraftId, 'msg-phone', {
      subject: 'Lunch',
      html: '<p>Antacid: no change, a word that only ends in cid</p>',
      to: [{ address: 'jordan@mail.example', name: 'Jordan' }],
      internetId: '<phone@phone.example>',
    });
    assert.equal(read(w, s.draft.id).conflict, undefined);
    assert.match(read(w, s.draft.id).html, /Antacid/);
  }));

test('inline: a phone draft with an inline reference is stored incomplete', () =>
  world(async w => {
    fact(w, 'rd-inline', 'pm-1', { html: CID, internetId: '<i1@phone.example>' });
    assert.equal(syncOf(w, `${ACCOUNT}:rd-inline`).incomplete, true);
  }));
