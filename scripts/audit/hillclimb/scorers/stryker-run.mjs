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
//   node scripts/audit/hillclimb/scorers/stryker-run.mjs [--runner node|electron-node] <files...>
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_SCOPE = '@aplos';

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

function main(argv) {
  let runner = 'node';
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runner') runner = argv[++i];
    else files.push(argv[i]);
  }
  if (!['node', 'electron-node'].includes(runner)) {
    console.error(`stryker-run: unknown runner ${runner}`);
    process.exit(2);
  }
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
