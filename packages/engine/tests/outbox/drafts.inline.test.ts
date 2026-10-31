import test from 'node:test';
import assert from 'node:assert/strict';
import { hasInlineRef } from '../../src/outbox/draft-state';
import { ACCOUNT, fields } from './helpers';
import { edit, fact, read, row, syncOf, synced, wait, world } from './drafts.ports.kit';

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

test('inline: the text "CID:" in prose or a link is not an inline reference (the other device\'s edit is still taken)', () =>
  world(async w => {
    const s = await synced(w);
    fact(w, s.remoteDraftId, 'msg-phone', {
      subject: 'Lunch',
      html: '<p>Customer CID: 4471, see <a href="https://x.example/?cid:1">the file</a></p>',
      to: [{ address: 'jordan@mail.example', name: 'Jordan' }],
      internetId: '<phone@phone.example>',
    });
    assert.equal(read(w, s.draft.id).conflict, undefined, 'replaced silently, like any other edit');
    assert.match(read(w, s.draft.id).html, /Customer CID: 4471/);
  }));

const REFERENCES: [string, string][] = [
  ['src, double quotes', '<img src="cid:a">'],
  ['src, single quotes', "<img src='cid:a'>"],
  ['src, no quotes, any case', '<IMG SRC = CID:a>'],
  ['background attribute', '<table background=cid:a>'],
  ['url() in a style', '<div style="background:url(cid:a)">'],
  [
    'url() with entity quotes (a browser serialises a CSS background so)',
    '<div style="background-image: url(&quot;cid:a&quot;)">',
  ],
  ['a numeric character reference inside the scheme', '<img src="&#99;id:a">'],
  ['a hex character reference inside the scheme', '<img src="&#x63;id:a">'],
  ['srcset, first candidate', '<img srcset="cid:a 1x">'],
  ['srcset, later candidate', '<img srcset="b.png 1x, cid:a 2x">'],
  ['object data', '<object data="cid:a"></object>'],
  ["Outlook's text placeholder", '<p>[cid:image001.png@01D9.1]</p>'],
];

for (const [name, html] of REFERENCES)
  test(`inline: ${name} is an inline reference`, () =>
    assert.equal(hasInlineRef(html), true, html));

test('inline: prose, links and look-alikes are not inline references', () => {
  for (const html of [
    '<p>cid: 5</p>',
    '<p>Customer CID: 4471</p>',
    '<a href="https://x/?cid:1">x</a>',
    '<p>Antacid: ok</p>',
    '<img src="data:image/png;base64,AAAA">',
    '<p>&amp;cid: and &lt;cid:&gt;</p>',
    '<p>[cid]</p>',
  ])
    assert.equal(hasInlineRef(html), false, html);
});

test('inline: a numeric reference outside the range does not throw', () => {
  assert.equal(hasInlineRef('<p>&#99999999999;&#0;&#xZZ;</p>'), false);
});

test('inline: each form keeps a clean draft from being replaced silently, when the provider reports no parts', () =>
  world(async w => {
    const s = await synced(w);
    fact(w, s.remoteDraftId, 'msg-phone', {
      subject: 'Lunch',
      html: '<div style="background-image: url(&quot;cid:a&quot;)">hi</div>',
      to: [{ address: 'jordan@mail.example', name: 'Jordan' }],
      internetId: '<phone@phone.example>',
    });
    assert.ok(read(w, s.draft.id).conflict, 'the owner is asked');
    assert.equal(read(w, s.draft.id).html, '<p>Lunch at noon?</p>');
  }));

test('inline: a text-only copy with the placeholder is incomplete too', () =>
  world(async w => {
    fact(w, 'rd-text', 'pm-1', {
      text: 'Hi\n\n[cid:image001.png@01D9.1]',
      internetId: '<t1@phone.example>',
    });
    assert.equal(syncOf(w, `${ACCOUNT}:rd-text`).incomplete, true);
  }));

test('inline: our own echo with a cid reference in the body but no listed attachment gets no content proof (the completes() half)', () =>
  world(async w => {
    const body = '<p>Look <img src="cid:photo@phone.example"></p>';
    const s = await synced(w, fields({ html: body }));
    w.remoteDrafts.script.push({ result: 'lost' });
    edit(w, s.draft, fields({ html: body, subject: 'Second' }), true);
    await wait(w, 1);
    const attempt = w.remoteDrafts.saves.at(-1)!;
    fact(w, s.remoteDraftId, 'msg-c', {
      internetId: attempt.internetId,
      supersedes: [s.messageId],
      subject: 'Second',
      html: body,
      to: [{ address: 'jordan@mail.example', name: 'Jordan' }],
    });
    assert.equal(
      row(w, s.draft.id)!.remote_message_id,
      s.messageId,
      'the base did not move on content alone',
    );
  }));
