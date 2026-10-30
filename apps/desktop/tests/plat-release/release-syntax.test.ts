import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { releaseBuild, syntaxOptions } from '../../scripts/build-options.mjs';

// A release build defines __APLOS_TEST_MODE__ false (build-main.mjs). The test-only call sites then become
// `if (false) ...`; only syntax minification removes that dead text, and the release options must turn it on
// (DECISIONS.md, 2026-10-31). The fixture mirrors how the outbox kill points are written.
const fixture = `
  declare const __APLOS_TEST_MODE__: boolean | undefined;
  function killpointCanary(name: string) { console.log('kill at ' + name); }
  export function send(): string {
    if (typeof __APLOS_TEST_MODE__ === 'undefined' || __APLOS_TEST_MODE__) killpointCanary('before-marker');
    return 'sent';
  }
`;

async function bundle(env: Record<string, string>, testMode: boolean): Promise<string> {
  const result = await build({
    stdin: { contents: fixture, loader: 'ts', resolveDir: process.cwd() },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
    define: { __APLOS_TEST_MODE__: JSON.stringify(testMode) },
    ...syntaxOptions(env),
  });
  return result.outputFiles?.[0]?.text ?? '';
}

test('release options minify syntax only; every other build leaves them off', () => {
  assert.equal(releaseBuild({ APLOS_RELEASE_BUILD: '1' }), true);
  assert.deepEqual(syntaxOptions({ APLOS_RELEASE_BUILD: '1' }), { minifySyntax: true });
  assert.deepEqual(syntaxOptions({}), {});
  assert.deepEqual(syntaxOptions({ APLOS_RELEASE_BUILD: '0' }), {});
});

test('a release bundle carries no trace of a test-only call site, a dev bundle keeps it', async () => {
  const release = await bundle({ APLOS_RELEASE_BUILD: '1' }, false);
  assert.doesNotMatch(
    release,
    /killpointCanary|before-marker|kill at/,
    'dead test-only text left in release',
  );
  const unminifiedRelease = await bundle({}, false);
  assert.match(
    unminifiedRelease,
    /killpointCanary/,
    'positive control: without syntax minify the dead text stays',
  );
  const dev = await bundle({}, true);
  assert.match(dev, /killpointCanary/);
  assert.match(dev, /before-marker/);
});
