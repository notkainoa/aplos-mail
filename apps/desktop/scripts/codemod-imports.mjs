#!/usr/bin/env node
// Phase 0 step 1 of the revamp (plans/00-roadmap.md 1.1): moves today's engine, the shared files it
// depends on and today's renderer into their legacy folders with `git mv`, then rewrites import
// specifiers so everything still resolves. It edits specifiers only; it is not a typed-client codemod.
// Run once from the repo root: `node apps/desktop/scripts/codemod-imports.mjs`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..', '..');
const desktop = join(root, 'apps', 'desktop');
const shared = ['types', 'ask', 'mailbox', 'summary', 'live'];
if (!existsSync(join(desktop, 'src', 'engine'))) {
  console.log('Already applied: apps/desktop/src/engine is gone. This codemod runs once.');
  process.exit(0);
}

/** Old absolute path (no extension change) → new absolute path, for every moved file. */
const moves = new Map();
const walk = dir =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
for (const file of walk(join(desktop, 'src', 'engine')))
  moves.set(
    file,
    join(
      root,
      'packages',
      'engine',
      'src',
      'legacy',
      relative(join(desktop, 'src', 'engine'), file),
    ),
  );
for (const name of shared)
  moves.set(
    join(desktop, 'src', 'shared', `${name}.ts`),
    join(root, 'packages', 'contract', 'src', 'legacy', `${name}.ts`),
  );
for (const file of walk(join(desktop, 'src', 'renderer')))
  moves.set(
    file,
    join(desktop, 'src', 'renderer', 'legacy', relative(join(desktop, 'src', 'renderer'), file)),
  );

const sources = [join(desktop, 'src'), join(desktop, 'tests'), join(desktop, 'scripts')]
  .flatMap(walk)
  .filter(f => /\.(ts|tsx|mts|mjs|cjs)$/.test(f) && !f.endsWith('codemod-imports.mjs'));
const exts = ['', '.ts', '.tsx', '.d.ts', '/index.ts', '/index.tsx'];
const target = (from, spec) => {
  for (const ext of exts) {
    const path = resolve(dirname(from), spec + ext);
    if (existsSync(path) && statSync(path).isFile()) return { path, ext };
  }
  return undefined;
};
const packageOf = path => {
  for (const name of ['engine', 'contract']) {
    const base = join(root, 'packages', name, 'src') + sep;
    if (path.startsWith(base)) return { name, base };
  }
  return undefined;
};
const withoutTs = path => path.replace(/\.(tsx?|d\.ts)$/, '');
const relativeSpec = (from, to) => {
  const spec = relative(dirname(from), to).split(sep).join('/');
  return spec.startsWith('.') ? spec : `./${spec}`;
};

const pattern =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bexport\s*\*\s*from\s*)(['"])(\.{1,2}\/[^'"]*)\2/g;
const edits = new Map();
for (const file of sources) {
  const before = readFileSync(file, 'utf8');
  const fileAfter = moves.get(file) ?? file;
  const after = before.replace(pattern, (whole, lead, quote, spec) => {
    const hit = target(file, spec);
    if (!hit) return whole;
    const destination = moves.get(hit.path) ?? hit.path;
    if (destination === hit.path && fileAfter === file) return whole;
    const pkg = packageOf(destination),
      own = packageOf(fileAfter);
    // Keep the specifier's own extension style (`./x` stays extensionless, `./x.png` keeps `.png`).
    const keep =
      hit.ext === '' ? destination : destination.slice(0, destination.length - hit.ext.length);
    const next =
      pkg && pkg.name !== own?.name
        ? `@aplos/${pkg.name}/${withoutTs(relative(pkg.base, keep).split(sep).join('/'))}`
        : relativeSpec(fileAfter, keep);
    return `${lead}${quote}${next}${quote}`;
  });
  if (after !== before) edits.set(file, after);
}

// The renderer's HTML entry and the reader test fixture name renderer files by URL path.
const textEdits = [
  [join(desktop, 'index.html'), '/src/renderer/main.tsx', '/src/renderer/legacy/main.tsx'],
  [join(desktop, 'tests', 'fixtures', 'reader.html'), '/src/renderer/', '/src/renderer/legacy/'],
];

for (const [from, to] of moves) {
  mkdirSync(dirname(to), { recursive: true });
  execFileSync('git', ['mv', from, to], { cwd: root });
}
for (const [file, text] of edits) writeFileSync(moves.get(file) ?? file, text);
for (const [file, from, to] of textEdits)
  writeFileSync(file, readFileSync(file, 'utf8').split(from).join(to));
console.log(`moved ${moves.size} files, rewrote imports in ${edits.size}`);
