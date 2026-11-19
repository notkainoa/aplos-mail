import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { build } from 'esbuild';

// The frame code must run wherever the engine does (a phone one day): it bundles for a platform
// with no Node and imports nothing at all. The engine's own portability test does not cover it
// until slice 2 imports it.

describe('frame portability', () => {
  it('bundles for a neutral platform with no imports', async () => {
    const result = await build({
      entryPoints: [join(import.meta.dirname, '../../src/frame/index.ts')],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs);
    assert.ok(
      inputs.every(path => path.includes('src/frame/')),
      inputs.join(', '),
    );
    const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports);
    assert.deepEqual(imports, []);
  });
});
