/**
 * A plain email (owner request 2026-11-10) is drawn straight on the reader card in the app's own type and colours, in both
 * themes; a rich one (a newsletter, anything with its own colours, images or tables) keeps its light paper. Stand-in frame
 * document and host sheet; the sealed frame has the same rule in packages/mail-html (tests/plain.test.ts).
 * Run: cd apps/desktop && npx tsx --test src/renderer/mailframe/plain.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { frameDocument } from './document';
import { FRAME_DARK, FRAME_PAPER, PLAIN_LIGHT_SURFACE, isPlainSurface, sheetOf } from './paper';
import { isPlainBody } from './plain';
import { sanitiseBody } from './sanitise';

const PLAIN =
  '<p>Saw that you signed up.</p><p><b>To get started</b>, <a href="https://example.com/x">open the site</a>.</p><ul><li>one</li></ul>';
const NEWSLETTER =
  '<style>.h{color:#2b2a27}</style><table width="100%" bgcolor="#ece8df"><tr><td><h2 class="h">Studio notes</h2><img src="https://pictures.example/x.jpg" alt="Room"><p style="color:#6b675f">You joined.</p></td></tr></table>';

const plainOf = (html: string) => isPlainBody(sanitiseBody(html, 'block'));

test('plain: paragraphs, bold, links and lists; rich: styles, colours, images, tables, body colours', () => {
  assert.equal(plainOf(PLAIN), true);
  for (const rich of [
    NEWSLETTER,
    '<style>p{color:red}</style><p>x</p>',
    '<p style="color:red">x</p>',
    '<font color="red">x</font>',
    '<body bgcolor="#123456"><p>x</p></body>',
    '<table><tr><td>x</td></tr></table>',
    '<p>x <img src="https://example.com/a.png" alt="a"></p>',
  ])
    assert.equal(plainOf(rich), false, rich);
});

test('a plain email paints the sentinel surface in the light theme and the card surface in the dark one', () => {
  const light = frameDocument(PLAIN, 'block', undefined, false).srcdoc;
  assert.match(
    light,
    new RegExp(`body\\{margin:0;background:${PLAIN_LIGHT_SURFACE};color:${FRAME_PAPER.ink}`),
  );
  assert.match(light, /name="color-scheme" content="light"/);
  const dark = frameDocument(PLAIN, 'block', undefined, true).srcdoc;
  assert.match(
    dark,
    new RegExp(`body\\{margin:0;background:${FRAME_DARK.surface};color:${FRAME_DARK.ink}`),
  );
  assert.match(dark, /name="color-scheme" content="dark"/);
  assert.match(dark, new RegExp(`a\\{color:${FRAME_DARK.accent}\\}`));
});

test('a rich email keeps its light paper in both themes, with no sentinel', () => {
  for (const darkTheme of [false, true]) {
    const doc = frameDocument(NEWSLETTER, 'block', undefined, darkTheme).srcdoc;
    assert.match(doc, /name="color-scheme" content="light"/);
    assert.doesNotMatch(doc, new RegExp(PLAIN_LIGHT_SURFACE));
    assert.doesNotMatch(doc, new RegExp(`background:${FRAME_DARK.surface}`));
  }
});

test('the host draws a plain email on the card (no inset, no rounding, in the name column) and a rich one on paper', () => {
  assert.equal(isPlainSurface(PLAIN_LIGHT_SURFACE), true);
  assert.equal(isPlainSurface(FRAME_DARK.surface), true);
  assert.equal(isPlainSurface('#ece8df'), false);
  assert.equal(
    isPlainSurface(FRAME_PAPER.paper),
    false,
    'paper itself (no background) is not the sentinel',
  );
  const plain = sheetOf(PLAIN_LIGHT_SURFACE);
  assert.equal(plain.padding, '0');
  assert.equal(plain.borderRadius, '0');
  assert.match(plain.marginLeft ?? '', /--plain-indent/);
  assert.equal(sheetOf(FRAME_DARK.surface).colorScheme, 'dark');
  assert.deepEqual(sheetOf('#ece8df'), { background: FRAME_PAPER.paper, colorScheme: 'light' });
});
