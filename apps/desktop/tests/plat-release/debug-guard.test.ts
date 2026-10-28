import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the script is untyped ESM
const vh: any = await import(new URL('../../scripts/verify-hardening.mjs', import.meta.url).href);

// ADR 40-6: the startup guard in src/main/security.ts. security.ts is bundled the way build-main.mjs does it,
// with a stand-in for 'electron' (packaged or not via STUB_PACKAGED), then run as a plain Node process.
const stubElectron = `
const exit = code => process.exit(code);
module.exports = {
  app: {
    isPackaged: process.env.STUB_PACKAGED === '1',
    commandLine: { hasSwitch: name => (process.env.STUB_SWITCH || '') === name },
    exit,
  },
  BrowserWindow: {}, session: {}, shell: {}, systemPreferences: {},
};`;
const dir = await mkdtemp(join(tmpdir(), 'aplos-guard-'));
async function bundle(e2e: boolean) {
  const outfile = join(dir, `security-${e2e ? 'e2e' : 'normal'}.cjs`);
  await build({
    entryPoints: [new URL('../../src/main/security.ts', import.meta.url).pathname],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
    define: { __APLOS_E2E__: JSON.stringify(e2e) },
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
const normal = await bundle(false);
const e2e = await bundle(true);
test.after(() => rm(dir, { recursive: true, force: true }));

function run(file: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [file, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', STUB_PACKAGED: '1', ...env },
  });
  return { code: r.status, stderr: r.stderr };
}

test('debug guard: a packaged build exits with code 78 on any debugging switch, before anything else', () => {
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
    const r = run(normal, ['--user-data-dir=/tmp/x', arg]);
    assert.equal(r.code, 78, arg);
    assert.match(
      r.stderr,
      /^Aplos Mail: refusing to start with -{1,2}[a-z-]+; debugging is off/,
      arg,
    );
    assert.ok(!r.stderr.includes('='), `the value is never echoed: ${r.stderr}`);
  }
  // Chromium's own parse is consulted too.
  assert.equal(run(normal, [], { STUB_SWITCH: 'remote-debugging-port' }).code, 78);
});

test('debug guard: ordinary launches, links, development runs and the E2E variant start normally', () => {
  for (const args of [
    [],
    ['--user-data-dir=/tmp/x'],
    ['mailto:someone@example.com?subject=--inspect'],
    ['aplos://open?x=--remote-debugging-port=1'],
    ['--debugger-ui'],
    ['-NSDocumentRevisionsDebugMode', 'YES'],
  ])
    assert.deepEqual(run(normal, args), { code: 0, stderr: '' }, args.join(' '));
  assert.equal(run(normal, ['--remote-debugging-port=0'], { STUB_PACKAGED: '0' }).code, 0);
  assert.equal(run(e2e, ['--remote-debugging-port=0']).code, 0);
  const { debugSwitch } = createRequire(import.meta.url)(normal);
  assert.equal(debugSwitch(['a', '--inspect-brk=1']), '--inspect-brk');
  assert.equal(debugSwitch(['a']), undefined);
});
