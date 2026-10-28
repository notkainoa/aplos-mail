/**
 * Measures the store's share of the neutral engine bundle (plan 10 section 3: engine plus zod under 400,000 bytes).
 * Run: npx tsx packages/engine/bench/store-bundle.ts
 */
import { build } from 'esbuild';
import { join } from 'node:path';

const entry = join(import.meta.dirname, '..', 'src', 'store', 'index.ts');
for (const minify of [false, true]) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    target: 'es2022',
    write: false,
    minify,
    logLevel: 'silent',
  });
  console.log(
    `store bundle ${minify ? 'minified' : 'unminified'}: ${result.outputFiles[0].contents.byteLength} bytes`,
  );
}
