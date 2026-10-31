import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { MailHtml, MailHtmlInput, MailHtmlResult } from '@aplos/engine/ports/content';
import { loadCorpus, type CorpusEntry } from '../corpus/index';
import { MAIL_HTML_VERSION, mailHtml, render, sanitizeBody } from '../src/index';
import { LIMITS, MAX_DEPTH } from '../src/sanitize';
import { loadableValues, unsafeParts } from './oracle';

// The sanitizer against hand-written cases and the whole hostile corpus. Every rendered document
// is read back with parse5 (tests/oracle.ts) and must contain nothing that can run, load, navigate
// or clobber; the corpus `expect` fields are the grading oracle for what must survive.

type HtmlResult = MailHtmlResult & { bodyKind: 'html' };

function html(body: string, extra: Partial<MailHtmlInput> = {}): HtmlResult {
  const result = render({ html: body, cids: [], imagePolicy: 'block', ...extra });
  assert.equal(result.bodyKind, 'html');
  const problems = unsafeParts(result.document, {
    imagesBlocked: (extra.imagePolicy ?? 'block') === 'block',
    remoteImages: result.remoteImages.length,
    cids: extra.cids?.length ?? 0,
  });
  assert.deepEqual(problems, [], `oracle found: ${problems.join('; ')}`);
  return result;
}

function bodyOf(result: { document: string }): string {
  return /<body[^>]*>([\s\S]*)<\/body>/.exec(result.document)?.[1] ?? '';
}

/** The visible text of a document: tags (and the style and head) removed, the six escapes undone. */
function visibleText(document: string): string {
  return document
    .replace(/<head>[\s\S]*?<\/head>/, '')
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]*>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#96;', '`')
    .replaceAll('&amp;', '&');
}

describe('the MailHtml port', () => {
  it('is versioned, pure and deterministic', () => {
    const port: MailHtml = mailHtml;
    assert.equal(port.version, MAIL_HTML_VERSION);
    const input: MailHtmlInput = {
      html: '<p>Hi <img src="https://cdn.example/a.png" width=9 height=9></p>',
      cids: [],
      imagePolicy: 'allow',
    };
    assert.deepEqual(port.render(input), port.render(input));
  });

  it('imports nothing but the parser, the CSS tokenizer and its own files (no DOM, no Node)', () => {
    const dir = join(import.meta.dirname, '../src');
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), 'utf8').replace(
        /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
        '',
      );
      const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]);
      for (const name of imports)
        assert.match(
          name,
          /^(?:\.\/|htmlparser2$|@csstools\/css-tokenizer$|@aplos\/engine\/ports\/)/,
          `${file} imports ${name}`,
        );
      assert.doesNotMatch(
        source,
        /\b(?:document|window|globalThis|process|require|Buffer)\s*[.(]/,
        file,
      );
    }
  });

  it('returns plain-text mail as text for the host to escape', () => {
    const result = render({
      text: 'Hi <script>x</script>\n> quoted\n> more\nmine\n> again',
      cids: [],
      imagePolicy: 'block',
      findQuery: 'more',
    });
    assert.equal(result.bodyKind, 'text');
    assert.equal(
      result.bodyKind === 'text' && result.text,
      'Hi <script>x</script>\n> quoted\n> more\nmine\n> again',
    );
    assert.equal(result.quotedCount, 2);
    assert.equal(result.marks, 1);
    assert.equal(
      render({ html: '  \n', text: 'x', cids: [], imagePolicy: 'block' }).bodyKind,
      'text',
    );
    assert.equal(render({ cids: [], imagePolicy: 'block' }).bodyKind, 'text');
  });
});

