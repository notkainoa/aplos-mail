// Proves that a mechanical formatting commit changed layout only.
//
// Usage: node scripts/audit/format-equivalence.mjs --before <ref> --after <ref> [--build]
//
// For every file that differs between the two refs (renames followed with `git diff -M`; a 100%
// rename is accepted as is) the script compares the before and after blobs:
//   .ts .tsx .js .jsx .mjs .cjs .mts .cts
//       1. esbuild transform with minify, so the two outputs must be identical. JSX is kept
//          (jsx: 'preserve'); if only the preserved JSX text differs, the JSX is compiled to
//          function calls instead (JSX whitespace rules applied) and must then be identical, and
//          the file is listed under "notes".
//       2. the multiset of comment texts (whitespace normalised), read with the TypeScript
//          parser, so a dropped or altered comment is caught (a minifier drops comments).
//       3. (TypeScript files) a syntax tree fingerprint, because esbuild erases types: node
//          kinds and identifier, string, number and template text must match, ignoring only
//          parentheses, stray semicolons, JSX text and the quoting of property names.
//   .css           esbuild css minify must be identical, plus the comment multiset
//   .json, .prettierrc   JSON (comments allowed, as in tsconfig) must parse to the same value
// Any other changed file type, an added, deleted or type-changed file, a mode change, or any file
// that cannot be parsed is a failure and is listed. Exit code 1 on any failure.
//
// --build also builds both refs in temporary detached git worktrees (node_modules is cloned with
// `cp -cR` from the current checkout, workspace links are re-pointed at each worktree) with
// `npm run build` (tsc, vite build, build-main.mjs; sourcemaps are off in the existing build files)
// and requires apps/desktop/dist/main/*.cjs and every file under apps/desktop/dist/renderer to be
// byte-identical with identical names. If a build ever emitted sourcemaps, .map files are ignored
// and sourceMappingURL comments stripped, and the summary says so. The native helper in dist/bin
// (swiftc, lipo) is compared for information only. Temporary worktrees are always removed.
// The build runs without GOOGLE_CLIENT_*, MICROSOFT_CLIENT_ID and APLOS_RELEASE_BUILD in its
// environment, so no secret is read.
//
// Landing runbook (restructure chain slot 2, on the branch `revamp` after the engine move):
//   1. Start clean:  git status --short  (empty), npm ci, npm run typecheck && npm test (baseline).
//   2. Format:       npm run format  (run it twice: Prettier member chains are not always stable
//      on the first pass, so repeat until  npm run format:check  exits 0, then make ONE commit)
//      Then  git status --short  must list source files only, and  npm run format:check  exits 0.
//   3. Commit:       git commit -am "[mechanical] Format the tree with Prettier"
//      (author Kainoa Newton <k@kainoa.me>; the commit contains nothing but the format.)
//   4. Prove it:     node scripts/audit/format-equivalence.mjs --before HEAD~1 --after HEAD --build
//      It must print PASS. Also run npm run typecheck, npm test and npm run verify:release.
//   5. Follow-up:    printf '# Prettier format commit\n%s\n' "$(git rev-parse HEAD)" > .git-blame-ignore-revs
//      git add .git-blame-ignore-revs
//      git commit -m "Add .git-blame-ignore-revs for the format commit"
//      Check:  git blame --ignore-revs-file .git-blame-ignore-revs <dense file>  names the original
//      author (include one line in a moved engine file). GitHub reads the file by itself; locally
//      set  git config blame.ignoreRevsFile .git-blame-ignore-revs.
//
// The esbuild and typescript packages come from the repository's node_modules (installed with
// vite and the app's dependencies).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(repoRoot, 'package.json'));
const esbuild = require('esbuild');
const ts = require('typescript');

const CODE_LOADERS = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
};
const SCRIPT_KINDS = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
};

const git = (args, options = {}) =>
  execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    ...options,
  });

// ---------------------------------------------------------------- comparing one file

const normaliseSpace = text => text.replace(/\s+/g, ' ').trim();
const clip = text => (text.length > 90 ? `${text.slice(0, 87)}...` : text);

const parse = (text, extension) =>
  ts.createSourceFile(
    `file${extension}`,
    text,
    ts.ScriptTarget.ESNext,
    true,
    SCRIPT_KINDS[extension],
  );

