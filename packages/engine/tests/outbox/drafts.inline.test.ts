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
  ['xlink:href', '<use xlink:href="cid:a"/>'],
  ['spaces and a quote before the scheme', '<img src = "  cid:a">'],
  ['url() with spaces and newlines inside', '<div style="background:url( \n cid:a )">'],
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

/** Hostile bodies of `size` characters; the shapes that made an earlier pattern quadratic come first. */
const hostileBodies = (size: number) => [
  `<img src=${' '.repeat(size)}`,
  `<div style="background:url(${' '.repeat(size)}`,
  `<img src=${' '.repeat(size / 2)}"${' '.repeat(size / 2)}`,
  `<img src=${'"'.repeat(size)}`,
  `<a xlink:href=${"='".repeat(size / 2)}`,
  `<img srcset="${'a '.repeat(size / 2)}`,
  `<img src=${'&#32;'.repeat(size / 5)}`,
  '&'.repeat(size),
  `&${'a'.repeat(size)}`,
  'src='.repeat(size / 4),
  'url('.repeat(size / 4),
];

/** The best of `rounds` timed scans of `html`, in ms. */
function scanTime(html: string, rounds: number): number {
  let best = Infinity;
  for (let round = 0; round < rounds; round++) {
    const start = performance.now();
    assert.equal(hasInlineRef(html), false);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

// A regression is quadratic, so the small size fails fast (30k spaces took 2 s with the old pattern, 100k took 22 s)
// instead of hanging the run on the 1 MB size.
test('inline: hostile bodies of 30000 characters are scanned in linear time', () => {
  for (const html of hostileBodies(30_000)) {
    const took = scanTime(html, 1);
    assert.ok(took < 500, `${took.toFixed(0)} ms for ${html.slice(0, 24)}...`);
  }
});

// The 1 MB size is judged by its ratio to a 50,000-character run of the same shape in the same test, not by a wall
// clock: linear is about 20x (measured 137-202 ms for 1 MB alone, which a loaded machine pushed over a fixed line),
// quadratic is 400x. The limit is 200 because the `&#32;` shape grows a little faster than linear (82-128x measured on a
// loaded machine, Integrator review of #171); a real regression is caught by the 30,000-character test above and by the
// 5 s ceiling below (quadratic at 1 MB is over 20 s). The 50k run goes first and fails fast if it is already slow.
const SMALL = 50_000;
const LARGE = 1_000_000;
const LINEAR_RATIO_LIMIT = 200;

test(`inline: hostile bodies of ${LARGE} characters are scanned in linear time`, () => {
  const small = hostileBodies(SMALL);
  const large = hostileBodies(LARGE);
  small.forEach((html, index) => {
    const name = html.slice(0, 24);
    assert.ok(scanTime(html, 1) < 250, `${SMALL} characters already slow for ${name}...`);
    const smallMs = Math.max(scanTime(html, 5), 0.1);
    const largeMs = scanTime(large[index], 2);
    const ratio = largeMs / smallMs;
    assert.ok(
      ratio < LINEAR_RATIO_LIMIT,
      `${ratio.toFixed(0)}x for ${LARGE / SMALL}x the input (${name}...)`,
    );
    assert.ok(largeMs < 5_000, `${largeMs.toFixed(0)} ms for ${name}...`);
  });
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