describe('elements and attributes', () => {
  it('removes scripts, handlers and every element that can run or load something', () => {
    const result = html(
      '<script>alert(1)</script><p onclick="x()" onmouseover=y>Keep me</p><iframe src="https://x.example"></iframe>' +
        '<object data="https://x.example/o"></object><embed src="https://x.example/e"><applet code=x></applet>' +
        '<meta http-equiv="refresh" content="0;url=https://x.example"><link rel="dns-prefetch" href="//x.example">' +
        '<link rel=preconnect href="https://x.example"><base href="https://x.example/"><video poster="https://x.example/p.png"></video>' +
        '<audio src="https://x.example/a.mp3"></audio><frameset><frame src="https://x.example"></frameset>' +
        '<svg><script>alert(1)</script><foreignObject><img src=x onerror=alert(1)></foreignObject></svg><math><mi>x</mi></math>',
    );
    assert.match(bodyOf(result), /<p>Keep me<\/p>/);
    assert.doesNotMatch(
      result.document,
      /x\.example|script|onclick|iframe|object|embed|<meta|<link|<base|video|audio|svg|math/i,
    );
  });

  it('unwraps forms: their text stays, fields and actions go', () => {
    const result = html(
      '<form action="https://x.example/post" method=post><p>Survey</p><input name=a value=b autofocus onfocus="submit()"><button formaction="https://x.example">Go</button><textarea>t</textarea><select><option>o</option></select></form>',
    );
    assert.equal(bodyOf(result), '<p>Survey</p>');
  });

  it('shows a frameset fallback (noframes) as markup, sanitized', () => {
    const result = html(
      '<frameset><frame src="https://x.example/a"><noframes><p>Fallback</p><img src=x onerror=alert(1)><noframes><b>inner</b></noframes></frameset>',
    );
    assert.equal(bodyOf(result), '<p>Fallback</p><b>inner</b>');
  });

  it('keeps attributes only from the allowlist and never with a namespace prefix', () => {
    const result = html(
      '<div class="a" title="t" data-x="1" tabindex=0 contenteditable draggable=true popover accesskey=k is="x-y" slot=s part=p style="color:red" xmlns:xlink="x" xlink:href="https://x.example">t</div>',
    );
    assert.equal(bodyOf(result), '<div class="a" title="t" style="color:red">t</div>');
  });

  it('moves ids, anchor names and id references into the m- namespace (DOM clobbering)', () => {
    const result = html(
      '<a id="addEventListener" name="top" href="#top">x</a><td headers="h1 h2"></td><span aria-labelledby="a b" aria-label="l">y</span><div id="m-kept"></div><div id="">z</div>',
    );
    assert.equal(
      bodyOf(result),
      '<a id="m-addEventListener" name="m-top" href="#m-top">x</a><td headers="m-h1 m-h2"></td><span aria-labelledby="m-a m-b" aria-label="l">y</span><div id="m-kept"></div><div>z</div>',
    );
    assert.match(
      html('<style>#bodyTable td{color:red} .a{color:#abc}</style>').document,
      /#m-bodyTable td\{color:red\} \.a\{color:#abc\}/,
    );
  });

  it('keeps the rendering mode and body colours, drops body handlers', () => {
    assert.match(html('<!DOCTYPE html><p>x</p>').document, /^<!DOCTYPE html><html>/);
    assert.match(html('<p>x</p>').document, /^<html>/);
    const legacy =
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">';
    assert.ok(html(`${legacy}<p>x</p>`).document.startsWith(legacy));
    const result = html(
      '<html lang="fr" onload=x><body bgcolor="#f0f0f0" onload="alert(1)" style="margin:0" background="https://x.example/b.png"><p>x</p></body></html>',
    );
    assert.match(result.document, /<html lang="fr"><head>/);
    assert.match(result.document, /<body bgcolor="#f0f0f0" style="margin:0">/);
  });

  it('escapes control characters, lone surrogates and NUL without breaking the output', () => {
    const result = html('<p title="a\u0000b">x\u0000y \ud800 \u202eevil\u202c</p>');
    assert.equal(result.document.includes('\u0000'), false);
    assert.match(result.document, /title="a\ufffdb"/);
  });
});

