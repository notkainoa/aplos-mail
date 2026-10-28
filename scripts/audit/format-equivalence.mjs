// Proves that a mechanical formatting commit changed layout only.
//
// Usage: node scripts/audit/format-equivalence.mjs --before <ref> --after <ref>
//          [--allow-moves] [--build [--keep-dist <dir>] [--strict-bytes]]
//
// For every file that differs between the two refs the script compares the before and after blobs:
//   .ts .tsx .js .jsx .mjs .cjs .mts .cts
//       1. esbuild transform with minify, so the two outputs must be identical. JSX is kept
//          (jsx: 'preserve'); if only the preserved JSX text differs, the JSX is compiled to
//          function calls instead (JSX whitespace rules applied) and must then be identical, and
//          the file is listed under "notes".
//       2. the comments, read with the TypeScript parser, as a multiset of whitespace-normalised
//          texts, so a dropped or altered comment is caught (a minifier drops comments). A
//          directive comment (@ts-expect-error, @ts-ignore, eslint-..., prettier-ignore,
//          @vite-ignore, #__PURE__ and similar) is also keyed by the tokens around it, so moving
//          it to another statement is caught.
//       3. a syntax tree fingerprint, for every code file because a minifier hides renamed locals
//          and erases types: node kinds, operators and flags (++ vs --, let vs const, import
//          type), and identifier, string, number and template text must match, ignoring only
//          parentheses, stray semicolons, JSX text and the quoting of property names.
//   .css           esbuild css minify must be identical, plus the comment multiset
//   .json, .prettierrc   JSON (comments allowed, as in tsconfig) must parse to the same value
// Any other changed file type, an added, deleted or type-changed file, a mode change, or any file
// that cannot be parsed is a failure and is listed. Renames and copies are failures too, since a
// format commit has none (a test file moved out of tests/ would silently stop running); with
// --allow-moves a rename is accepted when both names are of the same provable type, and a deleted
// and an added file that are the only ones with that name are paired (listed in the notes). The
// script itself must be identical in both refs, because it lives inside the format globs; run
// the copy from the before ref (see the runbook). Exit code 1 on any failure.
//
// --build also builds both refs in temporary detached git worktrees (node_modules is cloned with
// `cp -cR` from the current checkout, workspace links are re-pointed at each worktree) with
// `npm run build` (the desktop app: tsc, vite build, build-main.mjs) and `npm run web:build` (the
// website; its formatted files are not covered by the desktop build). Sourcemaps are off in the
// existing build files. It expects apps/desktop/dist/main/*.cjs, every file under
// apps/desktop/dist/renderer and every file under apps/web/dist to be byte-identical with
// identical names. A file that differs is not hidden: it is printed as "DIFFERENCE (explained)"
// when it can be shown to differ in layout only, and the run fails for any other difference (and
// for the explained ones too with --strict-bytes). The explained cases are: dist/main/*.cjs are
// not minified, so esbuild echoes the source's line breaks (compared by minified output and
// comments); Prettier splits JSX text around {' '}, which changes adjacent string children in a
// bundle (the bundles are parsed and compared as syntax trees in which only adjacent strings
// inside a `children` value are merged; any other difference fails); Prettier writes spaces after
// commas inside a css var() fallback; and the content hashes in asset names that follow from the
// last two (compared by stem). If a build ever emitted sourcemaps, .map files are ignored and
// sourceMappingURL comments stripped when bytes differ, and the summary says so. The native
// helper in desktop dist/bin (swiftc, lipo) is compared for information only. --keep-dist <dir>
// copies the dist folders to <dir>/before, <dir>/after, <dir>/before-web and <dir>/after-web.
// Temporary worktrees are always removed. The build runs without GOOGLE_CLIENT_*,
// MICROSOFT_CLIENT_ID and APLOS_RELEASE_BUILD in its environment, so no secret is read.
//
// Landing runbook (restructure chain slot 2, on the branch `revamp` after the engine move):
//   1. Start clean:  git status --short  (empty), npm ci, npm run typecheck && npm test (baseline).
//   2. Format:       npm run format  (run it twice: Prettier member chains are not always stable
//      on the first pass, so repeat until  npm run format:check  exits 0, then make ONE commit)
//      Then  git status --short  must list source files only, and  npm run format:check  exits 0.
//   3. Commit:       git commit -am "[mechanical] Format the tree with Prettier"
//      (author Kainoa Newton <k@kainoa.me>; the commit contains nothing but the format.)
//   4. Prove it with the verifier from the BEFORE commit, so the commit under test cannot judge
//      itself (the script also fails if it differs between the two refs):
//        git show HEAD~1:scripts/audit/format-equivalence.mjs > scripts/audit/.before-check.mjs
//        node scripts/audit/.before-check.mjs --before HEAD~1 --after HEAD --build
//        rm scripts/audit/.before-check.mjs
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
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
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

