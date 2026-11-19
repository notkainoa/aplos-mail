import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { cspMeta, inlineScripts, productionHtml, rendererCsp } from '../../vite.config';

const desktop = fileURLToPath(new URL('../../', import.meta.url));

function parse(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    // Browsers obey the first copy of a repeated directive; a map would keep the last.
    assert.ok(!directives.has(name.toLowerCase()), `directive ${name} appears once`);
    directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

// The whole production policy. Any added directive or source fails here and has to be argued.
const production = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  // React writes style attributes, so style-src keeps 'unsafe-inline' (see vite.config.ts).
  'style-src': ["'self'", "'unsafe-inline'"],
  // https: stays until stage 2 moves mail into its own frame.
  'img-src': ["'self'", 'data:', 'blob:', 'https:'],
  'media-src': ["'self'", 'blob:'],
  'connect-src': ["'self'"],
  'font-src': ["'self'", 'data:'],
  // Only the app's own sealed mail scheme may be framed (ARCH 9.3).
  'frame-src': ['aplos-mail:'],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
};

/**
 * Directives that decide what script runs, including the CSP3 ones that override script-src for
 * script elements, event-handler attributes, workers and frames. Each may only say 'self' or
 * 'none': this guards the reason for the exact map above, in case that map is edited carelessly.
 */
const scriptDirectives = [
  'default-src',
  'script-src',
  'script-src-elem',
  'script-src-attr',
  'worker-src',
  'child-src',
  'frame-src',
  'object-src',
];
function scriptLoosening(policy: string): string[] {
  return [...parse(policy)]
    .filter(([name]) => scriptDirectives.includes(name))
    .filter(
      ([name, sources]) =>
        !(sources.length === 1 && ["'self'", "'none'"].includes(sources[0])) &&
        // The one extra source: the app's own sealed mail scheme, as a frame source only.
        !(name === 'frame-src' && sources.length === 1 && sources[0] === 'aplos-mail:'),
    )
    .map(([name, sources]) => `${name} ${sources.join(' ')}`);
}

/** Independent of cspMeta in vite.config.ts: where the live meta sits in the built HTML. */
function assertMetaGovernsPage(html: string): string {
  assert.equal(html.match(/content-security-policy/gi)?.length, 1, 'exactly one CSP mention');
  assert.ok(!html.includes('<!--'), 'the built HTML has no comments');
  const match = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  assert.ok(match, 'the HTML carries a CSP meta tag');
  const at = match.index;
  assert.ok(
    html.indexOf('<head>') >= 0 && html.indexOf('<head>') < at,
    'the meta is inside <head>',
  );
  for (const later of ['<script', '<link', '<style', '<base', '<title', '</head>', '<body'])
    assert.ok(html.indexOf(later) === -1 || html.indexOf(later) > at, `the meta precedes ${later}`);
  return match[1];
}

test('the production renderer build ships a CSP without dev origins or inline script', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aplos-csp-'));
  try {
    await build({
      configFile: join(desktop, 'vite.config.ts'),
      root: desktop,
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    });
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    const policy = assertMetaGovernsPage(html);

    assert.doesNotMatch(policy, /localhost|127\.0\.0\.1|\[::1\]|:5173|:4317/);
    assert.deepEqual(Object.fromEntries(parse(policy)), production);
    assert.deepEqual(scriptLoosening(policy), []);
    // A <meta> CSP cannot carry frame-ancestors (browsers ignore it there), so the build must not
    // pretend to set it; stage 2 sends it as a header from aplos-app://.
    assert.equal(parse(policy).has('frame-ancestors'), false);

    assert.deepEqual(inlineScripts(html), []);
    assert.match(html, /<script type="module" crossorigin src="\.\/assets\/[^"]+\.js"><\/script>/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('rendererCsp("production") is the pinned policy', () => {
  assert.deepEqual(Object.fromEntries(parse(rendererCsp('production'))), production);
});

test('the script-directive guard catches CSP3 overrides that re-allow inline or remote script', () => {
  const loosened = [
    "default-src 'self'",
    "script-src 'self'",
    "script-src-elem 'self' 'unsafe-inline' https:",
    "script-src-attr 'unsafe-inline' 'unsafe-hashes'",
    'worker-src blob: data: https:',
    'frame-src https: data:',
  ].join('; ');
  assert.equal(scriptLoosening(loosened).length, 4);
  assert.equal(scriptLoosening("script-src 'self' 'nonce-x'").length, 1);
  assert.equal(scriptLoosening('frame-src aplos-mail:').length, 0);
  assert.equal(scriptLoosening('script-src aplos-mail:').length, 1);
  assert.equal(scriptLoosening('frame-src aplos-mail: https:').length, 1);
});

test('the dev policy allows the preview its own ports', () => {
  const csp = parse(rendererCsp({ vitePort: 4721, apiPort: 4722 }));
  assert.deepEqual(csp.get('connect-src'), [
    "'self'",
    'http://127.0.0.1:4721',
    'ws://127.0.0.1:4721',
    'http://127.0.0.1:4722',
  ]);
  assert.deepEqual(csp.get('script-src'), ["'self'", "'unsafe-inline'"]);
});

test('inline script detection ignores external scripts', () => {
  assert.deepEqual(inlineScripts('<script type="module" src="./a.js"></script>'), []);
  assert.equal(
    inlineScripts('<script>alert(1)</script><SCRIPT type="module">x()</SCRIPT>').length,
    2,
  );
});

test('the production step refuses a CSP meta the browser would not obey, or a decoy copy', () => {
  const meta = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">';
  const page = (head: string, body = '') =>
    `<!doctype html><html lang="en"><head>${head}</head><body><div id="root"></div>${body}</body></html>`;
  const good = page(`<meta charset="UTF-8">${meta}<title>Aplos Mail</title>`);
  assert.equal(cspMeta(good).policy, "default-src 'self'");
  assert.match(productionHtml(good), /content="default-src 'self'; script-src 'self';/);

  const refused = {
    'meta moved into <body>': page('<meta charset="UTF-8"><title>Aplos Mail</title>', meta),
    'commented-out copy before the real one': page(
      `<meta charset="UTF-8"><!-- <meta http-equiv="Content-Security-Policy" content="old"> -->${meta}`,
    ),
    'the real meta commented out': page(`<meta charset="UTF-8"><!-- ${meta} -->`),
    'an unterminated comment': page(`<meta charset="UTF-8">${meta}<!-- Content-Security-Policy`),
    'two metas': page(`${meta}${meta}`),
    'no meta': page('<meta charset="UTF-8"><title>Aplos Mail</title>'),
    'meta after a stylesheet': page(`<link rel="stylesheet" href="./a.css">${meta}`),
    'meta after a script': page(`<script type="module" src="./a.js"></script>${meta}`),
    'meta inside <noscript>': page(`<noscript>${meta}</noscript>`),
    'meta inside <template>': page(`<template>${meta}</template>`),
    'meta in another form': page(
      `<meta content="default-src 'self'" http-equiv="Content-Security-Policy">`,
    ),
    'an inline script': page(`${meta}<script>alert(1)</script>`),
  };
  for (const [name, html] of Object.entries(refused))
    assert.throws(() => productionHtml(html), Error, name);
});
