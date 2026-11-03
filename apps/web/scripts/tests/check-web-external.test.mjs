import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cleanup, makeDir, run, runAsync } from './helpers.mjs';

after(cleanup);

const page = body =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
const check = (files, extra = []) => {
  const dist = makeDir(files);
  return run('check-web-external.mjs', [dist, '--static-only', ...extra]);
};

/** Writes each case into its own file of one dist and checks that every case is reported. */
function everyCaseFails(cases, file, wrap = x => x) {
  const files = { 'index.html': page('') };
  cases.forEach((c, i) => (files[file(i)] = wrap(c)));
  const r = check(files);
  assert.equal(r.code, 1, r.out);
  cases.forEach((c, i) => {
    const name = file(i).split('/').pop();
    assert.ok(r.out.includes(`${name}:`), `not reported: ${c}\n${r.out}`);
  });
}

test('a clean site passes, including same-origin absolute and data: images', () => {
  const r = check({
    'index.html': page(
      `<script type="module" src="./assets/a.js"></script>
       <link rel="stylesheet" href="./assets/a.css">
       <link rel="icon" href="data:image/png;base64,AAAA">
       <link rel="canonical" href="https://aplos.email/">
       <meta property="og:image" content="https://aplos.email/og.png">
       <img src="./icon.webp" srcset="./icon.webp 1x, ./icon@2x.webp 2x">
       <img src="/ok.png" src="https://evil.test/ignored-duplicate.png">`,
    ),
    'assets/a.js':
      'fetch("/api/x"); fetch("https://aplos.email/y"); const u = "https://react.dev/errors/1"; img.src = "data:image/png;base64,AA"; const ns = "http://www.w3.org/2000/svg";',
    'assets/a.css': '@font-face{src:url(data:font/woff2;base64,AAAA)} a{background:url(./x.png)}',
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS: every resource reference/);
});

test('a script src to another host fails', () => {
  const r = check({ 'index.html': page('<script src="https://cdn.example.com/x.js"></script>') });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL .*<script src> https:\/\/cdn\.example\.com\/x\.js/);
});

