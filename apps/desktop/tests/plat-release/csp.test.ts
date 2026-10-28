import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { inlineScripts, rendererCsp } from '../../vite.config';

const desktop = fileURLToPath(new URL('../../', import.meta.url));

function parse(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name.toLowerCase(), sources);
  }
  return directives;
}
function metaCsp(html: string): string {
  const match = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/i.exec(html);
  assert.ok(match, 'the HTML carries a CSP meta tag');
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
    const policy = metaCsp(html);
    const csp = parse(policy);

    assert.doesNotMatch(policy, /localhost|127\.0\.0\.1|\[::1\]|:5173|:4317/);
    assert.deepEqual(csp.get('script-src'), ["'self'"]);
    assert.deepEqual(csp.get('object-src'), ["'none'"]);
    assert.deepEqual(csp.get('base-uri'), ["'none'"]);
    assert.deepEqual(csp.get('connect-src'), ["'self'"]);
    // React writes style attributes, so style-src keeps 'unsafe-inline' (see vite.config.ts).
    assert.deepEqual(csp.get('style-src'), ["'self'", "'unsafe-inline'"]);
    for (const sources of csp.values()) {
      assert.ok(!sources.includes("'unsafe-eval'"), 'no directive allows eval');
      assert.ok(!sources.includes('*'), 'no directive allows any origin');
    }
    // A <meta> CSP cannot carry frame-ancestors (browsers ignore it there), so the build must not
    // pretend to set it; stage 2 sends it as a header from aplos-app://.
    assert.equal(csp.has('frame-ancestors'), false);

    assert.deepEqual(inlineScripts(html), []);
    assert.match(html, /<script type="module" crossorigin src="\.\/assets\/[^"]+\.js"><\/script>/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
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
