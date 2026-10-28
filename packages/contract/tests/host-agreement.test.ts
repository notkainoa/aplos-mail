import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  legacyDesktopMethods,
  legacyEngineMethods,
  legacyMethods,
} from '../generated/methods.generated';

/**
 * Preload (what a window may call), main (what it sends to the engine or answers natively) and the browser preview
 * used to keep three hand lists that drifted (66/66/62). Since restructure step 3 each derives its set from the
 * generated tables, so they agree by construction. This test keeps it that way: every host builds its set from the
 * named generated list, and no hand-written list of method names comes back.
 */
const main = join(import.meta.dirname, '..', '..', '..', 'apps', 'desktop', 'src', 'main');
const source = (file: string) => readFileSync(join(main, file), 'utf8');

const hosts = [
  { file: 'preload.ts', set: 'allowed', list: 'legacyMethods' },
  { file: 'engine-host.ts', set: 'methods', list: 'legacyEngineMethods' },
  { file: 'native-methods.ts', set: 'nativeMethods', list: 'legacyDesktopMethods' },
  { file: 'server.ts', set: 'serviceMethods', list: 'legacyEngineMethods' },
  { file: 'server.ts', set: 'webMethods', list: 'legacyDesktopMethods' },
] as const;

test('every host derives its method set from the generated allowlists', () => {
  for (const { file, set, list } of hosts) {
    const text = source(file);
    assert.match(
      text,
      /from '@aplos\/contract\/allowlists'/,
      `${file} imports the generated allowlists`,
    );
    assert.match(
      text,
      new RegExp(`\\b${set}\\s*=\\s*new Set<string>\\(${list}\\)`),
      `${file} builds ${set} from ${list}`,
    );
  }
});

test('no host keeps a hand-written list of method names', () => {
  for (const file of new Set(hosts.map(h => h.file))) {
    const literal = /new Set(?:<[^>]*>)?\(\[\s*'[a-z]+\.[A-Za-z.]+'/.exec(source(file));
    assert.equal(literal, null, `${file} declares a method list by hand: ${literal?.[0]}`);
  }
});

test('the generated legacy tables split cleanly into engine and desktop methods', () => {
  const engine = new Set<string>(legacyEngineMethods),
    desktop = new Set<string>(legacyDesktopMethods);
  assert.deepEqual(
    [...engine].filter(m => desktop.has(m)),
    [],
    'no method is both an engine and a desktop method',
  );
  assert.deepEqual(new Set<string>(legacyMethods), new Set([...engine, ...desktop]));
  // Main answers the clipboard paste itself so the key never passes through the renderer.
  assert.ok(desktop.has('ai.key.paste'));
});
