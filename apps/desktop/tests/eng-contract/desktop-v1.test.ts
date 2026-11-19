import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopMethods } from '@aplos/contract/allowlists';
import { extensionOf, fileNameOf, legacyNames, v1Result } from '../../src/shared/desktop-v1';
import { SNIFFED_EXTENSIONS } from '../../src/shared/file-sniff';

test('every row of the v1 table names a real desktop method', () => {
  const all = new Set<string>(desktopMethods);
  for (const method of Object.keys(legacyNames)) assert.ok(all.has(method), method);
});

test('the methods main handles itself, not through the table, are the ones the table omits on purpose', () => {
  const handledInEngineReal = [
    'Window/compose',
    'Engine/restart',
    'Engine/recover',
    'Diagnostics/copy',
    'File/save',
    'File/open',
  ];
  const notServed = ['Symbols/render', 'Ai/pasteKey'];
  const covered = new Set([...Object.keys(legacyNames), ...handledInEngineReal, ...notServed]);
  for (const method of desktopMethods) assert.ok(covered.has(method), `${method} has no owner`);
});

test('Window/claim answers { claimed }; a plain true is { ok: true }; objects pass through', () => {
  assert.deepEqual(v1Result('Window/claim', true), { claimed: true });
  assert.deepEqual(v1Result('Window/claim', false), { claimed: false });
  assert.deepEqual(v1Result('Shell/open', true), { ok: true });
  assert.deepEqual(v1Result('App/info', { name: 'Aplos Mail' }), { name: 'Aplos Mail' });
});

test('Update/* reports lastCheck as epoch milliseconds, as the contract says', () => {
  const info = {
    currentVersion: '1',
    status: { state: 'idle' },
    lastCheck: '2026-11-04T10:00:00.000Z',
  };
  assert.deepEqual(v1Result('Update/status', info), {
    currentVersion: '1',
    status: { state: 'idle' },
    lastCheck: Date.parse('2026-11-04T10:00:00.000Z'),
  });
  assert.deepEqual(v1Result('Update/check', { currentVersion: '1', lastCheck: 'not a date' }), {
    currentVersion: '1',
  });
  assert.deepEqual(v1Result('Update/later', { currentVersion: '1' }), { currentVersion: '1' });
});

test('fileNameOf keeps the last path part, drops control characters, never returns . or .. or empty', () => {
  assert.equal(fileNameOf('../../etc/passwd'), 'passwd');
  assert.equal(fileNameOf('a\\b\\c.pdf'), 'c.pdf');
  assert.equal(fileNameOf('re\u0000port\n.pdf'), 're_port_.pdf');
  for (const raw of ['', '.', '..', 'x/', '../..'])
    assert.equal(fileNameOf(raw), 'attachment', JSON.stringify(raw));
  for (const raw of [undefined, 3, {}, 'x'.repeat(256)])
    assert.throws(() => fileNameOf(raw), /Invalid file name/);
});

test('extensionOf and the openable list: documents and media open, scripts and apps never do', () => {
  assert.equal(extensionOf('Report.PDF'), '.pdf');
  assert.equal(extensionOf('.hidden'), '');
  assert.equal(extensionOf('archive'), '');
  for (const ok of ['a.pdf', 'a.PNG', 'a.docx', 'a.ics'])
    assert.ok(SNIFFED_EXTENSIONS.has(extensionOf(ok)), ok);
  for (const no of [
    'a.app',
    'a.command',
    'a.html',
    'a.svg',
    'a.zip',
    'a.sh',
    'a.scpt',
    'a.webloc',
    'a',
  ])
    assert.ok(!SNIFFED_EXTENSIONS.has(extensionOf(no)), no);
});
