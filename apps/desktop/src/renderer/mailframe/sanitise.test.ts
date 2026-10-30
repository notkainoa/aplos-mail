// sanitiseBody against the hostile corpus and the caps. The output is re-parsed and inspected structurally (element
// and attribute names, URL schemes, CSS), so a dangerous word that survives only as escaped text is not a failure.
// Run: cd apps/desktop && npx tsx --test src/renderer/mailframe/sanitise.test.ts

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Parser } from 'htmlparser2';
import { CORPUS } from './corpus';
import { sanitiseCss } from './css';
import { MAX_BODY_CHARS, NOTICES, sanitiseBody } from './sanitise';
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

  test('a table over 5,000 cells becomes text with a notice', () => {
    const result = sanitiseBody(CORPUS.find(i => i.id === 'giant-table')!.html, 'block');
    assert.equal(result.flattened, true);
    assert.ok(
      result.html.startsWith(`<p class="aplos-notice">${NOTICES.flattened.replace('’', '’')}</p>`),
    );
    assert.doesNotMatch(result.html, /<table|<td/);
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
    assert.ok(result.html.includes(NOTICES.truncated.replace('’', '’')));
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
});
