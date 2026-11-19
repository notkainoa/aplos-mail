#!/usr/bin/env node
// Test command for the mutation scorer, run inside the Stryker sandbox. Stryker symlinks
// node_modules into the sandbox, so `node_modules/@aplos/engine` still resolves to the real,
// unmutated workspace source and every mutant would survive. This wrapper rewrites that one
// scope of links before running the tests:
//
//   - node_modules becomes a real directory of links into the real node_modules,
//   - except node_modules/@aplos/*, which point at the sandbox's own apps/ and packages/ copies.
//
// Then it runs the repo's test runner (node --import tsx --test, or scripts/audit/
// electron-node.mjs for --runner electron-node) and exits with its code.
//   node scripts/audit/hillclimb/scorers/stryker-run.mjs [--runner node|electron-node]
//
// The test file list is NOT an argument: the mutation scorer invokes this wrapper through
// Stryker's command runner, which executes the command in a shell, so a file name with a
// space, `$` or `;` would break or inject. The scorer writes the list as JSON to a per-run
// file and puts its path in the TESTS_FILE_ENV environment variable instead.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_SCOPE = '@aplos';
// Env var carrying the absolute path of the JSON test-file list the mutation scorer wrote.
export const TESTS_FILE_ENV = 'HILLCLIMB_STRYKER_TESTS_FILE';

/**
 * Replaces the sandbox's `node_modules` symlink with a real directory linking back to the real
 * one, except for the workspace scope which is pointed at the sandbox copies. A real
 * node_modules directory (an earlier fix, or a fully copied sandbox) is left alone.
 */
export function fixWorkspaceLinks(cwd) {
  const nodeModules = join(cwd, 'node_modules');
  if (!existsSync(nodeModules) || !lstatSync(nodeModules).isSymbolicLink()) return false;
  const realNodeModules = resolve(cwd, readlinkSync(nodeModules));
  rmSync(nodeModules);
  rebuild(cwd, nodeModules, realNodeModules);
  return true;
}

function rebuild(cwd, nodeModules, realNodeModules) {
  const realRoot = dirname(realNodeModules);
  mkdirSync(nodeModules, { recursive: true });
  for (const entry of readdirSync(realNodeModules)) {
    if (entry === WORKSPACE_SCOPE) continue;
    symlinkSync(join(realNodeModules, entry), join(nodeModules, entry), 'dir');
  }
  const realScope = join(realNodeModules, WORKSPACE_SCOPE);
  if (!existsSync(realScope)) return;
  mkdirSync(join(nodeModules, WORKSPACE_SCOPE), { recursive: true });
  for (const pkg of readdirSync(realScope)) {
    const realTarget = resolve(realScope, readlinkSync(join(realScope, pkg)));
    // Every workspace package lives under apps/ or packages/ at the same repo-relative path in
    // the sandbox copy, so the relative link reads <sandbox>/<workspace path>.
    const sandboxCopy = join(cwd, relative(realRoot, realTarget));
    const link = relative(join(nodeModules, WORKSPACE_SCOPE), sandboxCopy);
    symlinkSync(link, join(nodeModules, WORKSPACE_SCOPE, pkg), 'dir');
  }
}

/** The test runner argv for the sandbox cwd: plain node, or Electron's Node via the wrapper. */
export function runnerArgs(runner, files) {
  if (runner === 'electron-node') {
    return [join('scripts', 'audit', 'electron-node.mjs'), '--import', 'tsx', '--test', ...files];
  }
  return ['--import', 'tsx', '--test', ...files];
}

/** The test file list from the JSON document TESTS_FILE_ENV points at; never from argv. */
export function testFiles(env = process.env) {
  const file = env[TESTS_FILE_ENV];
  if (!file) {
    console.error(`stryker-run: ${TESTS_FILE_ENV} is not set`);
    process.exit(2);
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    console.error(`stryker-run: ${TESTS_FILE_ENV} does not point at a readable JSON list`);
    process.exit(2);
  }
}

function main(argv) {
  let runner = 'node';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runner') runner = argv[++i];
    else {
      console.error(`stryker-run: unexpected argument ${argv[i]}`);
      process.exit(2);
    }
  }
  if (!['node', 'electron-node'].includes(runner)) {
    console.error(`stryker-run: unknown runner ${runner}`);
    process.exit(2);
  }
  const files = testFiles();
  const cwd = process.cwd();
  fixWorkspaceLinks(cwd);
  // ELECTRON_RUN_AS_NODE would make the plain-node path spawn Electron's Node anyway; the
  // electron-node runner sets it itself.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(process.execPath, runnerArgs(runner, files), {
    cwd,
    stdio: 'inherit',
    env,
  });
  process.exit(run.status ?? 1);
}

// The module loader realpaths argv[1] (macOS /tmp -> /private/tmp): compare real to real, or a
// wrapper reached through a symlinked path would exit without ever running the tests.
if (process.argv[1] && resolve(realpathSync(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
