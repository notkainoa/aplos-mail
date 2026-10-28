import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';

const src = join(import.meta.dirname, '..', 'src');
const nodeModules = [...new Set([...builtinModules.filter(m => !m.startsWith('_')).map(m => m.replace(/^node:/, '').split('/')[0]!), 'electron'])];
const nodeOnly = new RegExp(`^(${nodeModules.join('|')})(/|$)`);

/**
 * The stand-in runs in Electron, the browser preview and a plain test, so it bundles for a platform without Node. Its
 * size is reported, not budgeted: it is test support and never part of the 400,000-byte engine.
 */
test('the fixture bundles for a platform without Node, and its size is recorded', async t => {
  const bundle = (minify: boolean) => build({
    stdin: { contents: "export * from './index.ts'; export * as control from './control.ts';", resolveDir: src, loader: 'ts' },
    bundle: true, platform: 'neutral', format: 'esm', mainFields: ['module', 'main'], target: 'es2022', write: false, metafile: true, logLevel: 'silent', minify,
    external: ['node:*', ...nodeModules, ...nodeModules.map(m => `${m}/*`)],
  });
  const [plain, small] = await Promise.all([bundle(false), bundle(true)]);
  const imports = Object.values(plain.metafile.inputs).flatMap(input => input.imports.map(i => i.path));
  assert.deepEqual(imports.filter(p => p.startsWith('node:') || nodeOnly.test(p)), [], 'no Node or Electron modules');
  const inputs = Object.values(plain.metafile.outputs)[0]!.inputs;
  const bytesFrom = (match: (path: string) => boolean) => Object.entries(inputs).filter(([p]) => match(p)).reduce((n, [, v]) => n + v.bytesInOutput, 0);
  const own = bytesFrom(p => /(^|contract-fixture\/)src\//.test(p) && !p.includes('contract/src'));
  t.diagnostic(`fixture + contract + zod/mini, neutral ESM: ${plain.outputFiles[0]!.text.length} bytes unminified (fixture's own ${own}, contract ${bytesFrom(p => /(^|\/)contract\/(src|generated)\//.test(p))}, zod ${bytesFrom(p => p.includes('node_modules/zod'))}), ${small.outputFiles[0]!.text.length} bytes minified`);
});
