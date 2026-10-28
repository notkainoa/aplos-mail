import assert from 'node:assert/strict';
import test from 'node:test';
import type { MailHtmlInput, MailHtmlResult } from '@aplos/engine/ports/content';
import { MAIL_HTML_VERSION, MAX_HTML_CHARS, mailHtml, render } from '../src/index';
import { MAX_DEPTH } from '../src/sanitize';
import { unsafeParts } from './oracle';

function html(body: string, extra: Partial<MailHtmlInput> = {}): MailHtmlResult & { bodyKind: 'html' } {
  const result = render({ html: body, cids: [], imagePolicy: 'block', ...extra });
  assert.equal(result.bodyKind, 'html');
  const problems = unsafeParts(result.document, { imagesBlocked: (extra.imagePolicy ?? 'block') === 'block' });
  assert.deepEqual(problems, [], `oracle found: ${problems.join('; ')}`);
  return result;
}

function body(result: { document: string }): string {
  return /<body[^>]*>([\s\S]*)<\/body>/.exec(result.document)?.[1] ?? '';
}

test('implements the MailHtml port: versioned, pure and deterministic', () => {
  assert.equal(mailHtml.version, MAIL_HTML_VERSION);
  const input: MailHtmlInput = { html: '<p>Hi <img src="https://cdn.example/a.png" width=9 height=9></p>', cids: [], imagePolicy: 'allow' };
  assert.deepEqual(mailHtml.render(input), mailHtml.render(input));
});

test('removes scripts, handlers and every element that can run or load something', () => {
  const result = html(
    '<script>alert(1)</script><p onclick="x()" onmouseover=y>Keep me</p><iframe src="https://x.example"></iframe>' +
      '<object data="https://x.example/o"></object><embed src="https://x.example/e"><applet code=x></applet>' +
      '<meta http-equiv="refresh" content="0;url=https://x.example"><link rel="dns-prefetch" href="//x.example">' +
      '<link rel=preconnect href="https://x.example"><base href="https://x.example/"><video poster="https://x.example/p.png"></video>' +
      '<audio src="https://x.example/a.mp3"></audio><frameset><frame src="https://x.example"></frameset>',
  );
  assert.match(body(result), /<p>Keep me<\/p>/);
  assert.doesNotMatch(result.document, /x\.example|script|onclick|iframe|object|embed|<meta|<link|<base|video|audio/i);
});

test('forms are unwrapped: their text stays, fields and actions go', () => {
  const result = html(
    '<form action="https://x.example/post" method=post><p>Survey</p><input name=a value=b autofocus onfocus="submit()"><button formaction="https://x.example">Go</button><textarea>t</textarea><select><option>o</option></select></form>',
  );
  assert.equal(body(result), '<p>Survey</p>');
});

test('links: web and mail links open outside the frame, other schemes lose their href', () => {
  const cases: [string, string][] = [
    ['https://shop.example/a?b=1&c=2', ' href="https://shop.example/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer"'],
    ['mailto:someone@mail.example', ' href="mailto:someone@mail.example" target="_blank" rel="noopener noreferrer"'],
    ['#section-2', ' href="#section-2"'],
    ['javascript:alert(1)', ''],
    ['jav&#x09;ascript:alert(1)', ''],
    ['  JaVaScRiPt:alert(1)', ''],
    ['data:text/html,<script>alert(1)</script>', ''],
    ['vbscript:x', ''],
    ['file:///etc/passwd', ''],
    ['/relative/path', ''],
    ['//protocol-relative.example', ''],
  ];
  for (const [href, expected] of cases) {
    const result = html(`<a href="${href}" ping="https://p.example" target="_top" download>link</a>`);
    assert.equal(body(result), `<a${expected}>link</a>`, href);
  }
});

test('blocked remote images keep their size as quiet placeholders and are not listed for the proxy', () => {
  const result = html('<img src="https://cdn.example/hero.png" width="600" height="200" alt="Hero" class="x" srcset="https://cdn.example/2x.png 2x">');
  assert.equal(result.hasRemoteImages, true);
  assert.deepEqual(result.remoteImages, []);
  assert.match(body(result), /^<img class="aplos-blocked" src="data:image\/gif;base64,[^"]+" width="600" height="200" alt="Hero">$/);
  const unsized = html('<img src="https://cdn.example/x.png" alt="Logo"><img src="https://cdn.example/y.png">');
  assert.equal(body(unsized), '<img alt="Logo">');
});

