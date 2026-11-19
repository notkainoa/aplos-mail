// Run: npx tsx --test 'src/renderer/screens/settings/**/*.test.{ts,tsx}'   (from apps/desktop)
// The Device sync row (Settings → General → Your Macs): drawn only once the engine says it exists, and then named
// "Device sync". Its palette entry was removed with the dead row, so its label must not fall back to the raw anchor.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { dataOf, staticScreen } from './preview/states';

const general = (workflow: { enabled: boolean; available: boolean }): string =>
  renderToStaticMarkup(
    staticScreen({ title: 'general', section: 'general', data: dataOf({ workflow }) }),
  );

test('available: the row is named "Device sync", never the raw anchor', () => {
  const html = general({ enabled: false, available: true });
  assert.match(html, /Your Macs/);
  assert.match(html, />Device sync</);
  assert.doesNotMatch(html, />deviceSync</);
});

test('available and on: the on line, still named "Device sync"', () => {
  const html = general({ enabled: true, available: true });
  assert.match(html, />Device sync</);
  assert.match(html, /On\. Done and Later follow you between Macs\./);
});

test('not available: no row and no "Your Macs" group', () => {
  const html = general({ enabled: false, available: false });
  assert.doesNotMatch(html, /Your Macs/);
  assert.doesNotMatch(html, /data-setting-anchor="deviceSync"/);
});