test('protocol-relative and http://aplos.email references fail', () => {
  const r = check({
    'index.html': page(
      '<img src="//cdn.example.com/a.png"><link rel="stylesheet" href="http://aplos.email/a.css">',
    ),
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /cdn\.example\.com/);
  assert.match(r.out, /<link rel=stylesheet>/);
});

test('a link to another host is navigation: it passes and is listed', () => {
  const r = check({
    'index.html': page(
      '<a href="https://example.org/docs">Docs</a><a href="mailto:a@b.c">m</a><a href="/x">x</a>',
    ),
    'assets/a.js':
      'h("a",{href:"https://example.net/jsx-link",children:"x"}); location.href="https://example.com/go";',
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Outbound links \(navigation, allowed\): 3/);
  assert.match(r.out, /https:\/\/example\.org\/docs/);
  assert.match(r.out, /example\.net\/jsx-link/);
});

test('CSS url(https://...) fails, also in @import and inline styles', () => {
  const r1 = check({
    'index.html': page(''),
    'a.css': 'body{background:url("https://x.test/a.png")}',
  });
  assert.equal(r1.code, 1);
  assert.match(r1.out, /css url\(\) https:\/\/x\.test\/a\.png/);
  const r2 = check({ 'index.html': page(''), 'a.css': '@import "https://fonts.test/f.css";' });
  assert.equal(r2.code, 1);
  assert.match(r2.out, /css @import/);
  const r3 = check({
    'index.html': page('<div style="background:url(https://x.test/b.png)"></div>'),
  });
  assert.equal(r3.code, 1);
});

test('a fetch/XHR/WebSocket/import()/.src to another host in JS fails', () => {
  everyCaseFails(
    [
      "fetch('https://x.test/api')",
      'fetch(`https://x.test/api`)',
      "navigator.sendBeacon('https://x.test/b', d)",
      "new WebSocket('wss://x.test/s')",
      "new Worker('https://x.test/w.js')",
      "const r = new XMLHttpRequest(); r.open('GET', 'https://x.test/y')",
      "import('https://x.test/m.js')",
      "img.src = 'https://x.test/p.png'",
      'import x from"https://x.test/m.js"',
      "(0,fetch)('https://x.test/a')",
      "fetch('//x.test/a')",
      "window.open('https://x.test/popup')",
    ],
    i => `assets/c${i}.js`,
  );
});

test('inline scripts in HTML are scanned too', () => {
  const r = check({ 'index.html': page("<script>fetch('https://x.test/i')</script>") });
  assert.equal(r.code, 1);
  assert.match(r.out, /index\.html:1 js fetch\(\)/);
});

test('React props and JS-built elements: src, srcSet, poster, link href and srcset strings fail', () => {
  everyCaseFails(
    [
      'jsx("img",{src:"https://x.test/hero.png"})',
      'jsx("img",{srcSet:"https://x.test/hero@2x.png 2x"})',
      'jsx("source",{srcSet:"a.png 1x, https://x.test/b.png 2x",media:"(prefers-color-scheme: dark)"})',
      'jsx("video",{poster:"//x.test/p.png"})',
      'img.srcset="a.png 1x, https://x.test/b.png 2x"',
      'Object.assign(new Image(),{src:"https://x.test/x.png"})',
      'const l=document.createElement("link");l.rel="preconnect";l.href="https://x.test"',
      'h("link",{rel:"stylesheet",href:"https://x.test/c.css"})',
      'h("link",{rel:"preconnect",href:"https://x.test"})',
      'el.setAttribute("src","https://x.test/a.png")',
      'const u="https://x.test/tracker.js"',
      'const u="https://"+host+"/x"',
      'el.innerHTML=\'<img src="https://x.test/a.png">\'',
      'el.style="background:url(https://x.test/a.png)"',
    ],
    i => `assets/c${i}.js`,
  );
});

test('--allow-host lets a named host appear as plain text in JS', () => {
  const files = {
    'index.html': page(''),
    'assets/a.js': 'const docs="https://docs.example.org/x"',
  };
  assert.equal(check(files).code, 1);
  assert.equal(check(files, ['--allow-host', 'docs.example.org']).code, 0);
});

test('HTML tricks the old regexes missed: odd attribute syntax, entities, backslashes, tabs', () => {
  everyCaseFails(
    [
      '<img/src="https://x.test/a">',
      '<img alt="x"src="https://x.test/a">',
      '<link rel=stylesheet href=https://fonts.test/css2?family=Inter&display=swap>',
      '<img src=https://x.test/a.png?a=b>',
      '<img src="https://x.test/first.png" src="/ok.png">',
      '<img src="https&#58;//x.test/a">',
      '<img src="https&colon;&sol;&sol;x.test/a">',
      '<img src="https&#x3a;//x.test/a">',
      '<img src="/\\x.test/a">',
      '<img src="\\\\x.test/a">',
      '<img src="ht&#9;tps://x.test/a">',
      '<img src="ht\ttps://x.test/a">',
      '<img src="https://\nx.test/a">',
      '<div style="background:url(https&#58;//x.test/b.png)"></div>',
      '<img src="a.png" srcset="a.png 200w 100h, https://x.test/b.png 2x">',
      '<img srcset="a.png 2e0x, https://x.test/b.png 3x">',
      '<img srcset="a.png 1x,https://x.test/b.png 2x">',
      '<meta http-equiv="refresh" content="0; https://x.test/">',
      '<meta http-equiv="refresh" content="0,https://x.test/">',
      '<meta http-equiv="refresh" content="5; url=\'https://x.test/\'">',
      '<body background="https://x.test/bg.png">',
      '<link rel="preload" as="image" imagesrcset="a.png 1x, https://x.test/b.png 2x">',
      '<link rel="prerender" href="https://x.test/">',
      '<link rel="stylesheet alternate" href="https://x.test/a.css">',
      '<a href="/x" ping="https://x.test/p">x</a>',
      '<iframe srcdoc="&lt;img src=&quot;https://x.test/a&quot;&gt;"></iframe>',
      '<svg><feImage href="https://x.test/a"/></svg>',
      '<svg><image xlink:href="https://x.test/a.png"/></svg>',
      '<script type="speculationrules">{"prerender":[{"urls":["https://x.test/"]}]}</script>',
      '<script type="importmap">{"imports":{"a":"https://x.test/a.js"}}</script>',
      '<form action="https://x.test/post"></form>',
      '<meta name="twitter:image" content="https://x.test/a.png">',
      '<meta name="msapplication-TileImage" content="https://x.test/a.png">',
      '<img src="https&nosuchentity;//x.test/a">',
      '<script src="data:text/javascript,alert(1)"></script>',
    ],
    i => `c${i}.html`,
    page,
  );
});

test('CSS tricks: escapes, later image-set candidates, media queries, @import url()', () => {
  everyCaseFails(
    [
      'a{background:url(https\\:\\/\\/x.test/a.png)}',
      'a{background:url("\\68ttps://x.test/a.png")}',
      'a{background:image-set("a.png" 1x, "https://x.test/b.png" 2x)}',
      'a{background:-webkit-image-set(url(a.png) 1x, url(https://x.test/b.png) 2x)}',
      '@media (prefers-color-scheme: dark){a{background:url(https://x.test/d.png)}}',
      '@media (max-width:700px){a{background:url(//x.test/d.png)}}',
      '@import url(https://x.test/x.css);',
      '@import url("//x.test/x.css");',
    ],
    i => `c${i}.css`,
  );
});

test('manifest and JSON files are scanned', () => {
  const r = check({
    'index.html': page(''),
    'site.webmanifest': { icons: [{ src: 'https://x.test/i.png' }] },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /site\.webmanifest/);
});

test('a missing dist directory fails', () => {
  const r = run('check-web-external.mjs', ['/nonexistent-dist-dir', '--static-only']);
  assert.equal(r.code, 1);
});

test('without a browser the dynamic pass is a failure, not a pass; --static-only is the explicit opt-out', () => {
  const dist = makeDir({ 'index.html': page('hi') });
  const env = { CHECK_WEB_EXTERNAL_NO_PLAYWRIGHT: '1' };
  const r = run('check-web-external.mjs', [dist], env);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /SKIPPED \(playwright not found\) -- this is NOT a pass/);
  assert.match(r.out, /RESULT: FAIL/);
  const explicit = run('check-web-external.mjs', [dist, '--static-only'], env);
  assert.equal(explicit.code, 0, explicit.out);
  assert.match(explicit.out, /not run \(--static-only was given\)/);
});

// The dynamic pass needs Playwright and Chromium. When they are missing these tests FAIL (that is the point of
// the check). Set ALLOW_NO_BROWSER=1 to skip them on a machine that has no browser.
test('dynamic pass: every kind of request to another host fails, local-only pages pass', async t => {
  const probe = await runAsync('check-web-external.mjs', [makeDir({ 'index.html': page('hi') })]);
  if (/SKIPPED/.test(probe.out)) {
    if (process.env.ALLOW_NO_BROWSER === '1') return t.skip('playwright/browser not available');
    assert.fail(`Playwright or its browser is missing:\n${probe.out}`);
  }
  assert.equal(probe.code, 0, probe.out);
  assert.match(probe.out, /PASS \/ \[desktop light 1x\]/);
  assert.match(probe.out, /PASS \/ \[phone dark 2x\]/);

  const sub = body => page(`<script>${body}</script>`);
  const dist = makeDir({
    'index.html': page('<p>ok</p>'),
    'load/index.html': sub("fetch('http://load.invalid/x').catch(() => {})"),
    'timer10s/index.html': sub(
      "setTimeout(() => fetch('http://timer.invalid/x').catch(() => {}), 10000)",
    ),
    'popup/index.html': sub("setTimeout(() => window.open('http://popup.invalid/'), 300)"),
    'beacon/index.html': sub(
      "addEventListener('pagehide', () => navigator.sendBeacon('http://beacon.invalid/b', 'x'));" +
        "document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') navigator.sendBeacon('http://vis.invalid/b', 'x'); })",
    ),
    'mouse/index.html': sub(
      "addEventListener('mousemove', () => fetch('http://mouse.invalid/x').catch(() => {}), { once: true })",
    ),
    'retina/index.html': sub(
      "const i = new Image(); i.srcset = 'a.png 1x, http://retina.invalid/b.png 2x'; document.body.append(i)",
    ),
    'dark/index.html': page(
      '<style>@media (prefers-color-scheme: dark){body{background:url(http://dark.invalid/d.png)}}</style>',
    ),
    'phone/index.html': page(
      '<style>@media (max-width:700px){body{background:url(http://phone.invalid/p.png)}}</style>',
    ),
    'ws/index.html': sub("try { new WebSocket('ws://socket.invalid/s') } catch {}"),
    'nav/index.html': sub("setTimeout(() => { location.href = 'http://nav.invalid/' }, 200)"),
    'allowed/index.html': page(
      '<a href="https://example.org/docs">docs</a><img src="https://aplos.email/og.png">',
    ),
  });
  const r = await runAsync('check-web-external.mjs', [dist, '--dynamic-only']);
  assert.equal(r.code, 1, r.out);
  const failing = path =>
    new RegExp(
      `FAIL ${path.replace(/\//g, '\\/')} \\[[^\\]]+\\]\\n(?:    .*\\n)*?    .*\\.invalid`,
    );
  for (const [path, host] of [
    ['/load/', 'load'],
    ['/timer10s/', 'timer'],
    ['/popup/', 'popup'],
    ['/beacon/', 'beacon'],
    ['/mouse/', 'mouse'],
    ['/retina/', 'retina'],
    ['/dark/', 'dark'],
    ['/phone/', 'phone'],
    ['/ws/', 'socket'],
    ['/nav/', 'nav'],
  ]) {
    assert.match(r.out, failing(path), `${path} should fail\n${r.out}`);
    assert.ok(r.out.includes(`${host}.invalid`), `${host}.invalid not reported\n${r.out}`);
  }
  assert.match(r.out, /PASS \/allowed\/ \[desktop light 1x\]/);
  assert.match(r.out, /PASS \/ \[desktop light 1x\]/);
  assert.doesNotMatch(r.out, /FAIL \/allowed\//);
});