const VERIFIER = 'scripts/audit/format-equivalence.mjs';

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

/** Comments that mean something to a tool where they stand (not just text). */
const DIRECTIVE =
  /@ts-(?:ignore|expect-error|nocheck|check)|eslint|prettier-ignore|@vite-ignore|[#@]__(?:NO_SIDE_EFFECTS|PURE)__|istanbul|c8 |v8 ignore|@jsx|@refresh|@type\b|@satisfies|webpack[A-Z]|biome-/;

/** True for the {' '} that Prettier writes for significant JSX whitespace (it is not source text). */
const isJsxSpace = node =>
  node.parent?.kind === ts.SyntaxKind.JsxExpression &&
  node.parent.expression &&
  ts.isStringLiteral(node.parent.expression) &&
  !node.parent.expression.text.trim();

/** Comments of a TypeScript or JavaScript source, found through the parser (so regular
 * expressions, strings and JSX text are never mistaken for comments). A directive comment (such as
 * @ts-expect-error or eslint-disable-line) is listed with the two real tokens before it and the
 * four after it, so moving it to another statement counts as a change. Other comments compare by
 * text, because Prettier does move those (for example into a catch block). Parentheses,
 * semicolons and commas are not real tokens here, because Prettier adds and removes them. */
function codeComments(text, extension) {
  const K = ts.SyntaxKind;
  const file = parse(text, extension);
  const leaves = [];
  const collect = node => {
    if (node.kind >= K.FirstJSDocNode && node.kind <= K.LastJSDocNode) return;
    const children = node.getChildren(file);
    if (children.length) return children.forEach(collect);
    if (node.kind !== K.JsxText) leaves.push(node);
  };
  collect(file);
  const quiet = new Set([K.OpenParenToken, K.CloseParenToken, K.SemicolonToken, K.CommaToken]);
  const real = leaf => !quiet.has(leaf.kind) && !isJsxSpace(leaf);
  const tokenId = leaf => leaf.text ?? leaf.kind;
  const starts = new Set();
  const found = [];
  leaves.forEach((leaf, i) => {
    // Comments on the same line as the previous token are "trailing"; the rest are "leading".
    const ranges = [
      ...(ts.getTrailingCommentRanges(text, leaf.pos) ?? []),
      ...(ts.getLeadingCommentRanges(text, leaf.pos) ?? []),
    ];
    for (const range of ranges) {
      if (starts.has(range.pos)) continue;
      starts.add(range.pos);
      const body = normaliseSpace(text.slice(range.pos, range.end));
      if (!DIRECTIVE.test(body)) {
        found.push(body);
        continue;
      }
      const around = (from, step, wanted) => {
        const tokens = [];
        for (let j = from; j >= 0 && j < leaves.length && tokens.length < wanted; j += step) {
          if (real(leaves[j])) tokens.push(tokenId(leaves[j]));
        }
        return tokens;
      };
      const previous = around(i - 1, -1, 2).reverse();
      found.push(`${body}  after: ${previous.join(' ')}  before: ${around(i, 1, 4).join(' ')}`);
    }
  });
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
    if ((b.get(text) ?? 0) < n) problems.push(`comment dropped, altered or moved: ${clip(text)}`);
  }
  for (const [text, n] of b) {
    if ((a.get(text) ?? 0) < n) problems.push(`comment added, altered or moved: ${clip(text)}`);
  }
  return problems;
}

/** Fields that are plain numbers or flags on a node, which ts.forEachChild never visits: ++ vs --,
 * keyof vs readonly, let vs const, import type vs import, and the like. */
