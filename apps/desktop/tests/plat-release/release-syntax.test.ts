import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import {
  bannerOptions,
  isReleaseBundle,
  RELEASE_BANNER,
  releaseBuild,
  syntaxOptions,
} from '../../scripts/build-options.mjs';

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
    ...bannerOptions(env),
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

test('every bundle build in build-main.mjs spreads the release syntax options', () => {
  const source = readFileSync(new URL('../../scripts/build-main.mjs', import.meta.url), 'utf8');
  const builds = source.match(/\bbuild\(\{/g) ?? [];
  const spreads = source.match(/\.\.\.syntaxOptions\(process\.env\)/g) ?? [];
  assert.equal(builds.length, 3, 'electron, engine and preload bundles');
  assert.equal(
    spreads.length,
    builds.length,
    'a bundle build is missing ...syntaxOptions(process.env)',
  );
  const banners = source.match(/\.\.\.bannerOptions\(process\.env\)/g) ?? [];
  assert.equal(
    banners.length,
    builds.length,
    'a bundle build is missing ...bannerOptions(process.env)',
  );
});

// release-build.mjs used to accept a bundle only if it contained the text `var releaseBuild = true;`. Syntax
// minification inlines that constant, so the check would have refused every real release bundle (and npm run
// release:build would have stopped before packaging). It now looks for the banner build-main.mjs adds to a release
// build. This builds src/main/security.ts (which declares releaseBuild through oauth-config) the way build-main does.
test('release-build recognises a syntax-minified release bundle and refuses a dev bundle', async () => {
  const entry = new URL('../../src/main/security.ts', import.meta.url).pathname;
  const bundleSecurity = async (env: Record<string, string>, release: boolean): Promise<string> => {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      logLevel: 'silent',
      external: ['electron'],
      define: {
        __APLOS_RELEASE_BUILD__: JSON.stringify(release),
        __APLOS_TEST_MODE__: JSON.stringify(!release),
      },
      ...syntaxOptions(env),
      ...bannerOptions(env),
    });
    return result.outputFiles?.[0]?.text ?? '';
  };
  const release = await bundleSecurity({ APLOS_RELEASE_BUILD: '1' }, true);
  assert.equal(isReleaseBundle(release), true);
  assert.ok(release.startsWith(RELEASE_BANNER));
  // The regression this guards: the old text check does not match a syntax-minified release bundle.
  assert.doesNotMatch(release, /\bvar releaseBuild = true;/);
  assert.equal(isReleaseBundle(await bundleSecurity({}, false)), false);
  assert.equal(isReleaseBundle(''), false);
  assert.equal(isReleaseBundle(undefined), false);
});
