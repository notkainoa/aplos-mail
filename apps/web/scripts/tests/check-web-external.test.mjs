import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeDir, run } from './helpers.mjs';

const page = body =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
const check = (files, extra = []) => {
  const dist = makeDir(files);
  return run('check-web-external.mjs', [dist, '--static-only', ...extra]);
};

test('a clean site passes, including same-origin absolute and data: images', () => {
  const r = check({
    'index.html': page(
      `<script type="module" src="./assets/a.js"></script>
       <link rel="stylesheet" href="./assets/a.css">
       <link rel="icon" href="data:image/png;base64,AAAA">
       <meta property="og:image" content="https://aplos.email/og.png">
       <img src="./icon.webp" srcset="./icon.webp 1x, ./icon@2x.webp 2x">`,
    ),
    'assets/a.js': 'fetch("/api/x"); const u = "https://react.dev/errors/1";',
    'assets/a.css': '@font-face{src:url(data:font/woff2;base64,AAAA)} a{background:url(./x.png)}',
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS: every resource reference/);
});

test('a script src on another host fails', () => {
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
    'index.html': page('<a href="https://example.org/docs">Docs</a><a href="mailto:a@b.c">m</a>'),
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Outbound <a href> links \(navigation, allowed\): 1/);
  assert.match(r.out, /https:\/\/example\.org\/docs/);
});

test('a CSS url(https://...) fails, also in @import and inline styles', () => {
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
  for (const code of [
    "fetch('https://x.test/api')",
    'fetch(`https://x.test/api`)',
    "navigator.sendBeacon('https://x.test/b', d)",
    "new WebSocket('wss://x.test/s')",
    "new Worker('https://x.test/w.js')",
    "const r = new XMLHttpRequest(); r.open('GET', 'https://x.test/y')",
    "import('https://x.test/m.js')",
    "img.src = 'https://x.test/p.png'",
    'import x from"https://x.test/m.js"',
  ]) {
    const r = check({ 'index.html': page(''), 'assets/a.js': code });
    assert.equal(r.code, 1, `${code}\n${r.out}`);
    assert.match(r.out, /FAIL .*x\.test/, code);
  }
});

test('relative and same-origin requests in JS pass; a URL that is only text is info, not a failure', () => {
  const r = check({
    'index.html': page(''),
    'assets/a.js':
      "fetch('./data.json'); fetch('https://aplos.email/x'); const ns = 'http://www.w3.org/2000/svg'; img.src = 'data:image/png;base64,AA';",
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /www\.w3\.org/);
});

test('inline scripts in HTML are scanned too', () => {
  const r = check({ 'index.html': page("<script>fetch('https://x.test/i')</script>") });
  assert.equal(r.code, 1);
  assert.match(r.out, /index\.html:1 js fetch\(\)/);
});

test('a missing dist directory fails', () => {
  const r = run('check-web-external.mjs', ['/nonexistent-dist-dir', '--static-only']);
  assert.equal(r.code, 1);
});

// The dynamic pass needs Playwright and a browser; without them this test is skipped, not passed.
const probe = run('check-web-external.mjs', [makeDir({ 'index.html': page('hi') })]);
const hasBrowser = !/SKIPPED/.test(probe.out);
test(
  'dynamic pass: requests to another host fail, local-only pages pass',
  { skip: !hasBrowser && 'playwright/browser not available' },
  () => {
    assert.equal(probe.code, 0, probe.out);
    assert.match(probe.out, /PASS \//);
    // .invalid never resolves, so the request fails; the checker must still report it.
    const bad = run('check-web-external.mjs', [
      makeDir({
        'index.html': page(`<script>fetch('http://blocked.invalid/x').catch(() => {})</script>`),
      }),
    ]);
    assert.equal(bad.code, 1, bad.out);
    assert.match(bad.out, /blocked\.invalid/);
  },
);
