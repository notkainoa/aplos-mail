import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

// The host imports these by package name; a subpath dropped from `package.json` `exports` breaks it at run time.
const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
  exports: Record<string, string>;
};

test('@aplos/engine/ai/lanes is exported and holds laneFor, for the host to pass to openStore({ ingest })', async () => {
  const target = pkg.exports['./ai/lanes'];
  assert.equal(target, './src/ai/lanes.ts');
  const lanes = (await import(join(import.meta.dirname, '..', target))) as { laneFor?: unknown };
  assert.equal(typeof lanes.laneFor, 'function');
});