describe('links', () => {
  it('opens web, mail and phone links outside the frame and strips every other scheme', () => {
    const cases: [string, string][] = [
      [
        'https://shop.example/a?b=1&c=2',
        ' href="https://shop.example/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer"',
      ],
      [
        'mailto:someone@mail.example',
        ' href="mailto:someone@mail.example" target="_blank" rel="noopener noreferrer"',
      ],
      ['tel:+1-555-0100', ' href="tel:+1-555-0100" target="_blank" rel="noopener noreferrer"'],
      ['#section-2', ' href="#m-section-2"'],
      ['javascript:alert(1)', ''],
      ['jav&#x09;ascript:alert(1)', ''],
      ['java\nscript:alert(1)', ''],
      ['&#0000106avascript:alert(1)', ''],
      ['  JaVaScRiPt:alert(1)', ''],
      ['data:text/html,<script>alert(1)</script>', ''],
      ['vbscript:x', ''],
      ['file:///etc/passwd', ''],
      ['blob:https://x.example/1', ''],
      ['mhtml:file://c:/x.mht', ''],
      ['jar:https://x.example/a.jar!/', ''],
      ['ms-its:x.chm::/a.htm', ''],
      ['aplos-mail://m/0123/img/0', ''],
      ['cid:part@x', ''],
      ['/relative/path', ''],
      ['//protocol-relative.example', ''],
    ];
    for (const [href, expected] of cases) {
      const result = html(
        `<a href="${href}" ping="https://p.example" target="_top" download referrerpolicy="unsafe-url">link</a>`,
      );
      assert.equal(bodyOf(result), `<a${expected}>link</a>`, href);
    }
  });
});

describe('images', () => {
  it('keeps blocked remote images as quiet sized placeholders and does not list them', () => {
    const result = html(
      '<img src="https://cdn.example/hero.png" width="600" height="200" alt="Hero" class="x" srcset="https://cdn.example/2x.png 2x">',
    );
    assert.equal(result.hasRemoteImages, true);
    assert.deepEqual(result.remoteImages, []);
    assert.match(
      bodyOf(result),
      /^<img src="data:image\/gif;base64,[^"]+" class="aplos-blocked" width="600" height="200" alt="Hero">$/,
    );
    const unsized = html(
      '<img src="https://cdn.example/x.png" alt="Logo"><img src="https://cdn.example/y.png">',
    );
    assert.equal(bodyOf(unsized), '<img alt="Logo">');
  });

  it('rewrites allowed remote images, backgrounds and CSS images to img/<n>, each URL once', () => {
    const result = html(
      '<table background="https://cdn.example/bg.png"><tr><td style="background:url(https://cdn.example/td.png)">' +
        '<img src="https://cdn.example/a.png" width=60 height=40><img src=" https://cdn.example/a.png" width=60 height=40></td></tr></table>',
      { imagePolicy: 'allow' },
    );
    assert.deepEqual(result.remoteImages, [
      'https://cdn.example/bg.png',
      'https://cdn.example/td.png',
      'https://cdn.example/a.png',
    ]);
    assert.match(bodyOf(result), /background="img\/0"/);
    assert.match(bodyOf(result), /url\(&quot;img\/1&quot;\)/);
    assert.equal(bodyOf(result).match(/src="img\/2"/g)?.length, 2);
  });

  it('maps inline parts to cid/<n>; unknown cids, non-raster data and CSS data URLs go', () => {
    const result = html(
      '<img src="cid:logo@mail.example" alt="a"><img src="CID:%3CLOGO@mail.example%3E" alt="b"><img src="cid:missing@x" alt="c">' +
        '<img src="data:image/png;base64,iVBORw0KGgo=" alt="d"><img src="data:image/svg+xml,<svg onload=alert(1)>" alt="e">' +
        '<p style="background:url(data:image/png;base64,iVBORw0KGgo=)">f</p><img src="img/0" alt="g"><img src="cid/0" alt="h">',
      { cids: ['<logo@mail.example>'] },
    );
    assert.equal(
      bodyOf(result),
      '<img src="cid/0" alt="a"><img src="cid/0" alt="b"><img alt="c"><img src="data:image/png;base64,iVBORw0KGgo=" alt="d"><img alt="e"><p style="background: none">f</p><img alt="g"><img alt="h">',
    );
  });

  it('removes and counts tracking pixels, never listing them for the proxy', () => {
    const result = html(
      '<p>Hello</p><img src="https://t.example/a.gif" width="1" height="1"><img src="https://t.example/b.gif" style="display:none">' +
        '<div style="display:none"><img src="https://t.example/c.gif" width=300 height=100></div><img src="https://t.example/d.gif" width="0">' +
        '<img src="https://t.example/open?id=5"><img src="https://t.example/e.gif" hidden><img src="https://t.example/f.gif" style="width:1px;height:1px">' +
        '<img src="https://t.example/g.gif" style="opacity:0"><img src="https://t.example/h.gif" style="disp\\6c ay:none">' +
        '<span hidden><img src="https://t.example/i.gif" width=50 height=50></span>' +
        '<img src="https://t.example/j.gif" width="1   px" height="1"><img src="https://cdn.example/real.png" width=300 height=100>',
      { imagePolicy: 'allow' },
    );
    assert.equal(result.trackersRemoved, 11);
    assert.deepEqual(result.remoteImages, ['https://cdn.example/real.png']);
    assert.doesNotMatch(result.document, /t\.example/);
  });
});

