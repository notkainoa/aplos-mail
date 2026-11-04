import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cssIdent, readDeclarations, sanitizeCss } from '../src/css';
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

describe('viewport units that follow the frame’s height become fixed lengths', () => {
  // Each unit, written as the tokenizer can produce it, in each placement it can take.
  const units: [string, string][] = [
    ['100vh', '800px'],
    ['100dvh', '800px'],
    ['100svh', '800px'],
    ['100lvh', '800px'],
    ['100vb', '800px'],
    ['100dvb', '800px'],
    ['100svb', '800px'],
    ['100lvb', '800px'],
    ['100cqh', '800px'],
    ['100cqb', '800px'],
    ['150VH', '1200px'],
    ['1.5Dvh', '12px'],
    ['-50vh', '-400px'],
    ['+50vh', '400px'],
    ['.5vh', '4px'],
    ['-.25svh', '-2px'],
    ['1e2vh', '800px'],
    ['1E2vh', '800px'],
    ['1e+2lvh', '800px'],
    ['5e-1vh', '4px'],
    ['33.3vh', '266.4px'],
    ['0vh', '0px'],
    ['1e30vh', '8e+30px'],
    ['10v\\68 ', '80px'],
    ['10\\76 h', '80px'],
    ['10vmin', 'calc(10*min(1vw,8px))'],
    ['10VMIN', 'calc(10*min(1vw,8px))'],
    ['-10vmin', 'calc(-10*min(1vw,8px))'],
    ['10dvmin', 'calc(10*min(1dvw,8px))'],
    ['10svmin', 'calc(10*min(1svw,8px))'],
    ['10lvmin', 'calc(10*min(1lvw,8px))'],
    ['10cqmin', 'calc(10*min(1cqi,8px))'],
    ['2.5vmax', 'calc(2.5*max(1vw,8px))'],
    ['10dvmax', 'calc(10*max(1dvw,8px))'],
    ['10svmax', 'calc(10*max(1svw,8px))'],
    ['10lvmax', 'calc(10*max(1lvw,8px))'],
    ['10cqmax', 'calc(10*max(1cqi,8px))'],
  ];
  const placements: [string, (value: string) => string][] = [
    ['a style block', value => `div{height:${value}}`],
    ['a style attribute', value => `min-height:${value}`],
    ['calc()', value => `div{height:calc(${value} - 10px)}`],
    ['min()', value => `div{height:min(${value},2px)}`],
    ['max()', value => `div{height:max(2px,${value})}`],
    ['clamp()', value => `div{height:clamp(1px,${value},3px)}`],
    ['a nested function', value => `div{height:calc(1px + min(${value}, max(2px, 3px)))}`],
    ['a custom property', value => `div{--h:${value}}`],
    ['@media', value => `@media (min-height:${value}){p{height:${value}}}`],
    ['@keyframes', value => `@keyframes k{to{height:${value}}}`],
    ['a shorthand', value => `div{margin:${value} 0 ${value}}`],
  ];

  for (const [placement, place] of placements) {
    it(`rewrites every height-axis unit in ${placement}`, () => {
      for (const [input, fixed] of units) {
        const out = clean(place(input)).css;
        assert.equal(out, place(fixed), `${input} in ${placement}`);
      }
    });
  }

  it('leaves width units, other units and non-dimensions alone', () => {
    const kept = [
      // The escape takes the space after it, so the unit here is `vh-`, as the browser reads it too.
      'div{height:calc(10v\\68 - 10px)}',
      'div{width:100vw;inline-size:50vi;height:10px;font-size:2em;line-height:1.5}',
      'div{width:100dvw;width:10svw;width:1lvw;width:3cqw;width:3cqi;height:50%;height:2rem}',
      'div{height:10vhx;height:10v;height:10hv;height:10vm}',
      'p:nth-child(2n+1){x:1}',
    ];
    for (const css of kept) assert.equal(clean(css).css, css);
  });

  it('never rewrites inside strings, comments or URLs', () => {
    assert.equal(clean('a{content:"100vh"}').css, 'a{content:"100vh"}');
    assert.equal(clean('a{height:/* 100vh */1px}').css, 'a{height:/**/1px}');
    assert.equal(
      clean('a{background:url(cid:100vh)}', 'block', ['100vh']).css,
      'a{background:url("cid/0")}',
    );
  });

  it('drops a number that would not be finite once fixed', () => {
    assert.equal(clean('a{height:1e400vh}').css, 'a{height: none }');
    assert.equal(clean('a{height:1e308vh}').css, 'a{height: none }');
    assert.equal(clean('a{height:1e400vw}').css, 'a{height:1e400vw}');
  });

  it('is idempotent on what it rewrote', () => {
    for (const css of ['a{height:100vh;width:10vmin}', 'b{height:calc(1px + -2.5VMAX)}']) {
      const once = clean(css).css;
      assert.equal(clean(once).css, once, css);
    }
  });
});

describe('no mail declaration can outrank the frame’s measuring rules', () => {
  it('moves every mail layer name to m-<name>, so no mail rule joins the frame’s own layer', () => {
    const cases: [string, string][] = [
      ['@layer aplos{html{height:1px!important}}', '@layer m-aplos{html{height:1px!important}}'],
      ['@layer aplos, b;', '@layer m-aplos, m-b;'],
      ['@layer a.b{x{y:z}}', '@layer m-a.m-b{x{y:z}}'],
      ['@LAYER \\61 plos{x{y:z}}', '@LAYER m-aplos{x{y:z}}'],
      ['@layer /**/aplos{x{y:z}}', '@layer /**/m-aplos{x{y:z}}'],
      ['@layer m-aplos{x{y:z}}', '@layer m-aplos{x{y:z}}'],
      ['@media print{@layer aplos{x{y:z}}}', '@media print{@layer m-aplos{x{y:z}}}'],
      ['@layer{html{height:1px!important}}', '@layer{html{height:1px!important}}'],
      ['@layer a;aplos{b:c}', '@layer m-a;aplos{b:c}'],
      ['@layer a{aplos{b:c}}', '@layer m-a{aplos{b:c}}'],
    ];
    for (const [css, out] of cases) assert.equal(clean(css).css, out, css);
  });

  it('keeps !important in mail stylesheets and style attributes (responsive mail relies on it)', () => {
    const kept = [
      '@media (max-width:600px){.col{width:100%!important}}',
      'html{height:100% !important}',
      'width:100px !important',
    ];
    for (const css of kept) assert.equal(clean(css).css, css);
  });

  it('drops every ! and the important after it when asked (the frame’s <body> style)', () => {
    const cases: [string, string][] = [
      ['height:100%!important', 'height:100%/**/'],
      ['height:100% !important', 'height:100% /**/'],
      ['height:100% ! IMPORTANT', 'height:100% /**/'],
      ['height:100% !/**/important', 'height:100% /**/'],
      ['height:100% !\\69mportant', 'height:100% /**/'],
      ['height:100% !ie', 'height:100% /**/ie'],
      ['b:c!d!important', 'b:c/**/d/**/'],
      ['content:"!important"', 'content:"!important"'],
      ['height:100vh !important', 'height:800px /**/'],
    ];
    const book = new ImageBook({ cids: [], policy: 'block' });
    for (const [css, out] of cases)
      assert.equal(sanitizeCss(css, book, undefined, { dropImportance: true }), out, css);
    const declarations = readDeclarations(
      sanitizeCss('color: red !important; width: 2px', book, undefined, { dropImportance: true }),
    );
    assert.equal(declarations.get('color'), 'red', 'the declaration itself stays');
    assert.equal(declarations.get('width'), '2px');
  });
});
