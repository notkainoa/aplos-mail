/**
 * A plain email (owner request 2026-11-10) is drawn straight on the reader card in the app's own type and colours, in both
 * themes; a rich one (a newsletter, anything with its own colours, images or tables) keeps its light paper. Stand-in frame
 * document and host sheet; the sealed frame has the same rule in packages/mail-html (tests/plain.test.ts).
 * Run: cd apps/desktop && npx tsx --test src/renderer/mailframe/plain.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { frameDocument } from './document';
import { FRAME_DARK, FRAME_PAPER, sheetKind, sheetOf } from './paper';
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
    '<font face="Comic Sans MS">x</font>',
    '<p>x <mark>y</mark></p>',
    '<table><tr><td>x</td></tr></table>',
    '<p>x <img src="https://example.com/a.png" alt="a"></p>',
  ])
    assert.equal(plainOf(rich), false, rich);
});

test('a style that only places text keeps a mail plain; one colour beside it does not', () => {
  const quote =
    '<div>Hi</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">old</blockquote>';
  assert.equal(plainOf(quote), true);
  assert.equal(plainOf('<p style="margin:0;color:red">x</p>'), false);
  assert.equal(
    plainOf('<p style="margin:0;background:url(https://example.com/a.png)">x</p>'),
    false,
  );
  assert.equal(plainOf('<p style="border-top:1px solid #000">x</p>'), false);
  // A literal style=" in the text must not hide the real markers that follow it.
  assert.equal(plainOf('<p>see style="margin:0</p><p><font color="#000000">x</font></p>'), false);
});

test('a wrapper that only sets direction, a class or a colour-free body style stays plain', () => {
  const plainBody = (attributes: string) =>
    plainOf(`<html><body ${attributes}><p>Hello</p></body></html>`);
  assert.equal(plainBody('dir="ltr"'), true);
  assert.equal(plainBody('class="msg" style="margin:0;padding:0"'), true);
  assert.equal(plainBody('bgcolor="#112233"'), false);
  assert.equal(plainBody('dir="ltr" style="margin:0;color:#c00"'), false);
});

test('a plain email paints the card’s own colours: paper in the light theme, the dark surface in the dark one', () => {
  const light = frameDocument(PLAIN, 'block', undefined, false);
  assert.equal(light.plain, true);
  assert.match(light.srcdoc, new RegExp(`body\\{margin:0;background:${FRAME_PAPER.paper};`));
  assert.match(light.srcdoc, /name="color-scheme" content="light"/);
  const dark = frameDocument(PLAIN, 'block', undefined, true);
  assert.equal(dark.plain, true);
  assert.match(dark.srcdoc, new RegExp(`body\\{margin:0;background:${FRAME_DARK.surface};`));
  assert.match(dark.srcdoc, new RegExp(`color:${FRAME_DARK.ink}`));
  assert.match(dark.srcdoc, /name="color-scheme" content="dark"/);
  assert.match(dark.srcdoc, new RegExp(`a\\{color:${FRAME_DARK.accent}\\}`));
});

test('a rich email keeps its light paper in both themes, with no plain treatment', () => {
  for (const darkTheme of [false, true]) {
    const built = frameDocument(NEWSLETTER, 'block', undefined, darkTheme);
    assert.equal(built.plain, false);
    assert.match(built.srcdoc, /name="color-scheme" content="light"/);
    assert.doesNotMatch(built.srcdoc, new RegExp(`background:${FRAME_DARK.surface}`));
  }
});

test('a mail that merely paints the dark surface or paper as its own body colour is still rich: it keeps its paper ring', () => {
  for (const colour of [FRAME_DARK.surface, FRAME_PAPER.paper, '#fffffe']) {
    const html = `<body bgcolor="${colour}"><style>p{color:#c00}</style><p>Hello</p><img src="https://example.com/x.png" alt="x"></body>`;
    for (const darkTheme of [false, true]) {
      const built = frameDocument(html, 'block', undefined, darkTheme);
      assert.equal(built.plain, false, `${colour} dark=${darkTheme}`);
      // The host decision: not plain, so the colour the mail chose changes nothing about its sheet.
      assert.deepEqual(sheetOf(built.plain, colour), {
        background: FRAME_PAPER.paper,
        colorScheme: 'light',
      });
    }
  }
});

test('the host draws a trusted-plain email on the card (no inset, no rounding, in the name column) and anything else on paper', () => {
  const light = sheetOf(true, FRAME_PAPER.paper);
  assert.equal(light.padding, '0');
  assert.equal(light.borderRadius, '0');
  assert.match(light.marginLeft ?? '', /--plain-indent/);
  assert.equal(light.colorScheme, 'light');
  assert.equal(sheetOf(true, FRAME_DARK.surface).colorScheme, 'dark');
  assert.deepEqual(sheetOf(false, '#ece8df'), {
    background: FRAME_PAPER.paper,
    colorScheme: 'light',
  });
});

test('sheetKind marks a light sheet apart from an email that sits on the card, for the pinned bar tray', () => {
  assert.equal(sheetKind(false, '#ece8df'), 'paper');
  assert.equal(sheetKind(true, FRAME_DARK.surface), 'app');
  assert.equal(sheetKind(true, FRAME_PAPER.paper), 'paper');
});

test('a blocked image collapses to nothing in the host layer, so no gray strip is left', () => {
  const hero =
    '<img src="https://cdn.example/hero.png" width="640" height="900" style="height:900px">';
  const { srcdoc } = frameDocument(hero, 'block', undefined, false);
  assert.match(srcdoc, /img\[data-blocked\]\{display:none!important\}/);
  assert.match(srcdoc, /<img[^>]*data-blocked/);
});
