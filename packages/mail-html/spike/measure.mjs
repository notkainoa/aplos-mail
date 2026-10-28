#!/usr/bin/env node
// html-1 parser spike: measures each candidate HTML parser and CSS tokenizer by bundle bytes,
// licence (every transitive dependency) and correctness on the first 20 corpus messages.
// Deleted when html-3 lands; the choice is recorded in DECISIONS.md.
//
// Usage (repo root): node packages/mail-html/spike/measure.mjs [--from <dir>] [--corpus <dir>]
//   --from    a node_modules parent holding the candidates that are not repo dependencies
//             (a scratch dir outside the repo with `npm i postcss css-tree`); the repo is searched first
//   --corpus  the corpus folder (manifest.json + messages/); default packages/mail-html/corpus

import { build } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');

function option(name, fallback) {
  const at = process.argv.indexOf(name);
  return at > 0 ? resolve(process.argv[at + 1]) : fallback;
}

const dirs = [join(repo, 'packages/mail-html'), repo, option('--from', repo)];
const corpusDir = option('--corpus', join(repo, 'packages/mail-html/corpus'));
const ALLOWED_LICENCES = new Set([
  'MIT',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'ISC',
  '0BSD',
]);
const FIRST = 20;

// What the sanitizer needs from each library: parse + serialize for HTML, tokenize + stringify for CSS.
const candidates = [
  {
    name: 'parse5',
    kind: 'html',
    entry: "import { parse, serialize } from 'parse5'; export { parse, serialize };",
  },
  {
    name: 'htmlparser2',
    kind: 'html',
    entry: "import { parseDocument } from 'htmlparser2'; export { parseDocument };",
  },
  {
    name: '@csstools/css-tokenizer',
    kind: 'css',
    entry:
      "import { tokenize, stringify } from '@csstools/css-tokenizer'; export { tokenize, stringify };",
  },
  { name: 'postcss', kind: 'css', entry: "import postcss from 'postcss'; export default postcss;" },
  { name: 'css-tree', kind: 'css', entry: "import * as t from 'css-tree'; export default t;" },
  {
    name: 'htmlparser2',
    label: 'chosen pair (htmlparser2 + @csstools/css-tokenizer)',
    kind: 'package',
    entry:
      "import { parseDocument } from 'htmlparser2'; import { tokenize } from '@csstools/css-tokenizer'; export { parseDocument, tokenize };",
  },
];

function where(name) {
  return dirs.find(dir => existsSync(join(dir, 'node_modules', name, 'package.json')));
}

async function bundleBytes(entry, from, minify) {
  try {
    const out = await build({
      stdin: { contents: entry, resolveDir: from, loader: 'js' },
      bundle: true,
      platform: 'neutral',
      format: 'esm',
      mainFields: ['module', 'main'],
      minify,
      write: false,
      logLevel: 'silent',
    });
    return out.outputFiles[0].contents.byteLength;
  } catch (error) {
    return `fails on platform neutral (${error.errors?.[0]?.text ?? error.message})`;
  }
}

// npm hoists every dependency here, so `node_modules/<name>/package.json` is the installed copy.
function licences(name, seen = new Map()) {
  const from = where(name);
  const pkg = JSON.parse(readFileSync(join(from, 'node_modules', name, 'package.json'), 'utf8'));
  if (seen.has(`${name}@${pkg.version}`)) return seen;
  const licence = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license);
  seen.set(`${name}@${pkg.version}`, licence);
  for (const dep of Object.keys(pkg.dependencies ?? {})) licences(dep, seen);
  return seen;
}

function loadFirstMessages() {
  const manifestFile = join(corpusDir, 'manifest.json');
  if (!existsSync(manifestFile)) return [];
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  return manifest
    .filter(entry => entry.html)
    .slice(0, FIRST)
    .map(entry => ({ id: entry.id, html: readFileSync(join(corpusDir, entry.html), 'utf8') }));
}

async function importFrom(name) {
  const require = createRequire(join(where(name), 'node_modules', '_'));
  return import(pathToFileURL(require.resolve(name)).href);
}

// The reference tree: parse5 implements the WHATWG tree construction Chromium uses, so a
// candidate is correct on a message when Chromium would rebuild the same tree from its output.
function shape(parse5, html) {
  return parse5.serialize(parse5.parse(html));
}

function parse5Correctness(messages, parse5) {
  return messages.map(({ id, html }) => {
    const out = parse5.serialize(parse5.parse(html));
    return { id, same: shape(parse5, out) === shape(parse5, html) };
  });
}