/** Comment texts of a TypeScript or JavaScript source, found through the parser (so regular
 * expressions, strings and JSX text are never mistaken for comments). */
function codeComments(text, extension) {
  const file = parse(text, extension);
  const starts = new Set();
  const found = [];
  const visit = node => {
    const children = node.getChildren(file);
    if (children.length) return children.forEach(visit);
    if (node.kind === ts.SyntaxKind.JsxText) return;
    // Comments on the same line as the previous token are "trailing"; the rest are "leading".
    const ranges = [
      ...(ts.getTrailingCommentRanges(text, node.pos) ?? []),
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
    ];
    for (const range of ranges) {
      if (starts.has(range.pos)) continue;
      starts.add(range.pos);
      found.push(normaliseSpace(text.slice(range.pos, range.end)));
    }
  };
  visit(file);
  return found;
}

const cssComments = text => (text.match(/\/\*[\s\S]*?\*\//g) ?? []).map(normaliseSpace);

/** Comments in JSON with comments (tsconfig style); strings are skipped so urls are not comments. */
function jsonComments(text) {
  const pattern = /"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  return [...text.matchAll(pattern)]
    .map(m => m[0])
    .filter(m => m[0] === '/')
    .map(normaliseSpace);
}

function diffMultisets(before, after) {
  const count = list => {
    const counts = new Map();
    for (const item of list) counts.set(item, (counts.get(item) ?? 0) + 1);
    return counts;
  };
  const a = count(before);
  const b = count(after);
  const problems = [];
  for (const [text, n] of a) {
    if ((b.get(text) ?? 0) < n) problems.push(`comment dropped or altered: ${clip(text)}`);
  }
  for (const [text, n] of b) {
    if ((a.get(text) ?? 0) < n) problems.push(`comment added or altered: ${clip(text)}`);
  }
  return problems;
}

/** A flat description of the syntax tree that ignores what Prettier may legitimately change. */
function treeFingerprint(text, extension) {
  const K = ts.SyntaxKind;
  const out = [];
  const visit = node => {
    switch (node.kind) {
      case K.ParenthesizedExpression:
        return visit(node.expression);
      case K.ParenthesizedType:
        return visit(node.type);
      case K.EmptyStatement:
      case K.SemicolonClassElement:
      case K.JsxText:
      case K.JsxClosingElement:
      case K.JsxClosingFragment:
        return;
      case K.JsxExpression:
        // Prettier writes significant JSX whitespace as {' '}; the compiled JSX check covers it.
        if (
          node.expression &&
          ts.isStringLiteral(node.expression) &&
          !node.expression.text.trim()
        ) {
          return;
        }
        break;
      case K.Identifier:
      case K.StringLiteral:
      case K.NoSubstitutionTemplateLiteral:
      case K.NumericLiteral:
      case K.BigIntLiteral:
      case K.RegularExpressionLiteral:
      case K.TemplateHead:
      case K.TemplateMiddle:
      case K.TemplateTail: {
        // A quoted property name may become a bare one, so a name compares by its text only.
        const isName = node.parent && node.parent.name === node;
        out.push(`${isName ? 'N' : node.kind}:${node.text ?? node.rawText}`);
        return;
      }
    }
    out.push(String(node.kind));
    ts.forEachChild(node, visit);
  };
  visit(parse(text, extension));
  return out;
}

/** The compiled form of JSX (React.createElement calls) as a flat list, with adjacent string
 * children merged, because Prettier may split " . " into " ." and {' '}. */
function compiledFingerprint(code) {
  const out = [];
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText() === 'React.createElement') {
      out.push('createElement');
      let text = null;
      const flush = () => {
        if (text !== null) out.push(`S:${text}`);
        text = null;
      };
      for (const arg of node.arguments) {
        if (ts.isStringLiteralLike(arg)) text = (text ?? '') + arg.text;
        else {
          flush();
          visit(arg);
        }
      }
      flush();
      return;
    }
    out.push(ts.isStringLiteralLike(node) ? `S:${node.text}` : String(node.kind));
    if (ts.isIdentifier(node)) out.push(node.text);
    ts.forEachChild(node, visit);
  };
  const file = ts.createSourceFile('file.js', code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  visit(file);
  return out;
}

const sameList = (a, b) => a.length === b.length && a.every((item, i) => item === b[i]);

function firstDifference(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return `at element ${i}: ${clip(String(a[i]))} vs ${clip(String(b[i]))}`;
  }
  return 'in length';
}

