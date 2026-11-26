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
  test(`${file} is up to date with the registry`, async () => {
    assert.equal(
      readFileSync(join(root, file), 'utf8'),
      await render(),
      `${file} is stale: run npm run generate -w @aplos/contract`,
    );
  });
}

test('the generated tables import no zod, so preload can use them', () => {
  assert.doesNotMatch(
    readFileSync(join(root, 'generated/methods.generated.ts'), 'utf8'),
    /^\s*import\b/m,
  );
});

test('the generated tables partition the registry', () => {
  assert.equal(tables.engineMethods.length + tables.desktopMethods.length, methodNames.length);
  assert.ok(
    tables.listenerMethods.every(
      name =>
        getMethod(name).host === 'engine' && !getMethod(name).secret && !getMethod(name).uiOnly,
    ),
  );
  assert.ok(tables.mcpMethods.every(name => ['read', 'draft'].includes(getMethod(name).scope)));
  assert.ok(
    tables.listenerMethods.every(
      name => !(tables.uiOnlyMethods as readonly string[]).includes(name),
    ),
  );
  assert.ok(
    !tables.rendererMethods.some(name => (tables.hostMethods as readonly string[]).includes(name)),
  );
});

/** Freeze FR-9 (ARCH 12.3 item 6): an MCP agent following injected mail must not delete anything unprompted. */
test('MCP exposes no audited (destructive) method, Draft/destroy included', () => {
  assert.ok(!(tables.mcpMethods as readonly string[]).includes('Draft/destroy'));
  for (const name of tables.mcpMethods) assert.ok(!getMethod(name).audit, `${name} is audited`);
  assert.ok((tables.mcpMethods as readonly string[]).includes('Draft/set'), 'drafting stays');
});