async function htmlparser2Correctness(messages, parse5) {
  const { parseDocument } = await importFrom('htmlparser2');
  const { default: render } = await importFrom('dom-serializer');
  return messages.map(({ id, html }) => {
    try {
      const out = render(parseDocument(html), { decodeEntities: false });
      return { id, same: shape(parse5, out) === shape(parse5, html) };
    } catch (error) {
      return { id, same: false, error: String(error) };
    }
  });
}

function styleSources(html) {
  const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]);
  const attrs = [...html.matchAll(/style\s*=\s*"([^"]*)"/gi)].map(m => m[1]);
  return [...blocks, ...attrs];
}

// A CSS tokenizer is correct on a message when stringify(tokenize(css)) gives the input back
// byte for byte (nothing silently lost) and it sees every url(), image-set() and @import there.
async function cssCorrectness(messages) {
  const { tokenize, stringify, TokenType } = await importFrom('@csstools/css-tokenizer');
  return messages.map(({ id, html }) => {
    const sources = styleSources(html);
    let lossless = true;
    let found = 0;
    for (const css of sources) {
      const tokens = tokenize({ css });
      if (stringify(...tokens) !== css) lossless = false;
      found += tokens.filter(
        t =>
          t[0] === TokenType.URL ||
          t[0] === TokenType.AtKeyword ||
          (t[0] === TokenType.Function && /url|image-set|src/i.test(t[4].value)),
      ).length;
    }
    return { id, styles: sources.length, lossless, found };
  });
}

// Best of five, because the shared machine's load swings single runs by 10x or more.
function bestMs(fn, html) {
  let best = Infinity;
  for (let run = 0; run < 5; run++) {
    const start = performance.now();
    fn(html);
    best = Math.min(best, performance.now() - start);
  }
  return best.toFixed(1);
}

const SPEED_INPUTS = [
  ['1 MB of text', `<p>${'a'.repeat(1_000_000)}`],
  ['1 MB of words', `<p>${'ab cd '.repeat(170_000)}`],
  ['1,000 nested divs', '<div>'.repeat(1000)],
  ['2,000 nested divs', '<div>'.repeat(2000)],
];

async function speed() {
  const { parse } = await importFrom('parse5');
  const { parseDocument } = await importFrom('htmlparser2');
  console.log('parse time, best of 5 (ms):');
  for (const [name, html] of SPEED_INPUTS) {
    console.log(
      `- ${name}: parse5 ${bestMs(parse, html)}, htmlparser2 ${bestMs(parseDocument, html)}`,
    );
  }
}

function summarise(rows) {
  const passed = rows.filter(row => row.same).length;
  const failed = rows.filter(row => !row.same).map(row => row.id);
  return `${passed}/${rows.length} rebuild the spec tree${failed.length ? ` (differ: ${failed.join(', ')})` : ''}`;
}

async function main() {
  console.log(`candidates from ${[...new Set(dirs)].join(' and ')}`);
  for (const candidate of candidates) {
    const from = where(candidate.name);
    if (!from) {
      console.log(`- ${candidate.name}: not installed, skipped`);
      continue;
    }
    const plain = await bundleBytes(candidate.entry, from, false);
    const minified = await bundleBytes(candidate.entry, from, true);
    const deps = [...licences(candidate.name)].map(([dep, licence]) => {
      const ok = ALLOWED_LICENCES.has(licence) ? '' : ' NOT ALLOWED';
      return `${dep} ${licence}${ok}`;
    });
    console.log(
      `- ${candidate.label ?? candidate.name} (${candidate.kind}): ${plain} bytes, ${minified} minified`,
    );
    console.log(`  licences: ${deps.join('; ')}`);
  }

  await speed();
  const messages = loadFirstMessages();
  if (messages.length === 0) {
    console.log(`no corpus at ${corpusDir}; correctness skipped`);
    return;
  }
  const parse5 = await importFrom('parse5');
  console.log(`correctness on the first ${messages.length} corpus messages:`);
  console.log(`- parse5: ${summarise(parse5Correctness(messages, parse5))}`);
  if (where('htmlparser2') && where('dom-serializer')) {
    console.log(`- htmlparser2: ${summarise(await htmlparser2Correctness(messages, parse5))}`);
  }
  if (where('@csstools/css-tokenizer')) {
    const css = await cssCorrectness(messages);
    const lossless = css.filter(row => row.lossless).length;
    const urls = css.reduce((sum, row) => sum + row.found, 0);
    const styled = css.filter(row => row.styles > 0).length;
    console.log(
      `- @csstools/css-tokenizer: ${lossless}/${css.length} lossless round trips, ${urls} url/image-set/@-rules seen in ${styled} styled messages`,
    );
  }
}

await main();