test('allowed remote images, backgrounds and CSS images are rewritten to img/<n>, each URL once', () => {
  const result = html(
    '<table background="https://cdn.example/bg.png"><tr><td style="background:url(https://cdn.example/td.png)">' +
      '<img src="https://cdn.example/a.png" width=60 height=40><img src="https://cdn.example/a.png" width=60 height=40></td></tr></table>',
    { imagePolicy: 'allow' },
  );
  assert.deepEqual(result.remoteImages, ['https://cdn.example/bg.png', 'https://cdn.example/td.png', 'https://cdn.example/a.png']);
  assert.match(body(result), /background="img\/0"/);
  assert.match(body(result), /url\(&quot;img\/1&quot;\)/);
  assert.equal(body(result).match(/src="img\/2"/g)?.length, 2);
});

test('inline parts map to cid/<n>; unknown cids and non-raster data URLs are dropped', () => {
  const result = html(
    '<img src="cid:logo@mail.example" alt="a"><img src="CID:%3CLOGO@mail.example%3E" alt="b"><img src="cid:missing@x" alt="c">' +
      '<img src="data:image/png;base64,iVBORw0KGgo=" alt="d"><img src="data:image/svg+xml,<svg onload=alert(1)>" alt="e">',
    { cids: ['logo@mail.example'] },
  );
  assert.equal(
    body(result),
    '<img src="cid/0" alt="a"><img src="cid/0" alt="b"><img alt="c"><img src="data:image/png;base64,iVBORw0KGgo=" alt="d"><img alt="e">',
  );
});

test('tracking pixels are removed and counted, never listed for the proxy', () => {
  const result = html(
    '<p>Hello</p><img src="https://t.example/a.gif" width="1" height="1"><img src="https://t.example/b.gif" style="display:none">' +
      '<div style="display:none"><img src="https://t.example/c.gif" width=300 height=100></div><img src="https://t.example/d.gif" width="0">' +
      '<img src="https://t.example/open?id=5"><img src="https://t.example/e.gif" hidden><img src="https://cdn.example/real.png" width=300 height=100>',
    { imagePolicy: 'allow' },
  );
  assert.equal(result.trackersRemoved, 6);
  assert.deepEqual(result.remoteImages, ['https://cdn.example/real.png']);
  assert.doesNotMatch(result.document, /t\.example/);
});

test('style: remote @import, @font-face and unrewritten url() go; layout at-rules stay', () => {
  const result = html(
    '<style>@import url(https://x.example/a.css); @font-face{font-family:F;src:url(https://x.example/f.woff)} ' +
      '@media (max-width:600px){.a{color:red}} .b{background:u\\72l(https://x.example/b.png)} .c{list-style:url(javascript:alert(1))}</style><p class="a">x</p>',
  );
  const style = /<style>([\s\S]*?)<\/style>/g;
  const mail = [...result.document.matchAll(style)][1][1];
  assert.doesNotMatch(mail, /x\.example|@import|@font-face|javascript/i);
  assert.match(mail, /@media \(max-width:600px\)\{\.a\{color:red\}\}/);
});

test('a </style> inside a CSS string cannot close the style element', () => {
  const result = html('<p style="font-family:&quot;</style><script>alert(1)</script>&quot;">x</p>');
  assert.doesNotMatch(result.document, /<script/);
});

test('mutation-XSS shapes come out inert', () => {
  const inputs = [
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
    '<svg><style><img src=x onerror=alert(1)></style></svg>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<xmp><img src=x onerror=alert(1)></xmp>',
    '<!--><img src=x onerror=alert(1)>-->',
    '<template><img src=x onerror=alert(1)></template>',
    '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
    '<select><style><img src=x onerror=alert(1)></style></select>',
    '<a href="https://ok.example" title="&lt;img src=x onerror=alert(1)&gt;">t</a>',
    '<p id="</p><img src=x onerror=alert(1)>">t</p>',
    '<img src=`x`onerror=alert(1)>',
    '<div style="x:expression(alert(1))">t</div>',
  ];
  for (const input of inputs) {
    // The oracle (inside html()) reads the output as Chromium would; text left inside <style> is CSS, not markup.
    const result = html(input);
    const outsideStyles = result.document.replace(/<style>[\s\S]*?<\/style>/g, '');
    assert.doesNotMatch(outsideStyles, /<img[^>]*onerror|<script/i, input);
  }
});

