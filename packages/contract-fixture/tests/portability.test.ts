import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { builtinModules } from 'node:module';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..', '..', '..');
const src = join(import.meta.dirname, '..', 'src');
const nodeModules = [
  ...new Set([
    ...builtinModules
      .filter(m => !m.startsWith('_'))
      .map(m => m.replace(/^node:/, '').split('/')[0]!),
    'electron',
  ]),
];
const nodeOnly = new RegExp(`^(${nodeModules.join('|')})(/|$)`);

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

/** The fixture bundled for a runtime without Node: the browser preview and Electron's renderer both load it. */
async function bundle(minify: boolean) {
  const result = await build({
    stdin: {
      contents: sources(src)
        .map((f, i) => `export * as m${i} from './${relative(src, f).split('\\').join('/')}';`)
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
    external: ['node:*', ...nodeModules, ...nodeModules.map(m => `${m}/*`)],
  });
  const imports = Object.values(result.metafile.inputs).flatMap(input =>
    input.imports.map(i => i.path),
  );
  return {
    code: result.outputFiles[0]!.text,
    inputs: result.metafile.inputs,
    forbidden: imports.filter(p => p.startsWith('node:') || nodeOnly.test(p)),
  };
}

test('the stand-in engine runs without Node or Electron, so the browser preview can load it', async () => {
  const { code, forbidden } = await bundle(false);
  assert.deepEqual(forbidden, [], 'no Node or Electron modules');
  assert.doesNotMatch(code, /\brequire\(/, 'no CommonJS requires');
  // `tsconfig.json` already leaves out Node's types; this also catches DOM-only globals the shared lib allows.
  const stripped = (text: string) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, "''");
  for (const file of sources(src))
    assert.doesNotMatch(
      stripped(readFileSync(file, 'utf8')),
      /(?<![\w$.])(process|Buffer|window|document)\.\w/,
      `${relative(src, file)} uses no Node or DOM-only globals`,
    );
});

test('the bundle size is reported (it never counts toward the engine budget)', async t => {
  const plain = await bundle(false),
    small = await bundle(true);
  const bytes = (code: string) => new TextEncoder().encode(code).length;
  const own = sources(src).reduce((n, f) => n + statSync(f).size, 0);
  t.diagnostic(
    `fixture bundle with contract and zod: ${bytes(plain.code)} bytes unminified, ${bytes(small.code)} minified; fixture sources ${own} bytes`,
  );
  assert.ok(bytes(plain.code) > 0);
});

// The desktop app's dev harness may import it behind its one flag; its packaging keeps it out of the shipped app.
test('the engine and the contract never import the stand-in engine', () => {
  const shipped = [
    join(root, 'packages', 'engine', 'src'),
    join(root, 'packages', 'contract', 'src'),
  ];
  for (const dir of shipped) {
    for (const file of sources(dir)) {
      if (/\.test\.tsx?$/.test(file)) continue;
      assert.doesNotMatch(
        readFileSync(file, 'utf8'),
        /@aplos\/contract-fixture/,
        `${relative(root, file)} imports the fixture`,
      );
    }
  }
});
