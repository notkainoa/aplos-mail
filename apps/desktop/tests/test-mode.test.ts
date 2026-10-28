import test from 'node:test';
import assert from 'node:assert/strict';
import { silenceDialogs, testMode } from '../src/main/test-mode';

test('test mode is on only for APLOS_TEST=1 with an absolute data directory', () => {
  assert.deepEqual(testMode({ APLOS_TEST: '1', APLOS_DATA_DIR: '/tmp/aplos-test-a' }), {
    enabled: true,
    dataDir: '/tmp/aplos-test-a',
  });
});

test('test mode refuses to start without a usable data directory', () => {
  for (const APLOS_DATA_DIR of [undefined, '', 'relative/dir', './here'])
    assert.match(
      (testMode({ APLOS_TEST: '1', APLOS_DATA_DIR }) as { error: string }).error,
      /APLOS_DATA_DIR/,
    );
});

test('test mode is off when unset or any other value, whatever the data directory', () => {
  for (const APLOS_TEST of [undefined, '', '0', 'true', 'yes', ' 1'])
    assert.deepEqual(testMode({ APLOS_TEST, APLOS_DATA_DIR: '/tmp/x' }), { enabled: false });
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
