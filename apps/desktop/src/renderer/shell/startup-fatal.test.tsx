// The startup fatal screen renders with no data runtime: a window whose engine never connected still shows it.
// Run: cd apps/desktop && npx tsx --test src/renderer/shell/startup-fatal.test.tsx   (server render, no DOM)
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StartupFatalHost } from './Shell';

const noop = () => undefined;

test('the startup fatal screen renders without a data runtime or an engine bridge', () => {
  const html = renderToStaticMarkup(
    createElement(StartupFatalHost, { engine: null, reload: noop }),
  );
  assert.match(html, /mail engine/);
  assert.match(html, /Restart engine/);
  assert.match(html, /Copy diagnostics/);
});

test('the startup fatal screen renders the same with the engine bridge', () => {
  const engine = { call: () => Promise.resolve({ ok: true }) };
  const html = renderToStaticMarkup(createElement(StartupFatalHost, { engine, reload: noop }));
  assert.match(html, /Restart engine/);
});
