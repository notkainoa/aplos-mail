#!/usr/bin/env node
// Standalone design lint.
//   node tools/lint/design/run.mjs [paths...] [--rule <id>]... [--json] [--no-ignore]
// With no paths it lints the default scope from config.mjs. Exits 1 on any
// violation, 0 when clean, 2 on a usage error.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { exclude, include, repoRoot } from './config.mjs';
import { kindOfPath } from './lib/context.mjs';
import { matchesAny, staticPrefix, walk } from './lib/glob.mjs';
import { lintFile } from './lib/lint.mjs';
import { rules as allRules, ruleById } from './rules/index.mjs';

function toRepoRelative(file) {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

export function defaultFiles() {
  const files = [];
  for (const glob of include) {
    const root = path.join(repoRoot, staticPrefix(glob));
    if (!fs.existsSync(root)) continue;
    for (const file of walk(root)) {
      if (matchesAny(toRepoRelative(file), [glob])) files.push(file);
    }
  }
  return files;
}

function expand(inputs, cwd) {
  const files = [];
  for (const input of inputs) {
    const full = path.resolve(cwd, input);
    if (!fs.existsSync(full)) throw new Error(`No such file or directory: ${input}`);
    if (fs.statSync(full).isDirectory()) files.push(...walk(full).filter(file => kindOfPath(file)));
    else files.push(full);
  }
  return files;
}

export function selectFiles({ inputs, cwd = process.cwd(), noIgnore = false }) {
  const files = inputs.length > 0 ? expand(inputs, cwd) : defaultFiles();
  return files
    .filter(file => kindOfPath(file))
    .filter(file => noIgnore || !matchesAny(toRepoRelative(file), exclude))
    .sort();
}

export function parseArgs(argv) {
  const options = { inputs: [], rules: [], json: false, noIgnore: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--no-ignore') options.noIgnore = true;
    else if (arg === '--rule') {
      i += 1;
      options.rules.push(argv[i]);
    } else if (arg.startsWith('--rule=')) options.rules.push(arg.slice('--rule='.length));
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else options.inputs.push(arg);
  }
  return options;
}

export function run(
  argv,
  { cwd = process.cwd(), out = line => process.stdout.write(`${line}\n`) } = {},
) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    out(error.message);
    return 2;
  }
  const unknown = options.rules.filter(id => !id || !ruleById(id));
  if (unknown.length > 0) {
    out(`Unknown rule: ${unknown.join(', ')}. Known rules: ${allRules.map(r => r.id).join(', ')}`);
    return 2;
  }
  const rules = options.rules.length > 0 ? options.rules.map(ruleById) : allRules;
  let files;
  try {
    files = selectFiles({ inputs: options.inputs, cwd, noIgnore: options.noIgnore });
  } catch (error) {
    out(error.message);
    return 2;
  }
  const results = [];
  for (const file of files) {
    for (const item of lintFile(file, rules)) {
      results.push({ file: path.relative(cwd, file) || file, ...item });
    }
  }
  if (options.json) {
    out(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) out(`${r.file}:${r.line}:${r.column} ${r.rule} ${r.message}`);
    if (results.length > 0)
      out(
        `\n${results.length} design lint violation${results.length === 1 ? '' : 's'} in ${new Set(results.map(r => r.file)).size} file(s).`,
      );
  }
  return results.length > 0 ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  process.exitCode = run(process.argv.slice(2));
}
