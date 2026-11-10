import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { render } from '../src/index';
import { PLAIN_ATTRIBUTE } from '../src/plain';
import { PLAIN_DARK, PLAIN_LIGHT, READING_CSS } from '../src/reading-css';

// A plain email (owner request 2026-11-10) is drawn straight on the card in the app's type and colours: the frame marks its
// root, and the reading CSS gives that root the app's light and dark values. A newsletter, or anything that sets its own
// colours, backgrounds, images or layout, keeps its paper.

const documentOf = (html: string) => {
  const result = render({ html, cids: [], imagePolicy: 'block' });
  assert.equal(result.bodyKind, 'html');
  return result.document;
};
const rootOf = (document: string) => /<html[^>]*>/.exec(document)?.[0] ?? '';

const PLAIN_MAIL =
  '<p>Saw that you signed up. Thanks a ton.</p><p><b>To get started</b>, open the site and <a href="https://example.com/start">copy the setup</a>.</p><ul><li>one</li><li><i>two</i></li></ul><blockquote>On Monday, Jo wrote: hi</blockquote>';

const RICH: Record<string, string> = {
  'a <style> block': '<style>p{color:#c00}</style><p>Hello</p>',
  'an inline style': '<p style="color:#c00">Hello</p>',
  'a font colour': '<p><font color="#c00">Hello</font></p>',
  'a body background': '<body bgcolor="#112233"><p>Hello</p></body>',
  'a body style': '<body style="background:#112233"><p>Hello</p></body>',
  'a cell fill': '<table><tr><td bgcolor="#eee">Hello</td></tr></table>',
  'a layout table': '<table><tr><td>Hello</td></tr></table>',
  'an image': '<p>Hello <img src="https://example.com/logo.png" alt="Logo"></p>',
};

describe('a plain email', () => {
  it('marks the frame root, and nothing else changes in the body', () => {
    const doc = documentOf(PLAIN_MAIL);
    assert.match(rootOf(doc), new RegExp(`^<html[^>]* ${PLAIN_ATTRIBUTE}>$`));
    assert.match(doc, /<b>To get started<\/b>/, 'bold stays bold');
    assert.match(doc, /<a href="https:\/\/example\.com\/start"/, 'links stay links');
    assert.match(doc, /<li><i>two<\/i><\/li>/, 'lists and italics stay');
  });

  it('keeps lang and dir on the root beside the mark', () => {
    assert.match(
      rootOf(documentOf('<html lang="fr" dir="ltr"><p>Salut</p></html>')),
      new RegExp(PLAIN_ATTRIBUTE),
    );
  });

  for (const [name, html] of Object.entries(RICH))
    it(`is not plain with ${name}: it keeps its paper`, () => {
      assert.doesNotMatch(rootOf(documentOf(html)), new RegExp(PLAIN_ATTRIBUTE));
    });

  it('a newsletter keeps its paper', () => {
    const newsletter =
      '<style>.h{color:#2b2a27;font-family:Georgia}</style><table width="100%" bgcolor="#ece8df"><tr><td><h2 class="h">Studio notes</h2><img src="https://pictures.example/x.jpg" alt="Room" width="520"><p style="color:#6b675f">You are receiving this because you joined.</p></td></tr></table>';
    assert.doesNotMatch(rootOf(documentOf(newsletter)), new RegExp(PLAIN_ATTRIBUTE));
  });

  it('cannot be forced by the mail: its own marker is dropped, and a styled mail stays rich', () => {
    const forged = documentOf('<html data-aplos-plain><p style="color:red">Hi</p></html>');
    assert.doesNotMatch(rootOf(forged), new RegExp(PLAIN_ATTRIBUTE));
    const alsoForged = documentOf(
      `<html ${PLAIN_ATTRIBUTE}="x"><style>p{}</style><p>Hi</p></html>`,
    );
    assert.doesNotMatch(rootOf(alsoForged), new RegExp(PLAIN_ATTRIBUTE));
  });

  it('a quoted reply (the reader wraps quoted history in a details) is still plain', () => {
    assert.match(
      rootOf(documentOf('<p>Thanks</p><blockquote><p>earlier text</p></blockquote>')),
      new RegExp(PLAIN_ATTRIBUTE),
    );
  });
});

describe('the reading CSS for a plain email', () => {
  it('paints the app’s colours in light and, under prefers-color-scheme, in dark; no body padding; the sentinel surface', () => {
    assert.match(
      READING_CSS,
      /html\[data-aplos-plain\] body\{padding:0;background:#fffffe;color:#1d1e21/,
    );
    assert.match(
      READING_CSS,
      /@media \(prefers-color-scheme:dark\)\{html\[data-aplos-plain\]\{color-scheme:dark\}/,
    );
    assert.match(READING_CSS, /html\[data-aplos-plain\] body\{background:#212225;color:#ececed\}/);
  });

  it('uses the app’s own token values (a drift here means ui/tokens.json changed)', () => {
    const path = fileURLToPath(
      new URL('../../../apps/desktop/src/renderer/ui/tokens.json', import.meta.url),
    );
    const colour = JSON.parse(readFileSync(path, 'utf8')).color as Record<
      string,
      { $value: string; $extensions: { aplos: { dark: string } } }
    >;
    assert.equal(PLAIN_LIGHT.ink, colour.ink.$value);
    assert.equal(PLAIN_LIGHT.dim, colour.dim.$value);
    assert.equal(PLAIN_LIGHT.accent, colour.accent.$value);
    assert.equal(PLAIN_DARK.surface, colour.raised.$extensions.aplos.dark);
    assert.equal(PLAIN_DARK.ink, colour.ink.$extensions.aplos.dark);
    assert.equal(PLAIN_DARK.dim, colour.dim.$extensions.aplos.dark);
    assert.equal(PLAIN_DARK.accent, colour.accent.$extensions.aplos.dark);
    assert.equal(PLAIN_DARK.rule, colour.sunken.$extensions.aplos.dark);
  });
});
