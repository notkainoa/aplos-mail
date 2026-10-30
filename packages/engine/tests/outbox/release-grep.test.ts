import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build, type Plugin } from 'esbuild';
import { KILL_POINTS } from '../../src/outbox/killpoints';
import { KILL_ENV } from './killpoint-harness';

/**
 * The release bundle must not contain the kill points (time-6). The strings that identify them are the point names
 * (`KILL_POINTS`) and the environment variable a test child reads (`KILL_ENV`). The mechanism (see `killpoints.ts`): the
 * call sites test `__APLOS_TEST_MODE__` inline, which `apps/desktop/scripts/build-main.mjs` defines `false` for a release
 * build, and esbuild then drops every declaration that only the dead call sites used, minified or not. These tests build
 * the engine entries with that config and grep; a positive control per bundle (the same entry without the define)
 * proves the grep can see the strings, so it is not vacuous.
 */

const root = join(import.meta.dirname, '..', '..', '..', '..');
const ENGINE = join(root, 'packages', 'engine', 'src', 'index.ts');
const ENGINE_PROCESS = join(root, 'apps', 'desktop', 'src', 'main', 'engine-process.ts');
const CHILD = join(import.meta.dirname, 'killpoint-child.ts');

/** `build-main.mjs`: workspace packages are bundled, every third-party package stays external. */
const thirdPartyExternal: Plugin = {
  name: 'third-party-external',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, args =>
      args.path.startsWith('@aplos/') ? undefined : { path: args.path, external: true },
    );
  },
};

type Mode = 'release' | 'test';

async function bundle(entry: string, mode: Mode, minify: boolean): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    plugins: [thirdPartyExternal],
    logLevel: 'silent',
    minify,
    // Release: what build-main.mjs sets with APLOS_RELEASE_BUILD=1. Test: a dev build (true) is the same as no define.
    define: { __APLOS_TEST_MODE__: JSON.stringify(mode === 'test') },
  });
  return result.outputFiles[0].text;
}

const secrets = [...KILL_POINTS, KILL_ENV];

function present(code: string): string[] {
  return secrets.filter(s => code.includes(s));
}

for (const [name, entry] of [
  ['the engine', ENGINE],
  ["the desktop app's engine process", ENGINE_PROCESS],
] as const)
  for (const minify of [false, true])
    test(`${name} bundled for release has no kill point (minify ${minify})`, async t => {
      const testBuild = await bundle(entry, 'test', minify);
      const reached = KILL_POINTS.filter(p => testBuild.includes(p));
      // The desktop engine process still bundles today's engine. Once it bundles the new one, this stops skipping.
      if (!reached.length) return t.skip(`${name} does not contain the outbox yet`);
      assert.deepEqual(
        reached,
        [...KILL_POINTS],
        'positive control: the test build has every name',
      );
      const release = await bundle(entry, 'release', minify);
      assert.ok(release.length > 100_000, 'a real bundle, not an empty one');
      assert.deepEqual(present(release), [], 'no kill-point name and no environment variable');
    });

test('the release define is the one build-main.mjs sets', () => {
  const source = readFileSync(join(root, 'apps', 'desktop', 'scripts', 'build-main.mjs'), 'utf8');
  assert.match(
    source,
    /__APLOS_TEST_MODE__: JSON\.stringify\(process\.env\.APLOS_RELEASE_BUILD !== '1'\)/,
    'the kill points are compiled out by this define; if it changes, change bundle() here and killpoints.ts',
  );
});

test('the test child holds the environment variable and every name (positive control for the grep)', async () => {
  const child = await bundle(CHILD, 'test', false);
  assert.deepEqual(
    secrets.filter(s => !child.includes(s)),
    [],
  );
});

test('the kill-point names are what the grep looks for: distinct and not words the bundle uses anyway', () => {
  assert.equal(new Set(KILL_POINTS).size, KILL_POINTS.length);
  assert.ok(KILL_POINTS.length >= 4);
  for (const p of KILL_POINTS) assert.match(p, /^(before|after|during)-[a-z-]+$/);
});