const minify = (text, loader, extra = {}) =>
  esbuild.transformSync(text, {
    loader,
    minify: true,
    legalComments: 'none',
    target: 'esnext',
    ...extra,
  }).code;

/** Minified css with the spaces after commas outside strings removed: Prettier writes
 * var(--x, rgba(1, 2, 3)) where the source had rgba(1,2,3), and esbuild keeps a var() fallback
 * as written. */
const cssForCompare = text =>
  minify(text, 'css')
    .split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/)
    .map((part, i) => (i % 2 ? part : part.replace(/\s*,\s*/g, ',')))
    .join('');

const jsonValue = text => {
  const { config, error } = ts.parseConfigFileTextToJson('file.json', text);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  return JSON.stringify(config);
};

/** Returns { problems: string[], note?: string } for a pair of blobs of the same file type. */
function compare(kind, extension, before, after) {
  const problems = [];
  let note;
  if (kind === 'code') {
    const loader = CODE_LOADERS[extension];
    const jsx = loader === 'tsx' || loader === 'jsx';
    const keep = jsx ? { jsx: 'preserve' } : {};
    const a = minify(before, loader, keep);
    const b = minify(after, loader, keep);
    if (a !== b) {
      const compiled = text => compiledFingerprint(minify(text, loader, { jsx: 'transform' }));
      if (jsx && sameList(compiled(before), compiled(after))) {
        note = 'JSX text layout differs; compiled JSX is identical (adjacent text children merged)';
      } else {
        problems.push(`minified output differs ${firstDifference(a, b)}`);
      }
    }
    problems.push(
      ...diffMultisets(codeComments(before, extension), codeComments(after, extension)),
    );
    if (loader === 'ts' || loader === 'tsx') {
      const x = treeFingerprint(before, extension);
      const y = treeFingerprint(after, extension);
      if (!sameList(x, y)) {
        problems.push(`syntax tree differs ${firstDifference(x, y)}`);
      }
    }
  } else if (kind === 'css') {
    const a = cssForCompare(before);
    const b = cssForCompare(after);
    if (a !== b) problems.push(`minified css differs ${firstDifference([...a], [...b])}`);
    problems.push(...diffMultisets(cssComments(before), cssComments(after)));
  } else if (kind === 'json') {
    if (jsonValue(before) !== jsonValue(after)) problems.push('parsed json differs');
    problems.push(...diffMultisets(jsonComments(before), jsonComments(after)));
  }
  return { problems, note };
}

function kindOf(path) {
  const extension = extname(path);
  if (path.split('/').pop() === '.prettierrc') return { kind: 'json', label: '.json' };
  if (extension in CODE_LOADERS) return { kind: 'code', label: extension, extension };
  if (extension === '.css') return { kind: 'css', label: '.css' };
  if (extension === '.json') return { kind: 'json', label: '.json' };
  return null;
}

// ---------------------------------------------------------------- the refs

function changedFiles(before, after) {
  const raw = git(['diff', '-M', '--raw', '-z', '--no-abbrev', before, after]).split('\0');
  const files = [];
  for (let i = 0; i < raw.length && raw[i]; i++) {
    const [oldMode, newMode, oldSha, newSha, status] = raw[i].slice(1).split(' ');
    const moved = status[0] === 'R' || status[0] === 'C';
    const oldPath = raw[++i];
    const newPath = moved ? raw[++i] : oldPath;
    files.push({ oldMode, newMode, oldSha, newSha, status, oldPath, newPath });
  }
  return pairByName(files);
}

/** A move combined with a format leaves too little in common for git's rename detection. A deleted
 * and an added file with the same name, each the only one of that name, count as one
 * renamed file (status R0, listed in the notes). */
