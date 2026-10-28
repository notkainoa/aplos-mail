import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

// The script is plain ESM without type declarations, so load it untyped.
const vh = await import(new URL('../../scripts/verify-hardening.mjs', import.meta.url).href);

// ADR 40-6: the startup guard in src/main/security.ts, run as a real process (security-guard.test.ts drives the
// same code with a fake process). security.ts is bundled the way build-main.mjs does it, with and without the
// APLOS_RELEASE_BUILD define and with a stand-in for 'electron', then started with plain Node, so the exit code
// and the stderr line are what a launcher would see.
const stubElectron = `
module.exports = {
  app: {
    isPackaged: process.env.STUB_PACKAGED === '1',
    commandLine: { hasSwitch: name => (process.env.STUB_SWITCH || '') === name },
    on() {},
  },
  BrowserWindow: {}, session: {}, shell: {}, systemPreferences: {},
};`;
const dir = await mkdtemp(join(tmpdir(), 'aplos-guard-'));
async function bundle(release: boolean) {
  const outfile = join(dir, `security-${release ? 'release' : 'local'}.cjs`);
  await build({
    entryPoints: [new URL('../../src/main/security.ts', import.meta.url).pathname],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
    define: { __APLOS_RELEASE_BUILD__: JSON.stringify(release) },
    plugins: [
      {
        name: 'stub-electron',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stubElectron }));
        },
      },
    ],
  });
  return outfile;
}
const release = await bundle(true);
const local = await bundle(false);
test.after(() => rm(dir, { recursive: true, force: true }));

function run(file: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [file, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', STUB_PACKAGED: '1', ...env },
  });
  return { code: r.status, stderr: r.stderr };
}

test('debug guard: a release build exits with code 78 on any debugging switch, naming only the switch', () => {
  assert.equal(vh.DEBUG_GUARD_EXIT_CODE, 78);
  for (const arg of [
    '--remote-debugging-port=0',
    '-remote-debugging-port=9222',
    '--remote-debugging-pipe',
    '--remote-debugging-address=0.0.0.0',
    '--inspect',
    '--inspect=0',
    '-inspect-brk=9229',
    '--inspect-port=1',
    '--debug',
    '--debug-brk=5858',
  ]) {
    // app.isPackaged must not matter: only the release define does.
    for (const packaged of ['1', '0']) {
      const r = run(release, ['--user-data-dir=/tmp/x', arg], { STUB_PACKAGED: packaged });
      assert.equal(r.code, 78, arg);
      assert.match(
        r.stderr,
        /^Aplos Mail: a release build does not start with --[a-z-]+\.\n$/,
        arg,
      );
      assert.ok(!r.stderr.includes('='), `the value is never echoed: ${r.stderr}`);
    }
  }
  // Chromium's own parse is consulted too.
  assert.equal(run(release, [], { STUB_SWITCH: 'remote-debugging-port' }).code, 78);
});

test('debug guard: ordinary release launches and every non-release build start normally', () => {
  for (const args of [
    [],
    ['--user-data-dir=/tmp/x'],
    ['mailto:someone@example.com?subject=--inspect'],
    ['aplos://open?x=--remote-debugging-port=1'],
    ['--debugger-ui'],
    ['-NSDocumentRevisionsDebugMode', 'YES'],
  ])
    assert.deepEqual(run(release, args), { code: 0, stderr: '' }, args.join(' '));
  // `npm run package`, `electron .` and verify-release builds have no release define and keep debugging.
  for (const packaged of ['1', '0'])
    assert.equal(run(local, ['--remote-debugging-port=0'], { STUB_PACKAGED: packaged }).code, 0);
  const { debugSwitch } = createRequire(import.meta.url)(local);
  assert.equal(debugSwitch(['a', '--inspect-brk=1']), '--inspect-brk');
  assert.equal(debugSwitch(['a']), undefined);
});