test('quoted history is wrapped in a closed <details>, outermost block only', () => {
  const gmail = html(
    '<p>New</p><div class="gmail_quote"><div class="gmail_attr">On Mon, A wrote:</div><blockquote class="gmail_quote">Old <blockquote type="cite">older</blockquote></blockquote></div>',
  );
  assert.equal(gmail.quotedCount, 1);
  assert.match(body(gmail), /^<p>New<\/p><details class="aplos-quote"><summary>Quoted text<\/summary><div class="gmail_quote">/);
  const outlook = html('<div>Reply</div><div id="appendonsend"></div><hr><div id="divRplyFwdMsg">From: B</div><div>Old body</div>');
  assert.equal(outlook.quotedCount, 1);
  assert.match(body(outlook), /^<div>Reply<\/div><details class="aplos-quote"><summary>Quoted text<\/summary><div id="appendonsend"><\/div><hr>.*Old body<\/div><\/details>$/);
  const original = html('<p>Fine</p><div>-----Original Message-----<br>From: C</div><p>old</p>');
  assert.equal(original.quotedCount, 1);
  const apple = html('<div>Yes</div><blockquote type="cite">one</blockquote><p>between</p><blockquote type="cite">two</blockquote>');
  assert.equal(apple.quotedCount, 2);
  const table = html('<table><tr><td>a</td></tr><tr class="gmail_quote"><td>b</td></tr></table>');
  assert.equal(table.quotedCount, 0, 'never inside table structure, where the parser would move it');
});

test('find marks matches in text, never inside markup or styles', () => {
  const result = html('<style>.deal{color:red}</style><p class="deal">A deal, another DEAL and <b>de</b>al.</p>', {
    findQuery: 'deal',
  });
  assert.equal(result.marks, 2);
  assert.match(body(result), /A <mark class="aplos-find">deal<\/mark>, another <mark class="aplos-find">DEAL<\/mark>/);
  assert.match(body(result), /class="deal"/);
  assert.equal(html('<p>a.b a+b</p>', { findQuery: 'a.b' }).marks, 1, 'the query is literal, not a pattern');
});

test('plain-text mail comes back as text for the host to escape', () => {
  const result = render({ text: 'Hi <script>x</script>\n> quoted\n> more\nmine\n> again', cids: [], imagePolicy: 'block', findQuery: 'more' });
  assert.equal(result.bodyKind, 'text');
  assert.equal(result.bodyKind === 'text' && result.text, 'Hi <script>x</script>\n> quoted\n> more\nmine\n> again');
  assert.equal(result.quotedCount, 2);
  assert.equal(result.marks, 1);
  assert.equal(render({ html: '  \n', text: 'x', cids: [], imagePolicy: 'block' }).bodyKind, 'text');
  assert.equal(render({ cids: [], imagePolicy: 'block' }).bodyKind, 'text');
});

test('keeps the mail rendering mode and body colours, drops body handlers', () => {
  assert.match(html('<!DOCTYPE html><p>x</p>').document, /^<!DOCTYPE html><html>/);
  assert.match(html('<p>x</p>').document, /^<html>/);
  const legacy =
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">';
  assert.ok(html(`${legacy}<p>x</p>`).document.startsWith(legacy));
  const result = html('<html lang="fr" onload=x><body bgcolor="#f0f0f0" onload="alert(1)" style="margin:0"><p>x</p></body></html>');
  assert.match(result.document, /<html lang="fr"><head>/);
  assert.match(result.document, /<body bgcolor="#f0f0f0" style="margin:0">/);
});

test('100,000 nested elements finish and are flattened past the depth cap', () => {
  const deep = `${'<div>'.repeat(100_000)}bottom${'</div>'.repeat(100_000)}`;
  const start = performance.now();
  const result = html(deep);
  assert.ok(performance.now() - start < 10_000);
  assert.equal(body(result).match(/<div>/g)?.length, MAX_DEPTH);
  assert.match(body(result), /bottom/);
});

test('very long HTML is cut at the limit and says so', () => {
  const long = `<p>${'a'.repeat(MAX_HTML_CHARS + 10)}</p>`;
  const result = html(long);
  assert.match(body(result), /aplos-clipped/);
  assert.ok(result.document.length < MAX_HTML_CHARS + 2_000);
});

test('control characters and lone surrogates do not break the output', () => {
  const result = html('<p title="a\u0000b">x\u0000y \ud800 ‮evil‬</p>');
  assert.doesNotMatch(result.document, /\u0000/);
});