describe('quoted history and find', () => {
  it('wraps quoted history in a closed <details>, outermost block only', () => {
    const gmail = html(
      '<p>New</p><div class="gmail_quote"><div class="gmail_attr">On Mon, A wrote:</div><blockquote class="gmail_quote">Old <blockquote type="cite">older</blockquote></blockquote></div>',
    );
    assert.equal(gmail.quotedCount, 1);
    assert.match(
      bodyOf(gmail),
      /^<p>New<\/p><details class="aplos-quote"><summary>Quoted text<\/summary><div class="gmail_quote">/,
    );
    const outlook = html(
      '<div>Reply</div><div id="appendonsend"></div><hr><div id="divRplyFwdMsg">From: B</div><div>Old body</div>',
    );
    assert.equal(outlook.quotedCount, 1);
    assert.match(
      bodyOf(outlook),
      /^<div>Reply<\/div><details class="aplos-quote"><summary>Quoted text<\/summary><div id="m-appendonsend"><\/div><hr>.*Old body<\/div><\/details>$/,
    );
    assert.equal(
      html('<p>Fine</p><div><font>-----Original Message-----</font><br>From: C</div><p>old</p>')
        .quotedCount,
      1,
    );
    assert.equal(
      html(
        '<div>Yes</div><blockquote type="cite">one</blockquote><p>between</p><blockquote type="cite">two</blockquote>',
      ).quotedCount,
      2,
    );
    const table = html('<table><tr><td>a</td></tr><tr class="gmail_quote"><td>b</td></tr></table>');
    assert.equal(
      table.quotedCount,
      0,
      'never inside table structure, where the parser would move it',
    );
  });

  it('marks find matches in text, never inside markup, styles or scripts', () => {
    const result = html(
      '<style>.deal{color:red}</style><p class="deal" title="deal">A deal, another DEAL and <b>de</b>al.</p><script>deal</script>',
      {
        findQuery: 'deal',
      },
    );
    assert.equal(result.marks, 2);
    assert.match(
      bodyOf(result),
      /A <mark class="aplos-find">deal<\/mark>, another <mark class="aplos-find">DEAL<\/mark>/,
    );
    assert.match(bodyOf(result), /class="deal" title="deal"/);
    assert.equal(
      html('<p>a.b a+b</p>', { findQuery: 'a.b' }).marks,
      1,
      'the query is literal, not a pattern',
    );
    assert.equal(
      html('<p>a &lt;b&gt;</p>', { findQuery: '<b>' }).marks,
      1,
      'the query matches decoded text and is escaped back',
    );
  });
});