function nodeDetails(node) {
  const K = ts.SyntaxKind;
  switch (node.kind) {
    case K.PrefixUnaryExpression:
    case K.PostfixUnaryExpression:
    case K.TypeOperator:
      return `op${node.operator}`;
    case K.VariableDeclarationList:
      return `decl${node.flags & ts.NodeFlags.BlockScoped}`;
    case K.ImportClause:
      return `type:${node.isTypeOnly ?? false}:${node.phaseModifier ?? ''}`;
    case K.ImportSpecifier:
    case K.ExportDeclaration:
    case K.ExportSpecifier:
    case K.ImportEqualsDeclaration:
      return `type:${node.isTypeOnly ?? false}`;
    case K.ExportAssignment:
      return `equals:${node.isExportEquals ?? false}`;
    case K.MetaProperty:
      return `meta${node.keywordToken}`;
    case K.HeritageClause:
      return `heritage${node.token}`;
    case K.ImportType:
      return `typeof:${node.isTypeOf ?? false}`;
    case K.ImportAttributes:
      return `attributes${node.token}`;
    default:
      return '';
  }
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
        if (node.expression && isJsxSpace(node.expression)) return;
        break;
      case K.Identifier:
      case K.PrivateIdentifier:
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
    out.push(`${node.kind}${nodeDetails(node)}`);
    ts.forEachChild(node, visit);
  };
  visit(parse(text, extension));
  return out;
}

/** A flat list describing built or compiled JavaScript. groupOf(node) may name a node whose
 * children are listed with adjacent string literals merged, because Prettier splits JSX text such
 * as " . " into " ." and {' '}; it returns { label, items } or null. */
function jsFingerprint(code, groupOf) {
  const out = [];
  const visit = node => {
    const group = groupOf(node);
    if (group) {
      out.push(group.label);
      let text = null;
      const flush = () => {
        if (text !== null) out.push(`S:${text}`);
        text = null;
      };
      for (const item of group.items) {
        if (ts.isStringLiteralLike(item)) text = (text ?? '') + item.text;
        else {
          flush();
          visit(item);
        }
      }
      flush();
      return;
    }
    const detail = nodeDetails(node);
    if (ts.isStringLiteralLike(node)) out.push(`S:${node.text}`);
    else if (ts.isIdentifier(node) || ts.isNumericLiteral(node))
      out.push(`${node.kind}:${node.text}`);
    else out.push(`${node.kind}${detail}`);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('file.js', code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS));
  return out;
}

/** The compiled form of JSX (React.createElement calls), see jsFingerprint. */
const compiledFingerprint = code =>
  jsFingerprint(code, node =>
    ts.isCallExpression(node) && node.expression.getText() === 'React.createElement'
      ? { label: 'createElement', items: node.arguments }
      : null,
  );

/** A built renderer bundle: the same, for the children of JSX (children: [...] in the output). */
const bundleFingerprint = code =>
  jsFingerprint(code, node => {
    if (!ts.isPropertyAssignment(node)) return null;
    const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
    if (name !== 'children') return null;
    const value = node.initializer;
    return {
      label: 'children',
      items: ts.isArrayLiteralExpression(value) ? value.elements : [value],
    };
  });

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
    // The tree check covers identifiers (a minifier would hide a renamed local) and types.
    const x = treeFingerprint(before, extension);
    const y = treeFingerprint(after, extension);
    if (!sameList(x, y)) problems.push(`syntax tree differs ${firstDifference(x, y)}`);
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

function changedFiles(before, after, allowMoves) {
  const raw = git(['diff', '-M', '--raw', '-z', '--no-abbrev', before, after]).split('\0');
  const files = [];
  for (let i = 0; i < raw.length && raw[i]; i++) {
    const [oldMode, newMode, oldSha, newSha, status] = raw[i].slice(1).split(' ');
    const moved = status[0] === 'R' || status[0] === 'C';
    const oldPath = raw[++i];
    const newPath = moved ? raw[++i] : oldPath;
    files.push({ oldMode, newMode, oldSha, newSha, status, oldPath, newPath });
  }
  return allowMoves ? pairByName(files) : files;
}