function pairByName(files) {
  const base = path => path.split('/').pop();
  const gone = files.filter(file => file.status === 'D');
  const born = files.filter(file => file.status === 'A');
  const only = (list, file) => list.filter(other => base(other.newPath) === base(file.newPath));
  const paired = new Set();
  const renames = [];
  for (const old of gone) {
    const [candidate, ...rest] = only(born, old);
    if (!candidate || rest.length || only(gone, old).length > 1) continue;
    paired.add(old).add(candidate);
    renames.push({
      ...candidate,
      oldMode: old.oldMode,
      oldSha: old.oldSha,
      oldPath: old.oldPath,
      status: 'R0',
    });
  }
  return [...files.filter(file => !paired.has(file)), ...renames];
}

function checkFiles(before, after) {
  const counts = new Map();
  const failures = [];
  const notes = [];
  let unchangedContent = 0;
  const files = changedFiles(before, after);
  for (const file of files) {
    const name = file.newPath;
    const fail = message => failures.push(`${name}: ${message}`);
    if (file.status === 'R0') notes.push(`${file.oldPath} -> ${name}: paired by file name`);
    if (!/^[MR]/.test(file.status)) {
      fail(`status ${file.status} (added, deleted or type-changed files are not a format change)`);
      continue;
    }
    if (file.oldMode !== file.newMode) {
      fail(`mode changed ${file.oldMode} -> ${file.newMode}`);
      continue;
    }
    if (file.oldSha === file.newSha) {
      unchangedContent++;
      continue;
    }
    const type = kindOf(file.newPath);
    const oldType = kindOf(file.oldPath);
    if (!type || !oldType || type.label !== oldType.label) {
      fail(`file type cannot be proven equivalent (${extname(name) || name})`);
      continue;
    }
    try {
      const blob = (ref, path) => git(['show', `${ref}:${path}`]);
      const result = compare(
        type.kind,
        type.extension,
        blob(before, file.oldPath),
        blob(after, file.newPath),
      );
      counts.set(type.label, (counts.get(type.label) ?? 0) + 1);
      for (const problem of result.problems) fail(problem);
      if (result.note) notes.push(`${name}: ${result.note}`);
    } catch (error) {
      fail(`cannot be proven: ${error.message.split('\n')[0]}`);
    }
  }
  return { total: files.length, counts, failures, notes, unchangedContent };
}

// ---------------------------------------------------------------- the build comparison

const run = (command, args, options) =>
  execFileSync(command, args, { stdio: 'pipe', maxBuffer: 1 << 28, ...options });

function workspaceDirs(root) {
  const dirs = [];
  for (const group of ['apps', 'packages']) {
    if (!existsSync(join(root, group))) continue;
    for (const name of readdirSync(join(root, group))) {
      if (existsSync(join(root, group, name, 'package.json'))) dirs.push(`${group}/${name}`);
    }
  }
  return dirs;
}

function buildRef(ref, tempRoot, label) {
  const dir = join(tempRoot, label);
  run('git', ['worktree', 'add', '--detach', dir, ref], { cwd: repoRoot });
  run('cp', ['-cR', join(repoRoot, 'node_modules'), join(dir, 'node_modules')]);
  // Point workspace links at this worktree, whatever layout the ref has.
  for (const workspace of workspaceDirs(dir)) {
    const { name } = JSON.parse(readFileSync(join(dir, workspace, 'package.json'), 'utf8'));
    if (!name) continue;
    const link = join(dir, 'node_modules', name);
    rmSync(link, { recursive: true, force: true });
    symlinkSync(relative(dirname(link), join(dir, workspace)), link);
  }
  const env = { ...process.env };
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MICROSOFT_CLIENT_ID']) {
    delete env[key];
  }
  delete env.APLOS_RELEASE_BUILD;
  run('npm', ['run', 'build'], { cwd: dir, env });
  return join(dir, 'apps', 'desktop', 'dist');
}

function listFiles(root, base = root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path, base));
    else out.push(relative(base, path));
  }
  return out.sort();
}

