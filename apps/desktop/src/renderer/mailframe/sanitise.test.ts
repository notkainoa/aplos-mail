// sanitiseBody against the hostile corpus and the caps. The output is re-parsed and inspected structurally (element
// and attribute names, URL schemes, CSS), so a dangerous word that survives only as escaped text is not a failure.
// Run: cd apps/desktop && npx tsx --test src/renderer/mailframe/sanitise.test.ts

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Parser } from 'htmlparser2';
import { CORPUS } from './corpus';
import { MAX_STYLE_ATTRIBUTE, MAX_STYLE_BLOCK, sanitiseCss } from './css';
import { MAX_BODY_CHARS, NOTICES, sanitiseBody } from './sanitise';

/** The quadratic scans this guards against took 8 to 33 s: a 1 s bound still catches them and survives a loaded machine. */
const MAX_MS = 1000;
import type { ImagePolicy } from './types';

interface Inspected {
  tags: string[];
  attributes: { tag: string; name: string; value: string }[];
  css: string[];
  text: string;
}

function inspect(html: string): Inspected {
  const out: Inspected = { tags: [], attributes: [], css: [], text: '' };
  let inStyle = false;
  const parser = new Parser({
    onopentag(name, attribs) {
      out.tags.push(name);
      inStyle = name === 'style';
      for (const [key, value] of Object.entries(attribs)) {
        out.attributes.push({ tag: name, name: key, value });
        if (key === 'style') out.css.push(value);
      }
    },
    onclosetag() {
      inStyle = false;
    },
    ontext(value) {
      if (inStyle) out.css.push(value);
      else out.text += value;
    },
  });
  parser.write(html);
  parser.end();
  return out;
}

const DANGEROUS_TAGS =
  /^(script|iframe|frame|object|embed|applet|form|input|button|textarea|select|meta|link|base|svg|use|image|math|template|noscript|portal|video|audio|source|picture|foreignobject)$/;
const URL_ATTRIBUTES = new Set(['href', 'src', 'background']);
const ALLOWED_ATTRIBUTES =
  /^(align|valign|dir|lang|title|class|id|bgcolor|color|width|height|border|cellpadding|cellspacing|hspace|vspace|colspan|rowspan|span|nowrap|scope|headers|abbr|face|size|start|type|reversed|clear|open|datetime|style|href|src|background|target|rel|referrerpolicy|data-blocked|data-find)$/;
const BAD_CSS =
  /(?<![\w-])(?:@import|@font-face|@namespace|expression\s*\(|-moz-binding|behaviou?r\s*:|(?:-webkit-)?image-set\s*\()|\\|</i;

/** Every structural rule; `policy` decides whether https images may stay. */
function assertSafe(html: string, policy: ImagePolicy, label: string): Inspected {
  const seen = inspect(html);
  for (const tag of seen.tags) assert.doesNotMatch(tag, DANGEROUS_TAGS, `${label}: <${tag}>`);
  for (const { tag, name, value } of seen.attributes) {
    assert.match(name, ALLOWED_ATTRIBUTES, `${label}: attribute ${name} on <${tag}>`);
    if (!URL_ATTRIBUTES.has(name)) continue;
    if (name === 'href') {
      assert.equal(tag, 'a', `${label}: href on <${tag}>`);
      assert.match(value, /^(https?:\/\/[^@\s]+|mailto:\S+)$/i, `${label}: link ${value}`);
    } else if (policy === 'block') {
      assert.match(
        value,
        /^data:image\/(png|gif|jpe?g|webp);base64,/i,
        `${label}: ${name}=${value}`,
      );
    } else {
      assert.match(value, /^(data:image\/|https:\/\/)/i, `${label}: ${name}=${value}`);
    }
  }
  for (const css of seen.css) {
    assert.doesNotMatch(css, BAD_CSS, `${label}: css ${css}`);
    for (const m of css.matchAll(/url\(\s*"?([^")]*)/gi)) {
      const ok = policy === 'block' ? /^data:image\//i : /^(data:image\/|https:\/\/)/i;
      assert.match(m[1]!, ok, `${label}: css url ${m[1]}`);
    }
  }
  return seen;
}

