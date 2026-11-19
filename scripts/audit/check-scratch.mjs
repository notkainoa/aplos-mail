#!/usr/bin/env node
// Raw-scratch usage check. Usage:
//   node scripts/audit/check-scratch.mjs [--strict] [--update-baseline]
// Scans test files (apps/*/tests/**, apps/*/src/**/*.test.*, packages/*/tests/**, tests/**,
// scripts/**/*.test.*) for scratch dirs created by hand: mkdtemp(/mkdtempSync( whose argument
// involves tmpdir(), or mkdir/mkdirSync of an "aplos" path under tmpdir(). A file passes when it
// imports the shared helper (scripts/audit/scratch.mjs) or pairs every mkdtemp with a recursive
// rm call — the heuristic is deliberately simple.
// Default mode only reports: it prints "check:scratch: N file(s) create scratch dirs without
// cleanup" plus the first 15 offenders and exits 0. --strict exits 1 when a flagged file is not
// in scripts/audit/scratch-baseline.json (the committed list of files allowed to lag), so new
// tests must use the helper or clean up. --update-baseline rewrites that list.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceExt = /\.[cm]?[jt]sx?$/;
const testName = /\.test\.[cm]?[jt]sx?$/;
// The helper files themselves are allowed to touch tmpdir() directly.
const ownFiles = /^scripts\/audit\/scratch[^/]*\.mjs$/;
const maxReported = 15;

/** All files under `dir`, recursively, skipping node_modules. Missing dirs yield []. */
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** Repo-relative paths (posix separators) of every test file the check scans, sorted. */
export function collectTestFiles(root) {
  const files = [];
  for (const base of ['apps', 'packages']) {
    let children;
    try {
      children = readdirSync(join(root, base), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory() || child.name === 'node_modules') continue;
      files.push(...walk(join(root, base, child.name, 'tests')).filter(f => sourceExt.test(f)));
      files.push(...walk(join(root, base, child.name, 'src')).filter(f => testName.test(f)));
    }
  }
  files.push(...walk(join(root, 'tests')).filter(f => sourceExt.test(f)));
  files.push(...walk(join(root, 'scripts')).filter(f => testName.test(f)));
  return files
    .map(file => relative(root, file).split(sep).join('/'))
    .filter(file => !ownFiles.test(file))
    .sort();
}

// The text between a call's open paren and its matching close paren (capped, so a malformed
// file cannot send the scan to the end of the file).
function callArgs(text, openParen) {
  let depth = 0;
  const end = Math.min(text.length, openParen + 500);
  for (let i = openParen; i < end; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return text.slice(openParen, i);
    }
  }
  return text.slice(openParen, end);
}

const tmpdirCall = /\btmpdir\s*\(/;

/** True when the file creates tmpdir scratch dirs by hand (mkdtemp, or mkdir of an aplos path). */
export function createsRawScratch(text) {
  for (const match of text.matchAll(/\b(mkdtempSync|mkdtemp|mkdirSync|mkdir)\s*\(/g)) {
    const args = callArgs(text, match.index + match[0].length - 1);
    const isMkdtemp = match[1].startsWith('mkdtemp');
    if (tmpdirCall.test(args) && (isMkdtemp || /aplos/i.test(args))) return true;
  }
  return false;
}

const helperImport = /from\s+['"][^'"]*scratch\.mjs['"]/;
const mkdtempUse = /\bmkdtemp(Sync)?\s*\(/;
const recursiveRm = /\brm(Sync)?\s*\([\s\S]{0,400}?recursive\s*:\s*true/;

/** True when the file either uses the shared helper or pairs mkdtemp with a recursive rm. */
export function isCompliant(text) {
  return helperImport.test(text) || (mkdtempUse.test(text) && recursiveRm.test(text));
}

/** Repo-relative paths of the scanned test files that create scratch dirs without cleanup. */
export function findNonCompliant(root) {
  return collectTestFiles(root).filter(file => {
    const text = readFileSync(join(root, file), 'utf8');
    return createsRawScratch(text) && !isCompliant(text);
  });
}

export function readBaseline(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function run(root, options = {}) {
  const baselineFile = join(root, 'scripts', 'audit', 'scratch-baseline.json');
  const files = findNonCompliant(root);
  if (options.updateBaseline) {
    writeFileSync(baselineFile, `${JSON.stringify(files, null, 2)}\n`);
    console.log(`check:scratch: baseline updated with ${files.length} file(s)`);
    return 0;
  }
  if (!options.strict) {
    console.log(`check:scratch: ${files.length} file(s) create scratch dirs without cleanup`);
    for (const file of files.slice(0, maxReported)) console.log(`  ${file}`);
    return 0;
  }
  const allowed = new Set(readBaseline(baselineFile));
  const offenders = files.filter(file => !allowed.has(file));
  console.log(
    `check:scratch: ${offenders.length} new file(s) create scratch dirs without cleanup` +
      ` (${files.length} flagged, ${allowed.size} in baseline)`,
  );
  for (const file of offenders.slice(0, maxReported)) console.log(`  ${file}`);
  return offenders.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  const unknown = [...args].filter(arg => !['--strict', '--update-baseline'].includes(arg));
  if (unknown.length > 0) {
    console.error(`check-scratch: unknown argument ${unknown[0]}`);
    console.error('usage: node scripts/audit/check-scratch.mjs [--strict] [--update-baseline]');
    process.exit(2);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  process.exit(
    run(root, { strict: args.has('--strict'), updateBaseline: args.has('--update-baseline') }),
  );
}