/** Only with --allow-moves. A move combined with a format leaves too little in common for git's rename detection. A deleted
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

function checkFiles(before, after, allowMoves) {
  const counts = new Map();
  const failures = [];
  const notes = [];
  let unchangedContent = 0;
  const files = changedFiles(before, after, allowMoves);
  for (const file of files) {
    const name = file.newPath;
    const fail = message => failures.push(`${name}: ${message}`);
    if (file.status === 'R0') notes.push(`${file.oldPath} -> ${name}: paired by file name`);
    else if (/^R/.test(file.status) && allowMoves) notes.push(`${file.oldPath} -> ${name}: moved`);
    if (/^[RC]/.test(file.status) && !allowMoves) {
      fail(
        `${file.status === 'R100' ? 'moved' : 'moved or copied'} from ${file.oldPath} (a format commit has no renames; --allow-moves accepts them)`,
      );
      continue;
    }
    if (!/^[MR]/.test(file.status)) {
      fail(`status ${file.status} (added, deleted or type-changed files are not a format change)`);
      continue;
    }
    if (file.oldMode !== file.newMode) {
      fail(`mode changed ${file.oldMode} -> ${file.newMode}`);
      continue;
    }
    // The type is checked first, so a pure rename cannot hide a file leaving its folder's globs
    // or changing its extension.
    const type = kindOf(file.newPath);
    const oldType = kindOf(file.oldPath);
    if (
      !type ||
      !oldType ||
      type.label !== oldType.label ||
      extname(file.oldPath) !== extname(name)
    ) {
      fail(`file type cannot be proven equivalent (${extname(name) || name})`);
      continue;
    }
    if (file.oldSha === file.newSha) {
      unchangedContent++;
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
  // The website is formatted too and the desktop build does not cover it.
  run('npm', ['run', 'web:build'], { cwd: dir, env });
  return { desktop: join(dir, 'apps', 'desktop', 'dist'), web: join(dir, 'apps', 'web', 'dist') };
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

/** Vite names assets name-HASH.ext with an 8 character hash of the content. */
const HASHED = /-[A-Za-z0-9_-]{8}(?=\.[a-z0-9]+$)/;
const stemOf = name => name.replace(HASHED, '-[hash]');