function readBuilt(path, state) {
  const data = readFileSync(path);
  if (!/\.(cjs|js|css|html)$/.test(path)) return data;
  const text = data.toString('utf8');
  const stripped = text.replace(/^\/\/# sourceMappingURL=.*$|\/\*# sourceMappingURL=.*?\*\//gm, '');
  if (stripped === text) return data;
  state.stripped++;
  return Buffer.from(stripped);
}

const sha = data => createHash('sha256').update(data).digest('hex');

function compareBuilds(distBefore, distAfter) {
  const failures = [];
  const info = [];
  const state = { stripped: 0, ignoredMaps: 0 };
  const sets = [
    ['dist/main/*.cjs', 'main', name => name.endsWith('.cjs'), true],
    ['dist/renderer', 'renderer', () => true, true],
    ['dist/bin (native helper, information only)', 'bin', () => true, false],
  ];
  let compared = 0;
  for (const [title, folder, filter, strict] of sets) {
    const list = dist =>
      listFiles(join(dist, folder)).filter(name => {
        if (name.endsWith('.map')) {
          state.ignoredMaps++;
          return false;
        }
        return filter(name);
      });
    const a = list(distBefore);
    const b = list(distAfter);
    for (const name of [...new Set([...a, ...b])].sort()) {
      const inA = a.includes(name);
      const inB = b.includes(name);
      let problem = null;
      if (!inA) problem = `only in after: ${folder}/${name}`;
      else if (!inB) problem = `only in before: ${folder}/${name}`;
      else {
        const same =
          sha(readBuilt(join(distBefore, folder, name), state)) ===
          sha(readBuilt(join(distAfter, folder, name), state));
        if (same) compared++;
        else problem = `bytes differ: ${folder}/${name}`;
      }
      if (problem) (strict ? failures : info).push(`${title}: ${problem}`);
    }
  }
  return { failures, info, compared, state };
}

function buildComparison(before, after) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'aplos-format-equivalence-'));
  const created = [];
  try {
    created.push('before');
    const distBefore = buildRef(before, tempRoot, 'before');
    created.push('after');
    const distAfter = buildRef(after, tempRoot, 'after');
    return compareBuilds(distBefore, distAfter);
  } finally {
    for (const label of created) {
      try {
        run('git', ['worktree', 'remove', '--force', join(tempRoot, label)], { cwd: repoRoot });
      } catch {
        // The directory is removed below either way and `git worktree prune` clears the record.
      }
    }
    rmSync(tempRoot, { recursive: true, force: true });
    run('git', ['worktree', 'prune'], { cwd: repoRoot });
  }
}

// ---------------------------------------------------------------- main

function main() {
  const args = process.argv.slice(2);
  const value = name => args[args.indexOf(name) + 1];
  const before = args.includes('--before') ? value('--before') : undefined;
  const after = args.includes('--after') ? value('--after') : undefined;
  if (!before || !after) {
    console.error(
      'usage: node scripts/audit/format-equivalence.mjs --before <ref> --after <ref> [--build]',
    );
    process.exit(2);
  }
  const resolved = ref => git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  const beforeSha = resolved(before);
  const afterSha = resolved(after);
  console.log(`before ${before} (${beforeSha.slice(0, 10)})`);
  console.log(`after  ${after} (${afterSha.slice(0, 10)})`);

  const result = checkFiles(beforeSha, afterSha);
  const failures = [...result.failures];
  console.log(`\nchanged files: ${result.total} (${result.unchangedContent} pure renames)`);
  for (const [label, count] of [...result.counts].sort()) {
    console.log(`  checked ${label}: ${count}`);
  }
  if (result.notes.length) {
    console.log(`\nnotes (${result.notes.length}):`);
    for (const note of result.notes) console.log(`  ${note}`);
  }

  if (args.includes('--build')) {
    console.log('\nbuilding both refs (this takes a few minutes)...');
    try {
      const build = buildComparison(beforeSha, afterSha);
      console.log(`build: ${build.compared} files byte-identical`);
      if (build.state.stripped) {
        console.log(`  stripped sourceMappingURL comments in ${build.state.stripped} file reads`);
      }
      if (build.state.ignoredMaps) console.log(`  ignored ${build.state.ignoredMaps} .map files`);
      for (const line of build.info) console.log(`  info: ${line}`);
      failures.push(...build.failures.map(line => `build: ${line}`));
    } catch (error) {
      const detail = String(error.stderr || error.message).slice(-600);
      failures.push(`build: could not complete (${detail})`);
    }
  }

  if (failures.length) {
    console.log(`\nFAIL: ${failures.length} problem(s)`);
    for (const failure of failures) console.log(`  ${failure}`);
    process.exit(1);
  }
  console.log('\nPASS: no differences');
}

main();
