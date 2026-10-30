import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  cleanupScratch,
  isRegisteredScratch,
  scratchDir,
  scratchDirFor,
  scratchRegistry,
} from '../scratch.mjs';

const scratchUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'scratch.mjs'),
).href;
// A root outside os.tmpdir(), to prove cleanupScratch can never be pointed at paths elsewhere.
const outsideRoot = mkdtempSync(join(homedir(), 'aplos-scratch-test-outside-'));
after(() => rmSync(outsideRoot, { recursive: true, force: true }));

// Runs `code` as a module in a child process; the child imports the real helper.
const child = code =>
  spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });

describe('scratch.mjs', () => {
  it('creates a dir under tmpdir named aplos-<prefix>-<random> with mode 0700', () => {
    const dir = scratchDir('engine test');
    try {
      assert.ok(dir.startsWith(join(tmpdir(), 'aplos-engine-test-')));
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.ok(isRegisteredScratch(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('always starts the basename with aplos-, defaulting to aplos-scratch', () => {
    for (const [prefix, head] of [
      [undefined, 'aplos-scratch-'],
      ['aplos-foo', 'aplos-foo-'],
      ['../..', 'aplos-scratch-'],
      ['x/../y', 'aplos-x-y-'],
    ]) {
      const dir = scratchDir(prefix);
      assert.ok(dir.startsWith(join(tmpdir(), head)), `${prefix} -> ${dir}`);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cleanupScratch removes registered dirs and is idempotent', () => {
    const a = scratchDir('cleanup-a');
    const b = scratchDir('cleanup-b');
    scratchRegistry.set(a, true); // double registration is harmless
    cleanupScratch();
    assert.equal(existsSync(a), false);
    assert.equal(existsSync(b), false);
    assert.equal(scratchRegistry.size, 0);
    cleanupScratch(); // second call must not throw
  });

  it('cleanupScratch refuses paths outside tmpdir or without the aplos- prefix', () => {
    const outside = join(outsideRoot, 'aplos-trapped');
    mkdirSync(outside);
    const wrongName = mkdtempSync(join(tmpdir(), 'zzz-not-ours-'));
    const traversal = join(tmpdir(), '..', 'aplos-traversal');
    try {
      scratchRegistry.set(outside, true);
      scratchRegistry.set(wrongName, true);
      scratchRegistry.set(traversal, true);
      cleanupScratch();
      assert.equal(existsSync(outside), true, 'outside tmpdir must survive');
      assert.equal(existsSync(wrongName), true, 'non-aplos basename must survive');
      assert.equal(scratchRegistry.size, 0, 'refused entries are still dropped from the registry');
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(wrongName, { recursive: true, force: true });
    }
  });

  it('cleanupScratch tolerates a dir the test already deleted', () => {
    const dir = scratchDir('pre-deleted');
    rmSync(dir, { recursive: true, force: true });
    cleanupScratch();
    assert.equal(scratchRegistry.size, 0);
  });

  describe('scratchDirFor', () => {
    let forDir;
    it('removes the dir right after its own test', t => {
      forDir = scratchDirFor(t, 'for-test');
      assert.ok(existsSync(forDir));
    });
    it('is gone by the next test', () => {
      assert.equal(existsSync(forDir), false);
    });
  });

  describe('child processes', () => {
    const code = extra =>
      `import { scratchDir } from '${scratchUrl}'; const d = scratchDir('child'); console.log(d); ${extra}`;

    it('removes its scratch dir on a normal exit', () => {
      const result = child(code(''));
      assert.equal(result.status, 0, result.stderr);
      const dir = result.stdout.trim();
      assert.ok(dir.startsWith(join(tmpdir(), 'aplos-child-')));
      assert.equal(existsSync(dir), false);
    });

    it('removes its scratch dir when the process throws', () => {
      const result = child(code("throw new Error('boom')"));
      assert.equal(result.status, 1);
      const dir = result.stdout.trim().split('\n')[0];
      assert.equal(existsSync(dir), false);
    });

    it('removes its scratch dir on SIGTERM and re-raises the signal', () => {
      // The interval keeps the event loop alive, so the handler's re-raised SIGTERM is
      // delivered instead of racing a normal exit.
      const result = child(
        code("setInterval(() => {}, 60000); process.kill(process.pid, 'SIGTERM')"),
      );
      assert.equal(result.signal, 'SIGTERM', `status ${result.status}: ${result.stderr}`);
      const dir = result.stdout.trim().split('\n')[0];
      assert.ok(dir.startsWith(join(tmpdir(), 'aplos-child-')));
      assert.equal(existsSync(dir), false);
    });
  });
});
