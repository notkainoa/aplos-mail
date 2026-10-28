import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generatedFiles } from '../scripts/generate';
import * as tables from '../generated/methods.generated';
import { getMethod, methodNames } from '../src/index';

const root = join(import.meta.dirname, '..');

/** The golden-file test (ARCH 9.3, E7): a schema or registry change without `npm run generate -w @aplos/contract` fails here. */
for (const [file, render] of Object.entries(generatedFiles)) {
  test(`${file} is up to date with the registry`, () => {
    assert.equal(readFileSync(join(root, file), 'utf8'), render(), `${file} is stale: run npm run generate -w @aplos/contract`);
  });
}

test('the generated tables import no zod, so preload can use them', () => {
  assert.doesNotMatch(readFileSync(join(root, 'generated/methods.generated.ts'), 'utf8'), /^\s*import\b/m);
});

test('the generated tables partition the registry', () => {
  assert.equal(tables.engineMethods.length + tables.desktopMethods.length, methodNames.length);
  assert.ok(tables.listenerMethods.every(name => getMethod(name).host === 'engine' && !getMethod(name).secret && !getMethod(name).uiOnly));
  assert.ok(tables.mcpMethods.every(name => ['read', 'draft'].includes(getMethod(name).scope)));
  assert.ok(!tables.rendererMethods.some(name => (tables.hostMethods as readonly string[]).includes(name)));
  assert.equal(tables.legacyMethods.length, 66);
});
