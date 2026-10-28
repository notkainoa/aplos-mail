import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  silenceDialogs,
  systemTempRoots,
  testMarker,
  testMode,
  type TestModeHost,
} from '../src/main/test-mode';

/** A fake machine: home /Users/owner, temp /private/var/tmp; `dirs` exist, `files` exist, realpath is identity. */
const fake = (dirs: string[], files: string[] = [], compiledIn = true): TestModeHost => ({
  compiledIn,
  tempRoots: ['/private/var/tmp'],
  home: '/Users/owner',
  realpath: path => path,
  exists: path => ['/', '/Users/owner', '/private/var/tmp', ...dirs, ...files].includes(path),
});
const run = '/private/var/tmp/aplos-run-1';

test('test mode is on only for APLOS_TEST=1 with an absolute data directory', () => {
  assert.deepEqual(testMode({ APLOS_TEST: '1', APLOS_DATA_DIR: run }, fake([run])), {
    enabled: true,
    dataDir: run,
  });
});

test('test mode refuses to start without a usable data directory', () => {
  for (const APLOS_DATA_DIR of [undefined, '', 'relative/dir', './here'])
    assert.match(
      (testMode({ APLOS_TEST: '1', APLOS_DATA_DIR }, fake([])) as { error: string }).error,
      /APLOS_DATA_DIR/,
    );
});

test('test mode is off when unset or any other value, whatever the data directory', () => {
  for (const APLOS_TEST of [undefined, '', '0', 'true', 'yes', ' 1'])
    assert.deepEqual(testMode({ APLOS_TEST, APLOS_DATA_DIR: run }, fake([run])), {
      enabled: false,
    });
});

test('silenced dialogs log instead of opening and answer as if dismissed', async () => {
  const lines: string[] = [];
  const dialog: Record<string, (...args: unknown[]) => unknown> = {};
  silenceDialogs(dialog, line => lines.push(line));
  dialog.showErrorBox('Stopped', 'The mailbox stopped.');
  assert.deepEqual(await dialog.showMessageBox({}, { message: 'About' }), {
    response: 0,
    checkboxChecked: false,
  });
  assert.deepEqual(await dialog.showSaveDialog({}, { defaultPath: 'a.pdf' }), {
    canceled: true,
    filePath: '',
  });
  assert.deepEqual(await dialog.showOpenDialog({}), { canceled: true, filePaths: [] });
  assert.equal(dialog.showOpenDialogSync(), undefined);
  assert.deepEqual(lines, ['dialog "Stopped": The mailbox stopped.', 'dialog: About']);
});

// Freeze R2H-1: a test must never run on the owner's data, home, / or any folder not made for the run.
test('test mode refuses the real data folders, home, / and folders outside the temp folder', () => {
  const app = '/Users/owner/Library/Application Support/Aplos Mail';
  const preview = '/Users/owner/Library/Application Support/Aplos Mail Preview';
  for (const dir of [
    '/',
    '/Users/owner',
    '/private/var/tmp',
    app,
    preview,
    `${app}/sub`,
    '/Users/owner/Desktop/t',
    '/opt/aplos',
    '/private/var/tmpx/run',
  ])
    assert.ok(
      'error' in testMode({ APLOS_TEST: '1', APLOS_DATA_DIR: dir }, fake([dir, app, preview])),
      dir,
    );
  assert.ok(
    'error' in testMode({ APLOS_TEST: '1', APLOS_DATA_DIR: '/private/var/tmp/missing' }, fake([])),
  );
});

test('test mode refuses a directory holding a non-test mailbox, and accepts its own after a restart', () => {
  const key = `${run}/engine-key.bin`;
  assert.ok('error' in testMode({ APLOS_TEST: '1', APLOS_DATA_DIR: run }, fake([run], [key])));
  assert.deepEqual(
    testMode({ APLOS_TEST: '1', APLOS_DATA_DIR: run }, fake([run], [key, `${run}/${testMarker}`])),
    { enabled: true, dataDir: run },
  );
});

// Round 3 (R2H-1): no caller-chosen root, no TMPDIR, and no case trick gets past the check.
test('APLOS_TEST_ROOT and TMPDIR cannot widen where test data may live', () => {
  for (const [dir, extra] of [
    ['/usr/local', { APLOS_TEST_ROOT: '/' }],
    ['/Users/owner/Library', { APLOS_TEST_ROOT: '/Users/owner' }],
    ['/Users/owner/Library', { TMPDIR: '/Users/owner' }],
  ] as const)
    assert.ok(
      'error' in
        testMode(
          { APLOS_TEST: '1', APLOS_DATA_DIR: dir, ...extra },
          fake([dir, '/usr', '/Users/owner/Library']),
        ),
      dir,
    );
  assert.ok(!systemTempRoots.includes(process.env.TMPDIR ?? '/'), 'roots are fixed, not TMPDIR');
});

test('a differently cased path to the real data folders is still refused', () => {
  const preview = '/users/owner/library/application support/aplos mail preview';
  assert.ok('error' in testMode({ APLOS_TEST: '1', APLOS_DATA_DIR: preview }, fake([preview])));
});

test('a symlink into the real data folder is resolved and refused (real file system)', () => {
  const base = mkdtempSync(join(tmpdir(), 'aplos-tm-'));
  try {
    const fakeHome = join(base, 'home'),
      appDir = join(fakeHome, 'Library', 'Application Support', 'Aplos Mail');
    mkdirSync(appDir, { recursive: true });
    const link = join(base, 'link');
    symlinkSync(appDir, link);
    writeFileSync(join(base, 'note'), '');
    const host = {
      compiledIn: true,
      tempRoots: [realpathSync(tmpdir())],
      home: fakeHome,
      realpath: (p: string) => realpathSync(p),
      exists: (p: string) => existsSync(p),
    };
    assert.ok('error' in testMode({ APLOS_TEST: '1', APLOS_DATA_DIR: link }, host));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Freeze R2H-4: release builds compile test mode out, so the variables do nothing there.
test('a release build ignores APLOS_TEST entirely', () => {
  assert.deepEqual(testMode({ APLOS_TEST: '1', APLOS_DATA_DIR: run }, fake([run], [], false)), {
    enabled: false,
  });
  assert.deepEqual(testMode({ APLOS_TEST: '1' }, fake([], [], false)), { enabled: false });
});
