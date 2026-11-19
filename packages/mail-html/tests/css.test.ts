import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cssIdent, readDeclarations, sanitizeCss, viewportLength } from '../src/css';
import { ImageBook, type ImagePolicy } from '../src/images';
import { unsafeParts } from './oracle';

// The CSS writer on its own: every way CSS can name a URL, every at-rule that fetches, and every
// way to end a `<style>` early. Each output is also checked by the oracle's independent tokenizer
// reading, wrapped in a document as the frame would get it.

function clean(
  css: string,
  policy: ImagePolicy = 'block',
  cids: string[] = [],
): { css: string; images: ImageBook } {
  const images = new ImageBook({ cids, policy });
  const out = sanitizeCss(css, images);
  const problems = unsafeParts(
    `<body><style>${out}</style><p style="${out.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">x</p>`,
    {
      imagesBlocked: policy === 'block',
      remoteImages: images.remote.length,
      cids: cids.length,
    },
  );
  assert.deepEqual(problems, [], `${css} -> ${out}: ${problems.join('; ')}`);
  return { css: out, images };
}

describe('url() in all its spellings', () => {
  it('drops every remote or unknown url() when images are blocked, but records remote ones', () => {
    const spellings = [
      'a{background:url(https://x.example/a.png)}',
      'a{background:URL(https://x.example/a.png)}',
      'a{background:url( "https://x.example/a.png" )}',
      "a{background:url('https://x.example/a.png')}",
      'a{background:\\75rl(https://x.example/a.png)}',
      'a{background:u\\72l(https://x.example/a.png)}',
      'a{background:\\55 \\52 \\4c (https://x.example/a.png)}',
      'a{background:url(https:\\2f\\2fx.example/a.png)}',
      'a{background:url(//x.example/a.png)}',
      'a{background:url(\\\\x.example\\a.png)}',
      'a{background:url(javascript:alert(1))}',
      'a{background:url(data:image/svg+xml,<svg onload=alert(1)>)}',
      'a{background:url(data:image/png;base64,iVBORw0KGgo=)}',
      'a{background:url(img/0)}',
      'a{background:url(cid/0)}',
      'a{background:url(/relative.png)}',
      'a{background:url(https://x.example/a.png}',
      'a{background:url(https://x.example/(a).png)}',
      'a{background:url(https://x.example/a.png',
      'a{background:src("https://x.example/a.png")}',
      'a{background:src(var(--u))}',
      'a{cursor:url(https://x.example/c.cur),auto}',
      'a{list-style:url(https://x.example/l.png)}',
      'a{border-image:url(https://x.example/b.png) 30}',
      'a{-webkit-mask-image:url(https://x.example/m.png)}',
      'a{content:url(https://x.example/c.png)}',
      'a{filter:url(https://x.example/f.svg#x)}',
      'a{background:-webkit-cross-fade(url(https://x.example/a.png),url(https://x.example/b.png),50%)}',
    ];
    for (const css of spellings) {
      const { css: out } = clean(css);
      assert.doesNotMatch(out, /x\.example|javascript|data:|svg|img\/|cid\//i, css);
    }
    assert.deepEqual(clean('a{background:url(https://x.example/a.png)}').images.remote, [
      'https://x.example/a.png',
    ]);
  });

  it('rewrites allowed remote images to img/<n> and known cids to cid/<n>', () => {
    const { css, images } = clean(
      'a{background:url(https://x.example/a.png)} b{background:url("cid:logo@x")} c{background:\\75rl(https://x.example/a.png)}',
      'allow',
      ['logo@x'],
    );
    assert.equal(
      css,
      'a{background:url("img/0")} b{background:url("cid/0")} c{background:url("img/0")}',
    );
    assert.deepEqual(images.remote, ['https://x.example/a.png']);
  });

  it('treats strings in image-set() as URLs and empties address-like strings elsewhere', () => {
    assert.equal(
      clean('a{background:image-set("https://x.example/a.png" 1x, "b.png" 2x)}', 'allow').css,
      'a{background:image-set(url("img/0") 1x,  none  2x)}',
    );
    assert.equal(
      clean('a{background:-webkit-image-set(url(https://x.example/a.png) 1x)}').css,
      'a{background:-webkit-image-set( none  1x)}',
    );
    assert.equal(
      clean('a{background:image("https://x.example/a.png")}').css,
      'a{background:image( none )}',
    );
    assert.equal(
      clean(
        'a{--u:"https://x.example/a.png";--v:"ht\tps://x.example/";--w:"//x.example/";--f:"Helvetica Neue"}',
      ).css,
      'a{--u:"";--v:"";--w:"";--f:"Helvetica Neue"}',
    );
    assert.equal(clean('a{content:attr(title);b:attr(data-src url)}').css, 'a{content:"";b:""}');
    assert.equal(
      clean('a{b:image-set(var(--x) 1x, attr(title) 2x, env(x));c:var(--x);--x:"img/0"}').css,
      'a{b:image-set( none  1x,  none  2x,  none );c:var(--x);--x:"img/0"}',
    );
  });
});

describe('at-rules', () => {
  it('drops @import, @font-face and every at-rule outside the layout set, in any spelling', () => {
    for (const css of [
      '@import url(https://x.example/a.css);',
      '@import "https://x.example/a.css";',
      '@IMPORT "https://x.example/a.css" screen;',
      '@\\69mport "https://x.example/a.css";',
      '@import url(https://x.example/a.css) layer(x) supports(display:grid) screen;',
      '@font-face{font-family:F;src:url(https://x.example/f.woff2) format("woff2"),local(Arial)}',
      '@namespace svg url(http://www.w3.org/2000/svg);',
      '@charset "utf-8";',
      '@property --x{syntax:"<url>";inherits:false;initial-value:url(https://x.example/p.png)}',
      '@counter-style x{system:cyclic;symbols:url(https://x.example/s.png)}',
      '@page{background:url(https://x.example/p.png)}',
      '@document url-prefix(https://x.example){a{color:red}}',
      '@-moz-document url-prefix(){a{color:red}}',
    ]) {
      const { css: out } = clean(css);
      assert.doesNotMatch(out, /x\.example|@/i, css);
    }
  });

  it('keeps layout at-rules and sanitizes inside them, including an @import nested in them', () => {
    const { css } = clean(
      '@media (max-width:600px){.a{color:red}@import "https://x.example/a.css";.b{background:url(https://x.example/b.png)}}@supports (display:grid){.c{display:grid}}',
    );
    assert.equal(
      css,
      '@media (max-width:600px){.a{color:red}/**/.b{background: none }}@supports (display:grid){.c{display:grid}}',
    );
  });
});

describe('ending the style element early', () => {
  it('never writes </ outside a string, and escapes it inside one', () => {
    assert.equal(
      clean('a{content:"</style><script>alert(1)</script>"}').css,
      'a{content:"<\\/style><script>alert(1)<\\/script>"}',
    );
    assert.equal(clean('a{b:c}</style><script>alert(1)</script>').css.includes('</'), false);
    assert.equal(clean('a\\</style>').css.includes('</'), false);
    assert.equal(clean('a{b:"x\\</style>"}').css.includes('</'), false);
    assert.equal(clean('a{b:c} /* </style><script>x</script> */').css, 'a{b:c} /**/');
    assert.equal(clean('<!-- a{b:c} -->').css, '<!-- a{b:c} -->');
  });

  it('turns NUL into U+FFFD', () => {
    assert.equal(clean('a{b:c\u0000d}').css.includes('\u0000'), false);
  });
});

describe('aplos- class names, in every selector position', () => {
  // `clean` also runs the oracle, which fails on any selector still naming an `aplos-` class.
  const hidden = (selector: string): string => clean(`${selector}{display:none}`).css;

  it('moves a class selector to m-aplos- through comments, escapes, lists and nesting', () => {
    const cases: [string, string][] = [
      ['.aplos-quote', '.m-aplos-quote'],
      ['details.APLOS-Quote', 'details.m-APLOS-Quote'],
      ['./**/aplos-quote', './**/m-aplos-quote'],
      ['./**//**/aplos-quote', './**//**/m-aplos-quote'],
      ['.\\61plos-quote', '.m-aplos-quote'],
      [':is(.aplos-quote, a)', ':is(.m-aplos-quote, a)'],
      [':where(.aplos-quote, b)', ':where(.m-aplos-quote, b)'],
      [':not(.aplos-quote)', ':not(.m-aplos-quote)'],
      [':has(> .aplos-find)', ':has(> .m-aplos-find)'],
      ['a:is(.x .aplos-find, .y)', 'a:is(.x .m-aplos-find, .y)'],
    ];
    for (const [selector, want] of cases) assert.equal(hidden(selector), `${want}{display:none}`);
  });

  it('moves it inside malformed argument lists, where no { follows', () => {
    const cases: [string, string][] = [
      [':is(.aplos-quote, ;)', ':is(.m-aplos-quote, ;)'],
      [':where(.aplos-quote, })', ':where(.m-aplos-quote, })'],
      [':is(.aplos-quote', ':is(.m-aplos-quote'],
      ['.a{:is(.aplos-quote, ;)}', '.a{:is(.m-aplos-quote, ;)}'],
    ];
    for (const [css, want] of cases) assert.equal(clean(css).css, want, css);
  });

  it('leaves what is not a class selector alone', () => {
    const css = 'a{animation-name:aplos-fade;content:".aplos-x"}. aplos-x{b:c}.aplosx{d:e}';
    assert.equal(sanitizeCss(css, new ImageBook({ cids: [], policy: 'block' })), css);
  });

  it('moves the value of a [class] selector, whatever the operator, quoting, flag or spelling', () => {
    const cases: [string, string][] = [
      ['[class=aplos-quote]', '[class=m-aplos-quote]'],
      ['[class="aplos-quote"]', '[class="m-aplos-quote"]'],
      ["[class='APLOS-quote' i]", '[class="m-APLOS-quote" i]'],
      ['[CLASS ~= "aplos-quote"]', '[CLASS ~= "m-aplos-quote"]'],
      ['[class~="aplos-quote"]', '[class~="m-aplos-quote"]'],
      ['[class^=aplos-]', '[class^=m-aplos-]'],
      ['[class^="aplos-q" s]', '[class^="m-aplos-q" s]'],
      ['[class^=aplos]', '[class^=m-aplos]'],
      ['[class$=aplos-quote]', '[class$=m-aplos-quote]'],
      ['[class*=aplos-]', '[class*=m-aplos-]'],
      ['[class*=aplos]', '[class*=m-aplos]'],
      ['[class|=aplos]', '[class|=m-aplos]'],
      ['[class|="aplos-find"]', '[class|="m-aplos-find"]'],
      ['[class*="x aplos-find"]', '[class*="x m-aplos-find"]'],
      ['[ class /**/ ^ /**/ = /**/ aplos- ]', '[ class /**/ ^ /**/ = /**/ m-aplos- ]'],
      ['[class^/**/=aplos-]', '[class^/**/=m-aplos-]'],
      ['[*|class^=aplos-]', '[*|class^=m-aplos-]'],
      ['[|class|=aplos]', '[|class|=m-aplos]'],
      ['[cl\\61ss=\\61plos-quote]', '[cl\\61ss=m-aplos-quote]'],
      ['div:is([class^=aplos-], p)', 'div:is([class^=m-aplos-], p)'],
      ['[class^=aplos-', '[class^=m-aplos-'],
    ];
    for (const [selector, want] of cases) assert.equal(hidden(selector), `${want}{display:none}`);
  });

  it('moves every name in a value that holds several, and keeps its whitespace as written', () => {
    const cases: [string, string][] = [
      ['[class="foo aplos-x"]', '[class="foo m-aplos-x"]'],
      ['[class~="foo aplos-x"]', '[class~="foo m-aplos-x"]'],
      ['[class$="foo aplos-x"]', '[class$="foo m-aplos-x"]'],
      ['[class^="foo aplos-x"]', '[class^="foo m-aplos-x"]'],
      ['[class|="foo aplos-x"]', '[class|="foo m-aplos-x"]'],
      ['[class="foo  aplos-x\\9 bar\\a aplos-y"]', '[class="foo  m-aplos-x\\9 bar\\a m-aplos-y"]'],
      ['[class="  foo   aplos-x "]', '[class="  foo   m-aplos-x "]'],
      ['[class="xaplos-x aplos-y"]', '[class="xaplos-x m-aplos-y"]'],
    ];
    for (const [selector, want] of cases) assert.equal(hidden(selector), `${want}{display:none}`);
    // Unquoted, `foo aplos-x` is not one value: the browser drops the whole rule (the value would
    // be `foo`), so it is written as it came. (Not through `clean`: the oracle reads the brackets.)
    const css = '[class=foo aplos-x]{display:none}';
    assert.equal(sanitizeCss(css, new ImageBook({ cids: [], policy: 'block' })), css);
  });

  it('judges a rewritten [class] value like any other string: no address gets through it', () => {
    // A string that looks like an address is emptied, whatever the rewrite made of it.
    assert.equal(
      clean('a{--x:[class="https://evil.example/p.png aplos-q"]}').css,
      'a{--x:[class=""]}',
    );
    assert.equal(clean('a{--x:[class="aplos-q:x"]}').css, 'a{--x:[class=""]}');
    // Inside an image function it is an image URL: classified, never written as it came.
    const inside = clean(
      'a{b:image-set([class="aplos-q https://evil.example/p.png"] 1x, [class="https://evil.example/q.png aplos-q"] 2x)}',
      'allow',
    );
    assert.equal(inside.css, 'a{b:image-set([class= none ] 1x, [class=url("img/0")] 2x)}');
    assert.doesNotMatch(inside.css, /evil|aplos/);
    assert.equal(inside.images.remote.length, 1);
    // The address after the aplos- name is no URL in a plain string, as before the rewrite.
    assert.equal(
      clean('a{--x:[class="aplos-q https://evil.example/p.png"]}').css,
      'a{--x:[class="m-aplos-q https://evil.example/p.png"]}',
    );
  });

  it('keeps attribute selectors that cannot name an Aplos class', () => {
    for (const selector of [
      '[class^=m-aplos-]',
      '[class*="x-aplos-"]',
      '[class=aplosx]',
      '[class~=aplos]',
      '[class$=aplos]',
      '[class^=ap]',
      '[class]',
      '[title^=aplos-]',
      '[data-class=aplos-quote]',
      '[id^=aplos-]',
    ]) {
      assert.equal(hidden(selector), `${selector}{display:none}`, selector);
    }
  });

  it('cannot reach Aplos through ids: mail ids all become m-<id>, and Aplos writes none', () => {
    assert.equal(hidden('#aplos-quote'), '#m-aplos-quote{display:none}');
    assert.equal(hidden('#m-aplos-quote'), '#m-aplos-quote{display:none}');
  });

  it('is idempotent on selectors it moved', () => {
    for (const css of ['[class^=aplos-]{a:b}', './**/aplos-x{a:b}', ':is(.aplos-x, ;)']) {
      const once = clean(css).css;
      assert.equal(clean(once).css, once, css);
    }
  });

  it('reads a long run of [ in linear time', () => {
    const book = new ImageBook({ cids: [], policy: 'block' });
    const shapes = ['[class'.repeat(100_000), '[a '.repeat(100_000), `[${'a '.repeat(100_000)}`];
    const start = performance.now();
    for (const css of shapes) sanitizeCss(css, book);
    assert.ok(performance.now() - start < 1500, `${performance.now() - start} ms`);
  });
});

describe('ids and declarations', () => {
  it('moves #id selectors into the m- namespace but leaves colours alone', () => {
    assert.equal(
      clean(
        '#outlook a{padding:0}#bodyTable,.x #m-done{color:#fff}a{color:#abc;b:#123}@media x{#y{c:d}}',
      ).css,
      '#m-outlook a{padding:0}#m-bodyTable,.x #m-done{color:#fff}a{color:#abc;b:#123}@media x{#m-y{c:d}}',
    );
    assert.equal(cssIdent('a b\\c"d1'), 'a\\20 b\\5c c\\22 d1');
  });

  it('reads declarations through escapes and comments, the last one winning', () => {
    const declarations = readDeclarations(
      'DISP\\6c ay : none !important; width:1px; width:/**/2PX; opacity:0.0;; garbage; height',
    );
    assert.equal(declarations.get('display'), 'none');
    assert.equal(declarations.get('width'), '2px');
    assert.equal(declarations.get('opacity'), '0');
    assert.equal(declarations.has('height'), false);
  });

  it('is idempotent on its own output', () => {
    for (const css of [
      'a{background:url(https://x.example/a.png)}/* c */@import "x";#a{b:"</style>"}',
      'a{content:attr(x);--u:"https://x"}<!-- -->',
      '#x\\31 23{color:red}a\\</style>',
    ]) {
      const once = sanitizeCss(css, new ImageBook({ cids: [], policy: 'allow' }));
      const twice = sanitizeCss(
        once,
        new ImageBook({ cids: [], policy: 'allow', ownOutput: true }),
      );
      assert.equal(twice, once, css);
    }
  });
});

describe('viewport units', () => {
  it('turns every viewport unit into a fixed length in px, in any case and spelling', () => {
    const cases: [string, string][] = [
      ['a{height:100vh}', 'a{height:600px}'],
      ['a{width:100vw}', 'a{width:640px}'],
      ['a{height:100VH}', 'a{height:600px}'],
      ['a{height:50dvh}', 'a{height:300px}'],
      ['a{height:50svh}', 'a{height:300px}'],
      ['a{height:50lvh}', 'a{height:300px}'],
      ['a{width:50dvw;margin:10svw}', 'a{width:320px;margin:64px}'],
      ['a{height:10vb;width:10vi}', 'a{height:60px;width:64px}'],
      ['a{height:10vmin;width:10vmax}', 'a{height:60px;width:64px}'],
      ['a{height:10dvmin;width:10lvmax}', 'a{height:60px;width:64px}'],
      ['a{height:-10vh}', 'a{height:-60px}'],
      ['a{height:.5vh}', 'a{height:3px}'],
      ['a{height:1e2vh}', 'a{height:600px}'],
      ['a{height:100\\76h}', 'a{height:600px}'],
      ['a{height:100v\\68}', 'a{height:600px}'],
      ['a{height:calc(100vh - 20px)}', 'a{height:calc(600px - 20px)}'],
      ['a{height:calc(100vh*2 + 10vw)}', 'a{height:calc(600px*2 + 64px)}'],
      ['a{height:min(100vh,max(50vh,10vw))}', 'a{height:min(600px,max(300px,64px))}'],
      ['a{--h:100vh;height:var(--h)}', 'a{--h:600px;height:var(--h)}'],
      ['@media (min-height:100vh){a{b:c}}', '@media (--m-min-height:600px){a{b:c}}'],
      ['a{height:100vh!important}', 'a{height:600px!important}'],
      ['a{height:calc(1px+100vh)}', 'a{height:calc(1px+600px)}'],
      ['a{height:calc(1px+100cqh)}', 'a{height:calc(1px+600px)}'],
      ['a{top:+5vmin;left:-5vmax;width:+.5vw}', 'a{top:+30px;left:-32px;width:+3.2px}'],
      ['a{height:calc(+10vh)}', 'a{height:calc(+60px)}'],
      ['a{height:calc(100vh/2 - 5vw*2)}', 'a{height:calc(600px/2 - 32px*2)}'],
      ['a{height:calc(-1*10vh)}', 'a{height:calc(-1*60px)}'],
      ['a{height:100cqh;width:100cqw}', 'a{height:600px;width:640px}'],
      ['a{height:10cqb;width:10cqi}', 'a{height:60px;width:64px}'],
      ['a{height:10cqmin;width:10cqmax}', 'a{height:60px;width:64px}'],
      ['a{min-height:100CQB;height:100\\63 qh}', 'a{min-height:600px;height:600px}'],
      ['a{height:calc(100cqh - 1cqw)}', 'a{height:calc(600px - 6.4px)}'],
      ['a{--h:100cqh;height:var(--h)}', 'a{--h:600px;height:var(--h)}'],
      ['@container (min-height:100cqh){a{b:c}}', '@container (--m-min-height:600px){a{b:c}}'],
    ];
    for (const [input, expected] of cases) assert.equal(clean(input).css, expected, input);
  });

  it('bounds an absurd length', () => {
    assert.equal(clean('a{height:99999999vh}').css, 'a{height:100000px}');
    assert.equal(clean('a{height:-99999999vh}').css, 'a{height:-100000px}');
    assert.equal(clean('a{height:1e400vh}').css, 'a{height:100000px}');
  });

  it('rewrites a style attribute too', () => {
    const images = new ImageBook({ cids: [], policy: 'block' });
    const out = sanitizeCss('min-height:100vh;width:100vw', images);
    assert.equal(out, 'min-height:600px;width:640px');
  });

  it('leaves every other unit, number and name alone', () => {
    const same = [
      'a{height:100px;width:50%;margin:1em 2rem;line-height:1.5;z-index:100}',
      'a{height:100vhx;width:100v;font-size:100 vh}',
      'a{height:100ch;width:100cq;top:0;margin:1cqx 2vq}',
      'a{content:"100vh";grid-area:vh}',
    ];
    for (const input of same) assert.equal(clean(input).css, input, input);
  });

  it('measures the units against the reading viewport', () => {
    assert.equal(viewportLength(100, 'vh'), '600px');
    assert.equal(viewportLength(100, 'DVW'), '640px');
    assert.equal(viewportLength(100, 'vmin'), '600px');
    assert.equal(viewportLength(100, 'vmax'), '640px');
    assert.equal(viewportLength(100, 'cqh'), '600px');
    assert.equal(viewportLength(100, 'CQW'), '640px');
    assert.equal(viewportLength(100, 'cqmin'), '600px');
    assert.equal(viewportLength(100, 'cqmax'), '640px');
    assert.equal(viewportLength(100, 'cq'), undefined);
    assert.equal(viewportLength(100, 'px'), undefined);
    assert.equal(viewportLength(100, 'vhh'), undefined);
    assert.equal(viewportLength(100, 'xvh'), undefined);
  });
});

describe('@layer names', () => {
  it('moves every layer name into the m- namespace, so no mail layer is the reading layer', () => {
    const cases: [string, string][] = [
      ['@layer aplos-reading{a{b:c}}', '@layer m-aplos-reading{a{b:c}}'],
      ['@layer \\61 plos-reading{a{b:c}}', '@layer m-aplos-reading{a{b:c}}'],
      ['@layer APLOS-reading{a{b:c}}', '@layer m-APLOS-reading{a{b:c}}'],
      ['@LAYER aplos-reading.x.y{a{b:c}}', '@LAYER m-aplos-reading.m-x.m-y{a{b:c}}'],
      ['@layer a,aplos-reading ,b;', '@layer m-a,m-aplos-reading ,m-b;'],
      ['@layer/**/aplos-reading/**/{a{b:c}}', '@layer/**/m-aplos-reading/**/{a{b:c}}'],
      ['@layer{a{b:c}}', '@layer{a{b:c}}'],
      ['@media x{@layer aplos-reading{a{b:c}}}', '@media x{@layer m-aplos-reading{a{b:c}}}'],
      ['@layer m-x{a{b:c}}', '@layer m-x{a{b:c}}'],
    ];
    for (const [input, expected] of cases) assert.equal(clean(input).css, expected, input);
  });

  it('leaves identifiers after the prelude alone', () => {
    assert.equal(clean('@layer x{aplos-reading{b:c}}').css, '@layer m-x{aplos-reading{b:c}}');
    assert.equal(clean('@layer x;a{b:aplos-reading}').css, '@layer m-x;a{b:aplos-reading}');
  });

  it('is idempotent on its own output', () => {
    const once = sanitizeCss(
      '@layer a.b,c;@layer a{x{y:z}}',
      new ImageBook({ cids: [], policy: 'block' }),
    );
    const twice = sanitizeCss(once, new ImageBook({ cids: [], policy: 'block', ownOutput: true }));
    assert.equal(twice, once);
  });
});

describe('height-following media features and writing modes', () => {
  it('makes a height, shape or orientation feature in @media and @container an unknown name', () => {
    const cases: [string, string][] = [
      ['@media (max-height:300px){a{b:c}}', '@media (--m-max-height:300px){a{b:c}}'],
      ['@MEDIA (MIN-HEIGHT:1px){a{b:c}}', '@MEDIA (--m-min-height:1px){a{b:c}}'],
      [
        '@media screen and (min-height:1px) and (orientation:landscape),print{a{b:c}}',
        '@media screen and (--m-min-height:1px) and (--m-orientation:landscape),print{a{b:c}}',
      ],
      ['@media (height >= 300px){a{b:c}}', '@media (--m-height >= 300px){a{b:c}}'],
      ['@media (300px<height<600px){a{b:c}}', '@media (300px<--m-height<600px){a{b:c}}'],
      ['@media (min-\\68 eight:1px){a{b:c}}', '@media (--m-min-height:1px){a{b:c}}'],
      ['@media (aspect-ratio:1/1){a{b:c}}', '@media (--m-aspect-ratio:1/1){a{b:c}}'],
      ['@media (max-device-height:9px){a{b:c}}', '@media (--m-max-device-height:9px){a{b:c}}'],
      [
        '@media not (device-aspect-ratio:4/3){a{b:c}}',
        '@media not (--m-device-aspect-ratio:4/3){a{b:c}}',
      ],
      ['@container card (min-height:5px){a{b:c}}', '@container card (--m-min-height:5px){a{b:c}}'],
      ['@container (block-size > 5px){a{b:c}}', '@container (--m-block-size > 5px){a{b:c}}'],
      [
        '@media x{@media (orientation:portrait){a{b:c}}}',
        '@media x{@media (--m-orientation:portrait){a{b:c}}}',
      ],
    ];
    for (const [input, expected] of cases) assert.equal(clean(input).css, expected, input);
  });

  it('leaves width features, other at-rules and every declaration alone', () => {
    const same = [
      '@media (min-width:300px) and (max-width:100px){a{height:1px}}',
      '@media (min-resolution:2dppx),(prefers-color-scheme:dark){a{b:c}}',
      '@media screen{a{min-height:1px;orientation:x;height:2px}}',
      '@supports (height:1px){a{b:c}}',
      '@container (min-width:5px){a{height:1px}}',
      'a{height:1px;max-height:2px;aspect-ratio:1/2}',
    ];
    for (const input of same) assert.equal(clean(input).css, input, input);
  });

  it('turns writing-mode into a custom property name, in any spelling, before a colon only', () => {
    const cases: [string, string][] = [
      ['a{writing-mode:vertical-rl}', 'a{--m-writing-mode:vertical-rl}'],
      ['a{-webkit-writing-mode:vertical-lr}', 'a{--m--webkit-writing-mode:vertical-lr}'],
      ['a{-epub-writing-mode:vertical-rl}', 'a{--m--epub-writing-mode:vertical-rl}'],
      ['a{-EPUB-Writing-Mode:vertical-rl}', 'a{--m--epub-writing-mode:vertical-rl}'],
      [
        'a{-moz-writing-mode:vertical-rl;x-writing-mode:y}',
        'a{--m--moz-writing-mode:vertical-rl;--m-x-writing-mode:y}',
      ],
      ['a{\\2d epub-writing-mode:vertical-rl}', 'a{--m--epub-writing-mode:vertical-rl}'],
      ['a{WRITING-MODE : vertical-rl !important}', 'a{--m-writing-mode : vertical-rl !important}'],
      ['a{writing\\2d mode:vertical-rl}', 'a{--m-writing-mode:vertical-rl}'],
      ['a{writing-mode/**/:vertical-rl}', 'a{--m-writing-mode/**/:vertical-rl}'],
      ['html{writing-mode:horizontal-tb}', 'html{--m-writing-mode:horizontal-tb}'],
    ];
    for (const [input, expected] of cases) assert.equal(clean(input).css, expected, input);
    const same = [
      'a{transition-property:writing-mode}',
      'a{writing-mode}',
      'a{will-change:writing-mode,height}',
      'a{b:writing-mode}',
      'a{--writing-mode:vertical-rl}',
      'a{text-orientation:upright;text-combine-upright:all}',
    ];
    for (const input of same) assert.equal(clean(input).css, input, input);
  });

  it('rewrites a style attribute too', () => {
    const images = new ImageBook({ cids: [], policy: 'block' });
    assert.equal(
      sanitizeCss('writing-mode:vertical-rl;color:red', images),
      '--m-writing-mode:vertical-rl;color:red',
    );
  });
});

describe('@layer prelude ends', () => {
  it('ends a prelude at a closing brace too, so the next rule is not renamed', () => {
    assert.equal(clean('@media x{@layer a} .foo{b:c}').css, '@media x{@layer m-a} .foo{b:c}');
    assert.equal(clean('@media x{@layer a.b}.foo{b:c}').css, '@media x{@layer m-a.m-b}.foo{b:c}');
  });
});

describe('functions and properties that follow the frame', () => {
  it('drops if(), scroll() and view() wherever they stand, so the declaration is ignored', () => {
    const cases: [string, string][] = [
      ['a{height:if(media(max-height:300px):532px;else:132px)}', 'a{height:""}'],
      ['a{height:IF(media(orientation:landscape):1px;else:2px)}', 'a{height:""}'],
      ['a{height:\\69 f(media(height > 3px):1px;else:2px)}', 'a{height:""}'],
      [
        'a{padding:calc(1px + if(media(min-aspect-ratio:1/1):9px;else:0px))}',
        'a{padding:calc(1px + "")}',
      ],
      ['a{margin:var(--x,if(media(max-height:1px):1px;else:2px))}', 'a{margin:var(--x,"")}'],
      ['a{animation-timeline:scroll(root)}', 'a{--m-animation-timeline:""}'],
      ['a{b:view(block 10px 20px)}', 'a{b:""}'],
      ['a{b:if(supports(display:grid):1px;else:2px)}', 'a{b:""}'],
    ];
    for (const [input, expected] of cases) assert.equal(clean(input).css, expected, input);
    // A word that is not a function call is left alone.
    for (const input of [
      'a{b:if}',
      'a{b:scroll;view:1}',
      'a{scroll-behavior:smooth;overflow:scroll}',
    ]) {
      assert.equal(clean(input).css, input, input);
    }
  });

  it('turns the scroll-driven animation properties into custom properties', () => {
    const cases: [string, string][] = [
      ['a{animation-timeline:view()}', 'a{--m-animation-timeline:""}'],
      ['a{animation-range:entry 10% exit 90%}', 'a{--m-animation-range:entry 10% exit 90%}'],
      [
        'a{animation-range-start:10%;animation-range-end:90%}',
        'a{--m-animation-range-start:10%;--m-animation-range-end:90%}',
      ],
      [
        'a{scroll-timeline-name:--t;scroll-timeline-axis:y;scroll-timeline:--t y}',
        'a{--m-scroll-timeline-name:--t;--m-scroll-timeline-axis:y;--m-scroll-timeline:--t y}',
      ],
      [
        'a{view-timeline:--v;view-timeline-inset:1px;view-timeline-name:--v}',
        'a{--m-view-timeline:--v;--m-view-timeline-inset:1px;--m-view-timeline-name:--v}',
      ],
      ['a{timeline-scope:--t}', 'a{--m-timeline-scope:--t}'],
      ['a{-webkit-animation-timeline:x}', 'a{--m--webkit-animation-timeline:x}'],
      ['a{ANIMATION-TIMELINE :x}', 'a{--m-animation-timeline :x}'],
    ];
    for (const [input, expected] of cases) assert.equal(clean(input).css, expected, input);
    // Ordinary animations and transitions are untouched.
    const same = [
      'a{animation:spin 1s linear infinite;animation-name:x;animation-delay:1s}',
      'a{transition:height 1s}',
    ];
    for (const input of same) assert.equal(clean(input).css, input, input);
  });

  it('renames the logical and aspect features in container and media queries', () => {
    const cases: [string, string][] = [
      ['@container (min-block-size:5px){a{b:c}}', '@container (--m-min-block-size:5px){a{b:c}}'],
      ['@container (max-block-size:5px){a{b:c}}', '@container (--m-max-block-size:5px){a{b:c}}'],
      ['@media (max-aspect-ratio:1/1){a{b:c}}', '@media (--m-max-aspect-ratio:1/1){a{b:c}}'],
      ['@media (min-aspect-ratio:1/1){a{b:c}}', '@media (--m-min-aspect-ratio:1/1){a{b:c}}'],
    ];
    for (const [input, expected] of cases) assert.equal(clean(input).css, expected, input);
  });
});
