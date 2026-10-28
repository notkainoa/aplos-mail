import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { builtinModules } from 'node:module';
import { build } from 'esbuild';
import ts from 'typescript';

const src = join(import.meta.dirname, '..', 'src');
// Every Node built-in, so a bare `string_decoder` cannot pass through a same-named polyfill.
const nodeModules = [
  ...new Set([
    ...builtinModules
      .filter(m => !m.startsWith('_'))
      .map(m => m.replace(/^node:/, '').split('/')[0]),
    'electron',
  ]),
];
const nodeOnly = new RegExp(`^(${nodeModules.join('|')})(/|$)`);

/** Every TypeScript file under `dir`, at any depth, so a subfolder can never be skipped. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? sources(path)
      : /\.tsx?$/.test(name) && !name.endsWith('.d.ts')
        ? [path]
        : [];
  });
}

/** Bundles every file under `dir` for a runtime without Node and returns the Node or Electron imports it found. */
async function bundleNeutral(dir: string, skip?: (file: string) => boolean) {
  const files = sources(dir).filter(f => !skip?.(f));
  const result = await build({
    stdin: {
      contents: files
        .map((f, i) => `export * as m${i} from './${relative(dir, f).split('\\').join('/')}';`)
        .join('\n'),
      resolveDir: dir,
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
    // Left unresolved so the metafile names them, instead of the build stopping at the first one.
    external: ['node:*', ...nodeModules, ...nodeModules.map(m => `${m}/*`)],
  });
  const imports = Object.values(result.metafile.inputs).flatMap(input =>
    input.imports.map(i => i.path),
  );
  return {
    files,
    inputs: Object.keys(result.metafile.inputs),
    code: result.outputFiles[0].text,
    forbidden: imports.filter(path => path.startsWith('node:') || nodeOnly.test(path)),
  };
}

test('the engine bundles for a platform without Node, so a mobile app can reuse it', async () => {
  const { files, code, forbidden } = await bundleNeutral(src);
  assert.ok(
    files.some(f => f.includes(join('src', 'legacy', ''))),
    'the walk reaches subfolders',
  );
  assert.deepEqual(forbidden, [], 'no Node or Electron modules');
  assert.doesNotMatch(code, /\brequire\(/, 'no CommonJS requires left for a runtime to resolve');
});

// The budget is for the engine that ships after Phase 2, which deletes `legacy/`; legacy code is still held to the
// no-Node rule above. The new engine must not lean on legacy code, or the deletion would break it.
const legacy = join(src, 'legacy');
// Measured unminified, all files at once. 2026-10-28: store, runtime, views 1 to 3 reached 426,360 bytes (253,443 minified,
// which is what ships); the budget rose from 400,000 to 450,000, recorded in DECISIONS.md as the plan (plan 10 E1) requires.
const BUDGET_BYTES = 450_000;
test('the new engine (contract types and zod-free tables only, no zod) stays under 450,000 bytes and never imports legacy code', async () => {
  const { code, inputs } = await bundleNeutral(src, f => f.startsWith(legacy));
  assert.deepEqual(
    inputs.filter(path => /(^|\/)legacy\//.test(path)),
    [],
    'no legacy imports outside legacy/',
  );
  const bytes = new TextEncoder().encode(code).length;
  assert.ok(bytes < BUDGET_BYTES, `engine bundle stays small (${bytes} bytes)`);
});

test('a Node import planted in a subfolder fails the portability check', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-portability-'));
  try {
    mkdirSync(join(dir, 'deep', 'er'), { recursive: true });
    writeFileSync(join(dir, 'index.ts'), 'export const ok=1;\n');
    writeFileSync(
      join(dir, 'deep', 'er', 'planted.ts'),
      "import { readFileSync } from 'node:fs';\nexport const read=readFileSync;\n",
    );
    const { forbidden } = await bundleNeutral(dir);
    assert.deepEqual(forbidden, ['node:fs']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the complete engine typechecks with browser libraries and no Node globals', () => {
  const program = ts.createProgram(sources(src), {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: [],
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  });
  const errors = ts.getPreEmitDiagnostics(program);
  assert.equal(
    errors.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(errors, {
      getCurrentDirectory: () => process.cwd(),
      getCanonicalFileName: f => f,
      getNewLine: () => '\n',
    }),
  );
});
