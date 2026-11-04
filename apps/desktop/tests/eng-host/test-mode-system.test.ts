import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedExternalLinks, silenceSystem } from '../../src/main/test-mode';

// Freeze round 2, R2H-5: the two paths that still reached the system browser and the macOS microphone prompt.
test('test mode: openExternal is recorded and dropped, the microphone prompt answers no, nothing is opened', async () => {
  const calls: string[] = [];
  const shell = {
    openExternal: async (url: string) => void calls.push(`openExternal ${url}`),
    openPath: async (path: string) => (calls.push(`openPath ${path}`), ''),
    showItemInFolder: (path: string) => void calls.push(`reveal ${path}`),
  };
  const prefs = { askForMediaAccess: async () => (calls.push('prompt'), true) };
  const lines: string[] = [];
  silenceSystem(shell, prefs, line => lines.push(line));

  await shell.openExternal('https://accounts.example/o/oauth2?state=secret#frag');
  assert.equal(await shell.openPath('/tmp/x.pdf'), '');
  shell.showItemInFolder('/tmp/x.pdf');
  assert.equal(await prefs.askForMediaAccess(), false);

  assert.deepEqual(calls, [], 'no real call was made');
  assert.deepEqual(recordedExternalLinks, ['https://accounts.example/o/oauth2?state=secret#frag']);
  assert.ok(lines[0].includes('https://accounts.example/o/oauth2'));
  assert.ok(!lines[0].includes('secret'), 'the log line carries no query string');
});
