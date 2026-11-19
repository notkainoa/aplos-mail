import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { build } from 'esbuild';

const src = join(import.meta.dirname, '..', 'src');
/** Every TypeScript file of the contract outside `legacy/`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'legacy' ? [] : sources(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

/** The contract is platform-neutral like the engine (it ships inside it), and its size counts against the 400,000-byte budget. */
test('the contract bundles for a platform without Node, and its size with zod/mini is recorded', async t => {
  const files = sources(src);
  const bundle = (minify: boolean) =>
    build({
      stdin: {
        contents: files
          .map(
            (file, i) => `export * as m${i} from './${relative(src, file).split('\\').join('/')}';`,
          )
          .join('\n'),
        resolveDir: src,
        loader: 'ts',
      },
      bundle: true,
      platform: 'neutral',
      format: 'esm',
      mainFields: ['module', 'main'],
      target: 'es2022',
      write: false,
      metafile: true,
      logLevel: 'silent',
      minify,
      external: ['node:*'],
    });
  const [plain, small] = await Promise.all([bundle(false), bundle(true)]);
  const imports = Object.values(plain.metafile.inputs).flatMap(input =>
    input.imports.map(i => i.path),
  );
  assert.deepEqual(
    imports.filter(path => path.startsWith('node:')),
    [],
    'no Node modules',
  );
  const zodBytes = Object.entries(plain.metafile.outputs)[0]![1].inputs;
  const fromZod = Object.entries(zodBytes)
    .filter(([path]) => path.includes('node_modules/zod'))
    .reduce((n, [, v]) => n + v.bytesInOutput, 0);
  t.diagnostic(
    `contract src (no legacy) + zod/mini, neutral ESM: ${plain.outputFiles[0]!.text.length} bytes unminified (zod ${fromZod}), ${small.outputFiles[0]!.text.length} bytes minified`,
  );
  assert.ok(plain.outputFiles[0]!.text.length < 400_000);
});
