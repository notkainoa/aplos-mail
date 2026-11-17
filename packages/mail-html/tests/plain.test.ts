import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { render } from '../src/index';
import { PLAIN_ATTRIBUTE } from '../src/plain';
import { PLAIN_DARK, PLAIN_LIGHT, PLAIN_TYPE, READING_CSS } from '../src/reading-css';

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
  'a font face': '<p><font face="Comic Sans MS">Hello</font></p>',
  'a font size': '<p><font size="7">Hello</font></p>',
  'a highlight': '<p>Hello <mark>there</mark></p>',
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

  it("stays plain when a style only places text (a reply's blockquote bar, margins, alignment)", () => {
    for (const html of [
      '<div dir="ltr">Hi</div><blockquote style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">old</blockquote>',
      '<p style="text-align:center;margin:0">Hello</p>',
    ])
      assert.match(rootOf(documentOf(html)), new RegExp(PLAIN_ATTRIBUTE), html);
  });

  it('stays plain when the wrapper only sets direction, a class or a colour-free body style', () => {
    for (const html of [
      '<html><body dir="ltr"><p>Hello</p></body></html>',
      '<html><body class="msg" style="margin:0;padding:0"><p>Hello</p></body></html>',
    ])
      assert.match(rootOf(documentOf(html)), new RegExp(PLAIN_ATTRIBUTE), html);
    for (const html of [
      '<html><body bgcolor="#112233"><p>Hello</p></body></html>',
      '<html><body text="#ffffff"><p>Hello</p></body></html>',
      '<html><body dir="ltr" style="margin:0;color:#c00"><p>Hello</p></body></html>',
    ])
      assert.doesNotMatch(rootOf(documentOf(html)), new RegExp(PLAIN_ATTRIBUTE), html);
  });

  it('is not plain when one declaration beside the layout ones sets a colour or loads something', () => {
    for (const html of [
      '<p style="margin:0;color:#c00">Hello</p>',
      '<p style="margin:0;background-color:#eee">Hello</p>',
      '<p style="margin:0;background:url(https://example.com/a.png)">Hello</p>',
      '<p style="border-left:1px solid red;font-family:Georgia">Hello</p>',
      '<p style="border-top:1px solid #000">Hello</p>',
      // A literal style=" in the text must not hide the real markers that follow it.
      '<p>see style="margin:0</p><p><font color="#000000">black</font></p>',
      '<p>x style="margin:0</p><img src="https://example.com/a.png" alt="a">',
    ])
      assert.doesNotMatch(rootOf(documentOf(html)), new RegExp(PLAIN_ATTRIBUTE), html);
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

  it('a mail that is otherwise plain but carries its own marker still gets exactly the bare marker on the root', () => {
    for (const forged of [
      `<html ${PLAIN_ATTRIBUTE}="x"><p>Hello</p></html>`,
      `<html ${PLAIN_ATTRIBUTE}="x" lang="fr"><p>Salut</p></html>`,
      `<html ${PLAIN_ATTRIBUTE}><p>Hello</p></html>`,
    ]) {
      const root = rootOf(documentOf(forged));
      // The sanitiser's own marker, empty: the mail's value ("x") never reaches the root, and it appears once.
      assert.match(root, /^<html( lang="fr")? data-aplos-plain>$/, root);
      assert.equal(root.split(PLAIN_ATTRIBUTE).length - 1, 1, 'once');
      assert.doesNotMatch(root, /data-aplos-plain=/);
    }
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
  it('paints the app’s colours in light and, under prefers-color-scheme, in dark; no body padding; the card’s own surface', () => {
    assert.match(
      READING_CSS,
      /html\[data-aplos-plain\] body\{padding:0;background:#ffffff;color:#1d1e21/,
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
    assert.equal(PLAIN_LIGHT.surface, colour.paper.$value);
    assert.equal(PLAIN_LIGHT.ink, colour.ink.$value);
    assert.equal(PLAIN_LIGHT.dim, colour.dim.$value);
    assert.equal(PLAIN_LIGHT.accent, colour.accent.$value);
    assert.equal(PLAIN_DARK.surface, colour.raised.$extensions.aplos.dark);
    assert.equal(PLAIN_DARK.ink, colour.ink.$extensions.aplos.dark);
    assert.equal(PLAIN_DARK.dim, colour.dim.$extensions.aplos.dark);
    assert.equal(PLAIN_DARK.accent, colour.accent.$extensions.aplos.dark);
    assert.equal(PLAIN_DARK.rule, colour.sunken.$extensions.aplos.dark);
  });

  it('sets the app’s own message type (the `read` role in tokens.json), not the frame’s default', () => {
    const path = fileURLToPath(
      new URL('../../../apps/desktop/src/renderer/ui/tokens.json', import.meta.url),
    );
    const tokens = JSON.parse(readFileSync(path, 'utf8')) as {
      type: { read: { $value: Record<string, string | number> } };
      font: { sans: { $value: string[] } };
    };
    const read = tokens.type.read.$value;
    assert.equal(PLAIN_TYPE.size, read.fontSize);
    assert.equal(PLAIN_TYPE.line, read.lineHeight);
    assert.equal(PLAIN_TYPE.weight, read.fontWeight);
    assert.equal(PLAIN_TYPE.tracking, read.letterSpacing);
    const family = tokens.font.sans.$value.map(f => (f.includes(' ') ? `"${f}"` : f)).join(',');
    assert.equal(PLAIN_TYPE.family, family);
  });

  it('judges plainness by the same markers as the renderer’s stand-in frame (a copy that must not drift)', () => {
    const list = (file: string) => {
      const text = readFileSync(file, 'utf8');
      const block = /COLOUR_MARKERS = \[([\s\S]*?)\] as const/.exec(text)?.[1] ?? '';
      return [...block.matchAll(/'([^']+)'/g)].map(m => m[1]);
    };
    const here = list(fileURLToPath(new URL('../src/plain.ts', import.meta.url)));
    const there = list(
      fileURLToPath(
        new URL('../../../apps/desktop/src/renderer/mailframe/plain.ts', import.meta.url),
      ),
    );
    assert.ok(here.length >= 9, `read ${here.length} markers`);
    assert.deepEqual(there, here);
  });
});