describe('mutation XSS and parser differentials', () => {
  it('turns mXSS shapes into inert output, as parse5 reads it', () => {
    const inputs = [
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
      '<svg><style><img src=x onerror=alert(1)></style></svg>',
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
      '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img src=1 onerror=alert(1)&gt;">',
      '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
      '<xmp><img src=x onerror=alert(1)></xmp>',
      '<!--><img src=x onerror=alert(1)>-->',
      '<!----!><img src=x onerror=alert(1)>-->',
      '<![CDATA[><img src=x onerror=alert(1)>]]>',
      '<template><img src=x onerror=alert(1)></template>',
      '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
      '<select><style><img src=x onerror=alert(1)></style></select>',
      '<table><style></table><img src=x onerror=alert(1)></style>',
      '<a href="https://ok.example" title="&lt;img src=x onerror=alert(1)&gt;">t</a>',
      '<p id="</p><img src=x onerror=alert(1)>">t</p>',
      '<img src=`x`onerror=alert(1)>',
      '<scr\u0000ipt>alert(1)</scr\u0000ipt><img\u0000src=x onerror=alert(1)>',
      '<ſcript>alert(1)</ſcript><İframe src=javascript:alert(1)>',
      '<div style="x:expression(alert(1))">t</div>',
      '<style>@import "https://x.example/a.css";</style><style>a{b:c}</style><style></style><img src=x onerror=alert(1)></style>',
      '<textarea></textarea><img src=x onerror=alert(1)></textarea>',
      '<title></title><img src=x onerror=alert(1)></title>',
      '<plaintext><img src=x onerror=alert(1)>',
    ];
    for (const input of inputs) {
      const result = html(input);
      const outsideStyles = result.document.replace(/<style>[\s\S]*?<\/style>/g, '');
      assert.doesNotMatch(outsideStyles, /<img[^>]*onerror|<script|<iframe/i, input);
    }
  });

  it('stops a </style> in CSS from closing the style element', () => {
    for (const input of [
      '<p style="font-family:&quot;</style><script>alert(1)</script>&quot;">x</p>',
      '<style>a{content:"</style><script>alert(1)</script>"}</style>',
      '<style>a{b:c}</ style ><img src=x onerror=alert(1)></style>',
      '<style>a\\</style><img src=x onerror=alert(1)>',
    ]) {
      const result = html(input);
      assert.doesNotMatch(
        result.document.replace(/<style>[\s\S]*?<\/style>/g, ''),
        /<script|onerror/,
        input,
      );
    }
  });

  it('reads its own output back to the same body (idempotence)', () => {
    const inputs = [
      '<p>a<div>b</div>c</p><p>d<p>e',
      '<x-custom><p>a<div>b</div></p></x-custom><li>1<li>2',
      '<table><tr><td>a<td>b<tr><td>c</table>',
      '<a href="https://x.example">1<a href="https://y.example">2</a></a>',
      `${'<div>'.repeat(MAX_DEPTH + 10)}deep<div class="gmail_quote">q</div>`,
      '<div class="gmail_quote"><p>q</p></div><p>after</p>',
      '<h1>a<h2>b</h1>c',
      '<dl><dt>a<dd>b<dt>c</dl><ruby>a<rt>b<rp>c</ruby>',
      '<style>#x{color:red} a{content:"</style>"}</style><img src="cid:a" alt=x><img src="https://x.example/i.png" width=5 height=5>',
    ];
    for (const input of inputs) {
      const first = sanitizeBody(input, { cids: ['a'], imagePolicy: 'allow', findQuery: 'a' });
      const second = sanitizeBody(first.body, {
        cids: ['a'],
        imagePolicy: 'allow',
        keepRewritten: true,
      });
      assert.equal(second.body, first.body, input);
    }
  });
});

describe('limits', () => {
  it('flattens 100,000 nested elements past the depth cap and keeps the text', () => {
    const deep = `${'<div>'.repeat(100_000)}bottom${'</div>'.repeat(100_000)}`;
    const start = performance.now();
    const result = html(deep);
    assert.ok(performance.now() - start < 1_000);
    assert.equal(bodyOf(result).match(/<div>/g)?.length, MAX_DEPTH);
    assert.equal(
      result.document.includes('aplos-clipped'),
      true,
      'over the element limit, so clipped and said so',
    );
  });

  it('cuts very long HTML at the limit and says so, but keeps text after a huge style block', () => {
    const long = html(`<p>${'a'.repeat(LIMITS.maxChars + 10)}</p><p>gone</p>`);
    assert.match(bodyOf(long), /aplos-clipped/);
    assert.doesNotMatch(bodyOf(long), /gone/);
    const styled = html(`<style>${'.a{color:red}'.repeat(400_000)}</style><p>after the style</p>`);
    assert.match(bodyOf(styled), /after the style/);
    assert.doesNotMatch(bodyOf(styled), /color:red/, 'an over-budget style block is dropped');
  });
});

