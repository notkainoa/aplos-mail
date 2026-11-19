import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build, type Plugin } from 'esbuild';
import { UNCERTAIN_COPY } from '../../src/outbox/context';
import { KILL_POINTS } from '../../src/outbox/killpoints';
import { KILL_ENV } from './killpoint-harness';
import { syntaxOptions } from '../../../../apps/desktop/scripts/build-options.mjs';

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

/**
 * `build-main.mjs`'s define, as that file computes it: the expression is read from the script and evaluated with and
 * without `APLOS_RELEASE_BUILD=1`, so this test cannot drift from what ships.
 */
function buildMainDefine(release: boolean): string {
  const source = readFileSync(join(root, 'apps', 'desktop', 'scripts', 'build-main.mjs'), 'utf8');
  const expr =
    /__APLOS_TEST_MODE__: (JSON\.stringify\(process\.env\.APLOS_RELEASE_BUILD !== '1'\))/.exec(
      source,
    )?.[1];
  if (!expr) throw new Error('build-main.mjs no longer defines __APLOS_TEST_MODE__ this way');
  const env = release ? { APLOS_RELEASE_BUILD: '1' } : {};
  return new Function('process', `return ${expr}`)({ env }) as string;
}

/**
 * `release`: the define build-main.mjs sets for a release build (false). `test`: a dev build (true). `none`: NO define,
 * which is how an unbundled run behaves and how any new bundle of the engine behaves until its author adds the define:
 * the `typeof __APLOS_TEST_MODE__ === 'undefined'` guard in the call sites then defaults to ON, so every kill point and
 * its name stays in the output. Every bundle the engine ships in must define it (see `killpoints.ts`).
 */
type Mode = 'release' | 'test' | 'none';

/** Every bundle built here and the define it got (`undefined`: none), so a test can assert it. */
const built: { entry: string; mode: Mode; define: string | undefined }[] = [];

/**
 * How the bundle is shaped. `plain`: no minification (a dev build keeps the folded dead text of a call site).
 * `release`: exactly what a release build adds, `syntaxOptions` of `build-options.mjs` (the file build-main.mjs spreads
 * into its build()): syntax minification folds the dead branches away and drops what only they used. `full`: whole
 * minification, the strictest.
 */
type Shape = 'plain' | 'release' | 'full';

const shapeOptions = (shape: Shape): Record<string, unknown> =>
  shape === 'plain'
    ? {}
    : shape === 'full'
      ? { minify: true }
      : (syntaxOptions({ APLOS_RELEASE_BUILD: '1' }) as Record<string, unknown>);

async function bundle(entry: string, mode: Mode, shape: Shape): Promise<string> {
  const define = mode === 'none' ? undefined : buildMainDefine(mode === 'release');
  built.push({ entry, mode, define });
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    plugins: [thirdPartyExternal],
    logLevel: 'silent',
    ...shapeOptions(shape),
    ...(define !== undefined ? { define: { __APLOS_TEST_MODE__: define } } : {}),
  });
  return result.outputFiles[0].text;
}

const secrets = [...KILL_POINTS, KILL_ENV];

/**
 * Identifiers of the kill-point machinery. A minified bundle must not contain them at all (they are canaries: they would
 * only survive if a declaration or a call site did). An unminified bundle keeps the dead text of a folded call site
 * (`if (false) killpoint(KP.X)`, `false ? killableSend(...)`), so there only their declarations must be gone.
 */
// The last is the text of the `from>to:why` argument built at the `during-commit` call sites: computed outside the guard
// it would survive in a release bundle.
const CANARIES = ['killableSend', 'installKillHook', 'killpoint', '.join("+")'];
const DECLARATIONS = [
  'function killableSend',
  'function installKillHook',
  'function killpoint',
  'var KP =',
  'const KP =',
  'var hook',
  'let hook',
];

/**
 * Whole declarations only: the store's `let hooks` (store/ingest.ts) is not the kill-point `let hook`. A number suffix
 * still counts (`let hook2`, `function killpoint2`): esbuild renames a declaration that way when two modules clash.
 */
function declared(code: string): string[] {
  const whole = (d: string) =>
    new RegExp(`${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d*(?![\\w$])`);
  return DECLARATIONS.filter(d => whole(d).test(code));
}

function present(code: string): string[] {
  return secrets.filter(s => code.includes(s));
}

/**
 * What is wrong with a release bundle, given the same entry built as a test build (empty: nothing). The test build is the
 * positive control: it must hold every name, or the grep proves nothing.
 */
function problems(testBuild: string, release: string, shape: Shape): string[] {
  const out: string[] = [];
  const missing = KILL_POINTS.filter(p => !testBuild.includes(p));
  if (missing.length) out.push(`positive control: the test build lacks ${missing.join(', ')}`);
  if (release.length <= 100_000) out.push('not a real bundle');
  const leaked = present(release);
  if (leaked.length)
    out.push(`kill-point names or the environment variable in the release: ${leaked.join(', ')}`);
  // What a release build ships (syntax minification) and any stricter shape: not a trace, canaries and declarations too.
  if (shape !== 'plain') {
    out.push(...CANARIES.filter(c => release.includes(c)).map(c => `identifier ${c}`));
    out.push(...declared(release).map(d => `declaration ${d}`));
  } else out.push(...declared(release).map(d => `declaration ${d}`));
  return out;
}

