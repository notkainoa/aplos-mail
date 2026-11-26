// The startup fatal screen renders with no data runtime: a window whose engine never connected still shows it.
// Return on the screen calls `onRestart` (FatalScreen, ui/status/status.test.tsx); these check what that restart does.
// Run: cd apps/desktop && npx tsx --test src/renderer/shell/startup-fatal.test.tsx   (server render, no DOM)
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StartupFatalHost, startupRecovery } from './Shell';

const noop = () => undefined;

function recordingEngine(log: string[], fail = false) {
  return {
    call: (method: string) => {
      log.push(method);
      return fail ? Promise.reject(new Error('engine down')) : Promise.resolve({ ok: true });
    },
  };
}

test('without an engine bridge the screen renders and leaves out Copy diagnostics', () => {
  const html = renderToStaticMarkup(
    createElement(StartupFatalHost, { engine: null, reload: noop }),
  );
  assert.match(html, /mail engine/);
  assert.match(html, /Restart engine/);
  assert.doesNotMatch(html, /Copy diagnostics/);
});

test('with the engine bridge the screen offers Copy diagnostics', () => {
  const engine = recordingEngine([]);
  const html = renderToStaticMarkup(createElement(StartupFatalHost, { engine, reload: noop }));
  assert.match(html, /Restart engine/);
  assert.match(html, /Copy diagnostics/);
});

test('restart asks main to restart the engine, then reloads the window', async () => {
  const log: string[] = [];
  await startupRecovery(recordingEngine(log), () => log.push('reload')).restart();
  assert.deepEqual(log, ['Engine/restart', 'reload']);
});

test('restart still reloads when the engine restart fails', async () => {
  const log: string[] = [];
  await startupRecovery(recordingEngine(log, true), () => log.push('reload')).restart();
  assert.deepEqual(log, ['Engine/restart', 'reload']);
});

test('without a bridge restart only reloads and there is no diagnostics action', async () => {
  const log: string[] = [];
  const recovery = startupRecovery(null, () => log.push('reload'));
  await recovery.restart();
  assert.deepEqual(log, ['reload']);
  assert.equal(recovery.diagnostics, undefined);
});

test('diagnostics asks main for a copy', () => {
  const log: string[] = [];
  startupRecovery(recordingEngine(log), noop).diagnostics?.();
  return Promise.resolve().then(() => assert.deepEqual(log, ['Diagnostics/copy']));
});