describe('the hostile corpus', () => {
  const corpus = loadCorpus({ canaryOrigin: 'http://127.0.0.1:41999' });
  const canaryHosts = (entry: CorpusEntry) => ['127.0.0.1:41999', entry.canaryHost];

  function renderEntry(entry: CorpusEntry, imagePolicy: 'block' | 'allow'): MailHtmlResult {
    return render({
      html: entry.html,
      text: entry.text,
      cids: entry.cids,
      findQuery: entry.findQuery,
      imagePolicy,
    });
  }

  it('has entries to grade against', () => {
    assert.ok(corpus.length >= 150, `${corpus.length} entries`);
  });

  for (const imagePolicy of ['block', 'allow'] as const) {
    it(`renders every message with images ${imagePolicy === 'block' ? 'off' : 'on'}: nothing can run, load or clobber`, () => {
      for (const entry of corpus) {
        const result = renderEntry(entry, imagePolicy);
        if (result.bodyKind === 'text') continue;
        const problems = unsafeParts(result.document, {
          imagesBlocked: imagePolicy === 'block',
          remoteImages: result.remoteImages.length,
          cids: entry.cids.length,
        });
        assert.deepEqual(problems, [], `${entry.id}: ${problems.join('; ')}`);
        // A canary address may survive only as text or a link the reader clicks, never as anything loaded.
        const loadable = loadableValues(result.document).join('\n');
        for (const host of canaryHosts(entry))
          assert.equal(loadable.includes(host), false, `${entry.id} loads from ${host}`);
      }
    });
  }

  it('meets every expectation in the manifest (kept text, trackers, remote images, quotes, marks, body kind)', () => {
    for (const entry of corpus) {
      const blocked = renderEntry(entry, 'block');
      const allowed = renderEntry(entry, 'allow');
      const expect = entry.expect;
      const text = blocked.bodyKind === 'html' ? visibleText(blocked.document) : blocked.text;
      for (const needle of expect.mustKeepText ?? [])
        assert.ok(text.includes(needle), `${entry.id} lost "${needle}"`);
      if (expect.bodyKind) assert.equal(blocked.bodyKind, expect.bodyKind, entry.id);
      if (expect.trackersRemovedMin !== undefined)
        assert.ok(
          blocked.trackersRemoved >= expect.trackersRemovedMin,
          `${entry.id}: ${blocked.trackersRemoved} trackers`,
        );
      if (expect.remoteImages !== undefined)
        assert.equal(
          allowed.remoteImages.length,
          expect.remoteImages,
          `${entry.id}: ${allowed.remoteImages.join(' ')}`,
        );
      if (expect.quotedCountMin !== undefined)
        assert.ok(
          blocked.quotedCount >= expect.quotedCountMin,
          `${entry.id}: ${blocked.quotedCount} quotes`,
        );
      if (expect.marksMin !== undefined)
        assert.ok(blocked.marks >= expect.marksMin, `${entry.id}: ${blocked.marks} marks`);
      assert.deepEqual(blocked.remoteImages, [], `${entry.id} lists images while they are blocked`);
      assert.equal(allowed.trackersRemoved, blocked.trackersRemoved, entry.id);
    }
  });

  it('gives a find query to every entry that expects marks', () => {
    for (const entry of corpus)
      if (entry.expect.marksMin !== undefined) assert.ok(entry.findQuery, entry.id);
  });

  it('reads its own output back to the same body for every message (idempotence)', () => {
    for (const entry of corpus) {
      if (!entry.html?.trim()) continue;
      const options = { cids: entry.cids, imagePolicy: 'allow' as const };
      const first = sanitizeBody(entry.html, { ...options, findQuery: entry.findQuery });
      if (first.clipped) continue;
      const second = sanitizeBody(first.body, { ...options, keepRewritten: true });
      assert.equal(second.body, first.body, entry.id);
    }
  });
});
