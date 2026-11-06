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
async function bundleNeutral(
  dir: string,
  skip?: (file: string) => boolean,
  minify = false,
  split = false,
) {
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
    minify,
    metafile: true,
    // Split: a module reached only through `import()` becomes a chunk of its own, loaded on first use.
    ...(split ? { splitting: true, outdir: join(dir, '.out') } : {}),
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
    code: result.outputFiles.map(file => file.text).join('\n'),
    chunks: result.outputFiles.map(file => ({
      bytes: file.contents.length,
      inputs: Object.keys(
        result.metafile.outputs[relative(process.cwd(), file.path)]?.inputs ?? {},
      ),
    })),
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
// Modules a first run reaches only through `import()` (see `lazyDemoWrites`): measured as a chunk of their own, so
// they are reported but do not count against the startup budget. Nothing may import them statically.
const lazyModules = [
  join(src, 'ai', 'demo', 'data.ts'),
  join(src, 'calendar', 'views.ts'),
  join(src, 'calendar', 'recurrence', 'expand.ts'),
  join(src, 'calendar', 'recurrence', 'generate.ts'),
  join(src, 'calendar', 'recurrence', 'series.ts'),
  join(src, 'calendar', 'recurrence', 'rule.ts'),
  // Reached only through the lazy chain or not at all yet (the event-edit writes are still to come):
  // kept out of the entry list so their imports cannot pull the lazy modules back into the core.
  join(src, 'calendar', 'recurrence', 'index.ts'),
  join(src, 'calendar', 'recurrence', 'edit.ts'),
  join(src, 'calendar', 'recurrence', 'keys.ts'),
];
// The budget is for the bundle that ships, so it is measured minified (2026-10-28: 253,443 bytes; unminified the same
// files measure 426,360, which is only a growth signal, see DECISIONS.md). Raised 400,000 -> 450,000 on 2026-11-04 and 450,000 -> 465,000 on 2026-11-06
// (owner decision, DECISIONS.md); the last raise without a new decision.
const BUDGET_BYTES = 465_000;
test('the new engine (contract types and zod-free tables only, no zod) stays under 465,000 minified bytes and never imports legacy code', async () => {
  const { chunks, inputs } = await bundleNeutral(
    src,
    f => f.startsWith(legacy) || lazyModules.includes(f),
    true,
    true,
  );
  assert.deepEqual(
    inputs.filter(path => /(^|\/)legacy\//.test(path)),
    [],
    'no legacy imports outside legacy/',
  );
  const isLazy = (path: string) => lazyModules.some(m => path.endsWith(relative(process.cwd(), m)));
  // A lazy chunk holds nothing but lazy modules; a static import would fold them into the core chunk instead.
  const lazy = chunks.filter(chunk => chunk.inputs.length > 0 && chunk.inputs.every(isLazy));
  const core = chunks.filter(chunk => !lazy.includes(chunk));
  // esbuild merges `import()` points that share deps: several lazy modules may sit in one chunk; the invariant
  // is that a lazy chunk holds ONLY lazy modules and none reach the core.
  assert.ok(
    lazy.every(chunk => chunk.inputs.every(isLazy)),
    'a lazy chunk holds nothing but lazy modules',
  );
  assert.ok(
    core.every(chunk => !chunk.inputs.some(isLazy)),
    'no lazy module is in the core bundle',
  );

  const bytes = core.reduce((sum, chunk) => sum + chunk.bytes, 0);
  const later = lazy.reduce((sum, chunk) => sum + chunk.bytes, 0);
  console.log(
    `engine bundle: ${bytes} bytes minified of ${BUDGET_BYTES} (${BUDGET_BYTES - bytes} left), plus ${later} bytes loaded on first use`,
  );
  assert.ok(later > 0 && lazy.length > 0, 'the lazy modules load on first use, not at startup');
  assert.ok(bytes < BUDGET_BYTES, `engine bundle stays small (${bytes} bytes minified)`);
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