/**
 * Text from the outbox that no define removes: an entry whose RELEASE bundle holds it reaches the outbox, whatever the
 * test build says. The decision to skip rests on this, never on the kill-point names, so an engine process that starts
 * bundling the outbox without stripping the names is a failure, not a skip.
 */
const holdsOutbox = (code: string) => code.includes(UNCERTAIN_COPY);

for (const shape of ['plain', 'release', 'full'] as const) {
  test(`the engine (src/index.ts) bundled for release reaches the outbox and has no kill point (${shape})`, async () => {
    const testBuild = await bundle(ENGINE, 'test', shape);
    const release = await bundle(ENGINE, 'release', shape);
    // Not a skip: if the composition root stops reaching the outbox, this fails and the grep below would be vacuous.
    assert.ok(holdsOutbox(release), 'src/index.ts no longer reaches the outbox');
    assert.deepEqual(
      KILL_POINTS.filter(p => !testBuild.includes(p)),
      [],
      'the engine entry reaches the outbox, so its test build holds every kill-point name',
    );
    assert.deepEqual(problems(testBuild, release, shape), []);
  });

  test(`the desktop app's engine process bundled for release has no kill point once it holds the outbox (${shape})`, async t => {
    // TODO(plat / engine-process): turns on when apps/desktop/src/main/engine-process.ts bundles the new engine
    // (recorded in DECISIONS.md under "eng-time time-6 follow-ups"). Until then it holds no outbox and this skips.
    const release = await bundle(ENGINE_PROCESS, 'release', shape);
    const testBuild = await bundle(ENGINE_PROCESS, 'test', shape);
    if (!holdsOutbox(release) && !KILL_POINTS.some(p => testBuild.includes(p)))
      return t.skip('the engine process does not contain the outbox yet');
    // It holds the outbox (or some of the names): everything must hold, no skipping.
    assert.ok(
      holdsOutbox(release),
      'kill-point names without the outbox: the entry is half bundled',
    );
    assert.deepEqual(problems(testBuild, release, shape), []);
  });
}

test('the verdict fails, not skips, for a bundle that holds the outbox but not the strip', () => {
  const names = KILL_POINTS.join(' ');
  const pad = 'x'.repeat(120_000);
  const stripped = `${pad} ${UNCERTAIN_COPY}`;
  const leaking = `${pad} ${UNCERTAIN_COPY} ${names} ${KILL_ENV}`;
  assert.deepEqual(problems(`${stripped} ${names}`, stripped, 'release'), []);
  assert.notDeepEqual(problems(`${leaking}`, leaking, 'release'), []);
  assert.notDeepEqual(problems(`${leaking}`, leaking, 'plain'), []);
  assert.ok(holdsOutbox(leaking), 'holding the outbox is what turns the engine-process case on');
  // A test build that lacks the names makes the control fail rather than pass vacuously.
  assert.notDeepEqual(problems(stripped, stripped, 'release'), []);
});

test('a bundle built without the define keeps every kill point: a NEW bundle of the engine must define it', async () => {
  const code = await bundle(ENGINE, 'none', 'plain');
  assert.deepEqual(
    KILL_POINTS.filter(p => !code.includes(p)),
    [],
    'the typeof guard defaults to ON when the constant is undefined',
  );
});

test('positive control for the identifier greps: the test child has the declarations and the canaries', async () => {
  const unminified = await bundle(CHILD, 'test', 'plain');
  assert.ok(declared(unminified).length >= 3, 'the declaration greps can see declarations');
  assert.deepEqual(
    CANARIES.filter(c => !unminified.includes(c)),
    [],
  );
});

test('the release define is the one build-main.mjs sets', () => {
  const source = readFileSync(join(root, 'apps', 'desktop', 'scripts', 'build-main.mjs'), 'utf8');
  assert.match(
    source,
    /__APLOS_TEST_MODE__: JSON\.stringify\(process\.env\.APLOS_RELEASE_BUILD !== '1'\)/,
    'the kill points are compiled out by this define; if it changes, change buildMainDefine() here and killpoints.ts',
  );
  assert.equal(buildMainDefine(true), 'false', 'a release build compiles the kill points out');
  assert.equal(buildMainDefine(false), 'true', 'a dev build keeps them');
});

// Keep last among the bundling tests: it inspects every bundle built above.
test('every release bundle was built with __APLOS_TEST_MODE__ false, the way build-main.mjs does', () => {
  const releases = built.filter(b => b.mode === 'release');
  assert.ok(releases.length >= 4, `the release bundles were built (${releases.length})`);
  for (const b of releases) assert.equal(b.define, 'false', `${b.entry} must be a release build`);
  for (const b of built.filter(x => x.mode === 'test')) assert.equal(b.define, 'true');
});

test('the test child holds the environment variable and every name (positive control for the grep)', async () => {
  const child = await bundle(CHILD, 'test', 'plain');
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

test('a declaration counts whole or with esbuild’s number suffix, never as a longer name', () => {
  assert.deepEqual(declared('let hooks = new Set();'), []);
  assert.deepEqual(declared('let hook2;\nfunction killpoint3(name) {}'), [
    'function killpoint',
    'let hook',
  ]);
  assert.deepEqual(declared('let hook;'), ['let hook']);
});