/** No URL that could load anything outside the frame: only `<a href>` may hold a remote URL. */
function assertNoExternalResources(html: string, label: string): void {
  const seen = inspect(html);
  for (const { tag, name, value } of seen.attributes) {
    if (!URL_ATTRIBUTES.has(name) || (tag === 'a' && name === 'href')) continue;
    assert.doesNotMatch(
      value,
      /(?:^|[\s("'])(?:https?:|wss?:|ftp:)?\/\/[a-z0-9]/i,
      `${label}: ${name}`,
    );
  }
  for (const css of seen.css)
    assert.doesNotMatch(css, /(?:https?:)?\/\/[a-z0-9]/i, `${label}: css`);
}

describe('sanitiseBody: hostile corpus', () => {
  for (const item of CORPUS) {
    for (const policy of ['block', 'load'] as const) {
      test(`${item.id} (${policy}): ${item.vector}`, () => {
        const result = sanitiseBody(item.html, policy);
        const seen = assertSafe(result.html + `<p${result.bodyAttributes}></p>`, policy, item.id);
        if (policy === 'block') assertNoExternalResources(result.html, item.id);
        if (item.keeps)
          assert.ok(seen.text.includes(item.keeps), `${item.id} keeps "${item.keeps}"`);
      });
    }
  }

  test('the corpus covers every vector the lane card names', () => {
    const ids = CORPUS.map(i => i.id);
    for (const id of [
      'inline-script',
      'event-handlers',
      'meta-refresh',
      'link-prefetch',
      'url-trackers',
      'forms',
      'css-import',
      'svg-use',
      'base',
      'meta-http-equiv',
      'javascript-links',
      'giant-table',
      'deep-nesting',
      'redos-css',
      'span-bomb',
    ]) {
      assert.ok(ids.includes(id), id);
    }
  });
});

describe('sanitiseBody: behaviour', () => {
  test('counts every remote tracker it removes when images are blocked', () => {
    const item = CORPUS.find(i => i.id === 'url-trackers')!;
    const { blocked } = sanitiseBody(item.html, 'block');
    // bg, q, li, cursor, escaped, table, td, pixel, protocol-relative, picture img (srcset, poster, input dropped whole)
    assert.ok(blocked >= 10, `blocked ${blocked}`);
  });

  test('loading images keeps https images, drops http and tracking pixels', () => {
    const html =
      '<img src="https://img.example/a.png" width="600"><img src="http://img.example/b.png"><img src="https://t.example/p.gif" width="1" height="1">';
    const result = sanitiseBody(html, 'load');
    assert.match(result.html, /src="https:\/\/img\.example\/a\.png"/);
    assert.doesNotMatch(result.html, /b\.png|p\.gif/);
    assert.equal(result.blocked, 2);
    assert.equal(
      result.trackers,
      1,
      'only the pixel is a tracker; the http image is merely refused',
    );
  });

  test('with images blocked, every remote image is blocked but only pixels count as trackers', () => {
    const html =
      '<img src="https://img.example/a.png" width="600"><img src="https://img.example/b.png"><img src="https://t.example/p.gif" width="1" height="1"><img src="https://t.example/q.gif" style="display:none">';
    const result = sanitiseBody(html, 'block');
    assert.equal(result.blocked, 4);
    assert.equal(result.trackers, 2);
  });

  test('keeps raster data images and drops SVG data images', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const result = sanitiseBody(
      `<img src="${png}"><img src="data:image/svg+xml;base64,PHN2Zz4=">`,
      'block',
    );
    assert.match(result.html, /src="data:image\/png;base64,iVBORw0KGgo="/);
    assert.doesNotMatch(result.html, /svg/);
    assert.equal(result.blocked, 0);
  });

  test('blocked images keep their size so the layout does not jump', () => {
    const result = sanitiseBody(
      '<img src="https://x.example/a.png" width="320" height="200" alt="Logo">',
      'block',
    );
    assert.match(
      result.html,
      /<img width="320" height="200" alt="Logo" data-blocked referrerpolicy="no-referrer">/,
    );
  });

  test('links open outside: target _blank, rel noopener noreferrer, never _self', () => {
    const result = sanitiseBody('<a href="https://safe.example/" target="_self">Go</a>', 'block');
    assert.equal(
      result.html,
      '<a href="https://safe.example/" target="_blank" rel="noopener noreferrer">Go</a>',
    );
  });

  test('unsafe links keep their text and lose the href', () => {
    const result = sanitiseBody('<a href="javascript:alert(1)">Click</a>', 'block');
    assert.equal(result.html, '<a>Click</a>');
  });

  test('text is escaped, entities stay text', () => {
    const result = sanitiseBody('<p>1 &lt; 2 &amp;&amp; &lt;b&gt;bold&lt;/b&gt;</p>', 'block');
    assert.equal(result.html, '<p>1 &lt; 2 &amp;&amp; &lt;b&gt;bold&lt;/b&gt;</p>');
  });

  test("the email's body colour and style move onto the frame's body", () => {
    const result = sanitiseBody(
      '<body bgcolor="#f4efe6" style="color:#333" onload="x()"><p>Hi</p></body>',
      'block',
    );
    assert.equal(result.bodyAttributes, ' bgcolor="#f4efe6" style="color:#333"');
  });

  test('a table over 5,000 cells becomes text with a notice kept out of the letter', () => {
    const result = sanitiseBody(CORPUS.find(i => i.id === 'giant-table')!.html, 'block');
    assert.equal(result.flattened, true);
    assert.deepEqual(result.notices, [NOTICES.flattened]);
    assert.doesNotMatch(result.html, /<table|<td|aplos-notice/);
  });

  test('colspan and rowspan are clamped to 1-100, not dropped', () => {
    const result = sanitiseBody(
      '<table><tr><td colspan="1000" rowspan="2">a</td><td colspan="-3" rowspan="0">b</td></tr></table>',
      'block',
    );
    assert.match(
      result.html,
      /<td colspan="100" rowspan="2">a<\/td><td colspan="1" rowspan="1">b<\/td>/,
    );
  });

  test('spanned cells count colspan x rowspan toward the cell cap', () => {
    const row = (cells: number, span: number) =>
      `<table><tr>${`<td colspan="${span}">x</td>`.repeat(cells)}</tr></table>`;
    assert.equal(sanitiseBody(row(60, 1_000), 'block').flattened, true, '60 x 100 = 6,000');
    assert.equal(sanitiseBody(row(400, 10), 'block').flattened, false, '400 x 10 = 4,000');
    const bomb = sanitiseBody(CORPUS.find(i => i.id === 'span-bomb')!.html, 'block');
    assert.equal(bomb.flattened, true);
  });

  test('nesting over 200 levels becomes text; 200 levels stay layout', () => {
    const deep = sanitiseBody('<div>'.repeat(201) + 'x' + '</div>'.repeat(201), 'block');
    const ok = sanitiseBody('<div>'.repeat(200) + 'x' + '</div>'.repeat(200), 'block');
    assert.equal(deep.flattened, true);
    assert.equal(ok.flattened, false);
  });

  test('100,000 nested divs do not overflow the stack', () => {
    const result = sanitiseBody('<div>'.repeat(100_000) + 'x', 'block');
    assert.equal(result.flattened, true);
    assert.match(result.html, /x<\/div>$/);
  });

  test('bodies over the size cap are cut with a notice', () => {
    const result = sanitiseBody('<p>' + 'a'.repeat(MAX_BODY_CHARS + 10) + '</p>', 'block');
    assert.equal(result.truncated, true);
    assert.deepEqual(result.notices, [NOTICES.truncated]);
    assert.doesNotMatch(result.html, /aplos-notice/);
    assert.ok(result.html.length < MAX_BODY_CHARS + 500);
  });

  test('a style block can never be closed early', () => {
    const result = sanitiseBody(
      '<style>a{content:"</style><script>x</script>"}</style><p>ok</p>',
      'block',
    );
    assert.doesNotMatch(result.html, /<script/);
    assert.equal((result.html.match(/<\/style>/g) ?? []).length, 1);
  });

  test('a pixel sized by its style attribute is removed when loading', () => {
    const pixels = [
      'style="width:1px;height:1px"',
      'style="width:0;height:0"',
      'style="WIDTH: 1EM; height : 1em"',
      'style="width:1px!important;height:0px"',
      'width="1" style="height:1px"',
      'style="max-width:1px;max-height:1px"',
    ];
    for (const sizing of pixels) {
      const result = sanitiseBody(`<img src="https://t.example/p.gif" ${sizing}>`, 'load');
      assert.doesNotMatch(result.html, /t\.example/, sizing);
      assert.equal(result.blocked, 1, sizing);
    }
    const banner = sanitiseBody(
      '<img src="https://img.example/a.png" style="width:600px;height:1px">',
      'load',
    );
    assert.match(banner.html, /img\.example/);
  });

  test('a style block over 200 KB is cut and its remainder dropped', () => {
    const tail = 'b{background:url(https://t.example/late.gif)}';
    const css = `p{color:red}${' '.repeat(MAX_STYLE_BLOCK)}${tail}`;
    const result = sanitiseBody(`<style>${css}</style><p>x</p>`, 'load');
    assert.match(result.html, /p\{color:red\}/);
    assert.doesNotMatch(result.html, /t\.example|b\{/);
  });

  test('a style attribute over 8 KB is cut and its remainder dropped', () => {
    const style = `color:red;${' '.repeat(MAX_STYLE_ATTRIBUTE)};background:url(https://t.example/x)`;
    const result = sanitiseBody(`<p style="${style}">x</p>`, 'load');
    assert.match(result.html, /style="color:red;/);
    assert.doesNotMatch(result.html, /t\.example|background/);
  });

  test('!important on the body style cannot beat the host', () => {
    const result = sanitiseBody('<body style="height:2px!important"><p>x</p></body>', 'block');
    assert.doesNotMatch(result.bodyAttributes, /!|important/);
  });

  test('a 400 KB pathological style block sanitises in under 1 s', () => {
    const html = `<style>p{x:${'a'.repeat(400_000)}}</style><p style="x:url(${' '.repeat(8_000)}">x</p>`;
    const start = performance.now();
    sanitiseBody(html, 'load');
    const elapsed = performance.now() - start;
    assert.ok(elapsed < MAX_MS, `${elapsed.toFixed(0)} ms`);
  });

  test('is deterministic', () => {
    for (const item of CORPUS)
      assert.equal(sanitiseBody(item.html, 'block').html, sanitiseBody(item.html, 'block').html);
  });
});

describe('sanitiseCss', () => {
  const run = (css: string, policy: ImagePolicy = 'block') => {
    const count = { blocked: 0 };
    return { css: sanitiseCss(css, policy, count), blocked: count.blocked };
  };

  test('decodes escapes before checking, then emits no backslash', () => {
    const out = run('a{background:\\75 rl(https://t.example/x)}');
    assert.equal(out.css, 'a{background:none}');
    assert.equal(out.blocked, 1);
  });

  test('a comment cannot hide or form an @import', () => {
    assert.doesNotMatch(run('@imp/**/ort "https://t.example/a.css";').css, /@import/i);
    assert.deepEqual(run('@import "https://t.example/a.css";p{}'), { css: 'p{}', blocked: 1 });
  });

  test('an unterminated comment swallows the rest', () => {
    assert.equal(run('a{color:red}/* b{background:url(https://t.example/x)}').css, 'a{color:red}');
  });

  test('an unreadable url( is neutralised', () => {
    const out = run('a{background:url(https://t.example/x'); // no closing parenthesis
    assert.doesNotMatch(out.css, /url\(/i);
  });

  test('keeps colours, layout and data images', () => {
    const css = 'td{color:#333;padding:4px;background:url("data:image/gif;base64,R0lGOD==")}';
    assert.equal(run(css).css, css);
  });

  test('url() inside :hover, :active, :focus and [open] rules is dropped even when loading', () => {
    const css = [
      'a:hover{background:url(https://t.example/h.gif)}',
      'p:focus-within{background:url(https://t.example/f.gif)}',
      '@media screen{b:active{background:url("https://t.example/a.gif")}}',
      'details[open] i{background:url(https://t.example/o.gif)}',
      'a{&:hov\\65r{background:url(https://t.example/n.gif)}}',
      'i{background:url(https://img.example/ok.png)}',
    ].join('');
    const out = run(css, 'load');
    assert.doesNotMatch(out.css, /t\.example/);
    assert.match(out.css, /url\("https:\/\/img\.example\/ok\.png"\)/);
    assert.equal(out.blocked, 5);
  });

  test('a string or a function cannot end a :hover rule early', () => {
    for (const css of [
      'a:hover{content:"}";background:url(https://t.example/1)}',
      "a:hover{content:'}';background:url(https://t.example/2)}",
      'a:hover{x:f(});background:url(https://t.example/3)}',
      'a:hover{x:[}];background:url(https://t.example/4)}',
    ]) {
      assert.doesNotMatch(run(css, 'load').css, /t\.example/, css);
    }
  });

  test('!important and @layer are removed from email CSS', () => {
    const out = run(
      '@layer aplos{html{height:5px!important}}p{color:red ! important;margin:0!IMPORTANT}b{x:1!!importantimportant}',
    );
    assert.doesNotMatch(out.css, /!|@layer/i);
    assert.match(out.css, /p\{color:red/);
  });

  test('erasing remote text cannot join the pieces around it into a url(', () => {
    const out = run('a{background:url//x(/relative.png)}', 'load');
    assert.doesNotMatch(out.css, /url\(/i);
  });
});

describe('sanitiseCss: linear time on hostile input', () => {
  const SIZE = 400_000;
  const cases: [string, string][] = [
    ['letters', 'a'.repeat(SIZE)],
    ['a scheme run before //', `${'a'.repeat(SIZE)}://x`],
    ['url( then spaces', `url(${' '.repeat(SIZE)}`],
    ['url( repeated', 'url('.repeat(SIZE / 4)],
    ['quoted url( unclosed', `url("https:${'a'.repeat(SIZE)}`],
    ['unclosed comments', '/*x'.repeat(SIZE / 3)],
    ['string functions unclosed', 'image('.repeat(SIZE / 6)],
    ['bangs and spaces', `!${' '.repeat(SIZE)}`],
    ['hover rules', 'a:hover{'.repeat(SIZE / 8)],
    ['slashes', '//'.repeat(SIZE / 2)],
  ];
  for (const [name, css] of cases) {
    test(`${name}: 400 KB in under 1 s`, () => {
      const start = performance.now();
      sanitiseCss(css, 'load', { blocked: 0 });
      const elapsed = performance.now() - start;
      assert.ok(elapsed < MAX_MS, `${elapsed.toFixed(0)} ms`);
    });
  }
});