function readBuilt(path, name, state) {
  let text = readFileSync(path, 'utf8');
  const stripped = text.replace(/^\/\/# sourceMappingURL=.*$|\/\*# sourceMappingURL=.*?\*\//gm, '');
  if (stripped !== text) state.stripped++;
  text = stripped;
  return text;
}

/** Why two built files that differ in bytes still mean the same thing, or null if they do not. */
function layoutOnlyReason(kind, a, b) {
  if (kind === 'main') {
    // esbuild does not minify the main bundles, so it echoes the source's line breaks.
    const same = minify(a, 'js') === minify(b, 'js');
    const comments = !diffMultisets(codeComments(a, '.js'), codeComments(b, '.js')).length;
    return same && comments
      ? 'line breaks follow the source layout; minified output and comments identical'
      : null;
  }
  if (kind === 'js') {
    // Both bundles are parsed; only adjacent strings inside a `children` array or value may be
    // split differently (Prettier writes {" "} next to JSX text). Everything else must match.
    return sameList(bundleFingerprint(a), bundleFingerprint(b))
      ? 'JSX text split into adjacent string children (Prettier writes {" "}); everything else identical'
      : null;
  }
  if (kind === 'css') {
    const prepared = text => text.replace(/\s*,\s*/g, ',');
    return prepared(a) === prepared(b) ? 'spaces after commas inside var() fallbacks only' : null;
  }
  return null;
}

function compareBuilds(distBefore, distAfter) {
  const failures = [];
  const info = [];
  const explained = [];
  const state = { stripped: 0, ignoredMaps: 0 };
  // [title, which build, folder in its dist, file filter, whether a difference fails]
  const sets = [
    ['desktop dist/main/*.cjs', 'desktop', 'main', name => name.endsWith('.cjs'), true],
    ['desktop dist/renderer', 'desktop', 'renderer', () => true, true],
    ['desktop dist/bin (native helper, information only)', 'desktop', 'bin', () => true, false],
    ['website dist', 'web', '', () => true, true],
  ];
  let identical = 0;
  for (const [title, which, folder, filter, strict] of sets) {
    const prefix = which === 'web' ? 'web' : folder;
    const list = dist =>
      listFiles(join(dist[which], folder)).filter(name => {
        if (name.endsWith('.map')) {
          state.ignoredMaps++;
          return false;
        }
        return filter(name);
      });
    const a = list(distBefore);
    const b = list(distAfter);
    const bByStem = new Map(b.map(name => [stemOf(name), name]));
    const aStems = new Set(a.map(stemOf));
    // Content-hashed names are paired by their stem; references to the hashed names inside files
    // are rewritten to the stem before comparing.
    const hashes = [...a, ...b].filter(name => stemOf(name) !== name);
    const unhash = text =>
      hashes.reduce(
        (t, name) => t.split(name.split('/').pop()).join(stemOf(name.split('/').pop())),
        text,
      );
    for (const nameA of a) {
      const nameB = bByStem.get(stemOf(nameA));
      const report = problem => (strict ? failures : info).push(`${title}: ${problem}`);
      if (!nameB) {
        report(`only in before: ${prefix}/${nameA}`);
        continue;
      }
      const pathA = join(distBefore[which], folder, nameA);
      const pathB = join(distAfter[which], folder, nameB);
      if (nameA === nameB && readFileSync(pathA).equals(readFileSync(pathB))) {
        identical++;
        continue;
      }
      const ext = extname(nameA);
      const kind =
        folder === 'main' ? 'main' : ext === '.js' ? 'js' : ext === '.css' ? 'css' : null;
      const shown = name => `${prefix}/${name}`;
      let reason = null;
      if (kind || ext === '.html') {
        const textA = unhash(readBuilt(pathA, nameA, state));
        const textB = unhash(readBuilt(pathB, nameB, state));
        reason =
          textA === textB
            ? 'names differ only by content hash'
            : layoutOnlyReason(kind, textA, textB);
      }
      if (reason) {
        explained.push(`${shown(nameA)}${nameA === nameB ? '' : ` -> ${shown(nameB)}`}: ${reason}`);
      } else report(`bytes differ and cannot be explained: ${shown(nameA)}`);
    }
    for (const nameB of b) {
      if (!aStems.has(stemOf(nameB))) {
        (strict ? failures : info).push(`${title}: only in after: ${prefix}/${nameB}`);
      }
    }
  }
  return { failures, info, identical, explained, state };
}

function buildComparison(before, after, keepDir) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'aplos-format-equivalence-'));
  const created = [];
  try {
    created.push('before');
    const distBefore = buildRef(before, tempRoot, 'before');
    created.push('after');
    const distAfter = buildRef(after, tempRoot, 'after');
    if (keepDir) {
      for (const which of ['desktop', 'web']) {
        const suffix = which === 'web' ? '-web' : '';
        cpSync(distBefore[which], join(keepDir, `before${suffix}`), { recursive: true });
        cpSync(distAfter[which], join(keepDir, `after${suffix}`), { recursive: true });
      }
    }
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
      'usage: node scripts/audit/format-equivalence.mjs --before <ref> --after <ref> [--allow-moves] [--build [--keep-dist <dir>] [--strict-bytes]]',
    );
    process.exit(2);
  }
  const resolved = ref => git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  const beforeSha = resolved(before);
  const afterSha = resolved(after);
  console.log(`before ${before} (${beforeSha.slice(0, 10)})`);
  console.log(`after  ${after} (${afterSha.slice(0, 10)})`);

  const allowMoves = args.includes('--allow-moves');
  const result = checkFiles(beforeSha, afterSha, allowMoves);
  const failures = [...result.failures];
  // The verifier must not be changed by the commit it judges (it lives inside the format globs).
  try {
    git(['diff', '--quiet', beforeSha, afterSha, '--', VERIFIER]);
  } catch {
    failures.unshift(
      `${VERIFIER} differs between the two refs, so this run cannot be trusted; run the copy from the before ref (see the runbook)`,
    );
  }
  let explained = 0;
  console.log(
    `\nchanged files: ${result.total}${allowMoves ? ` (${result.unchangedContent} pure renames)` : ''}`,
  );
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
      const build = buildComparison(
        beforeSha,
        afterSha,
        args.includes('--keep-dist') ? resolve(value('--keep-dist')) : null,
      );
      console.log(`build: ${build.identical} files byte-identical`);
      explained = build.explained.length;
      for (const line of build.explained) console.log(`  DIFFERENCE (explained): ${line}`);
      if (build.state.stripped) {
        console.log(`  stripped sourceMappingURL comments in ${build.state.stripped} file reads`);
      }
      if (build.state.ignoredMaps) console.log(`  ignored ${build.state.ignoredMaps} .map files`);
      for (const line of build.info) console.log(`  info: ${line}`);
      failures.push(...build.failures.map(line => `build: ${line}`));
      if (args.includes('--strict-bytes')) {
        failures.push(...build.explained.map(line => `build (strict bytes): ${line}`));
      }
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
  console.log(`\nPASS: ${explained} explained build difference(s), no other differences`);
}

main();
