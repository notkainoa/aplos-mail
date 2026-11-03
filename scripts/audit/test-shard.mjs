#!/usr/bin/env node
// Unit-test sharding for CI. Usage:
//   node scripts/audit/test-shard.mjs <workspace-dir> <shard>/<of> [--script <name>] [--run]
// Reads <workspace-dir>/package.json, takes the glob patterns after `--test` in scripts.test (or scripts.<name> with --script),
// expands them the way the test runner does, sorts the file list and keeps the files of one
// deterministic shard (every of-th file, starting at index shard - 1). Without --run the
// shard's files print one per line; with --run the workspace's own test command runs on just
// those files, so `npm test` and the shards together run exactly the same set. Assumes
// scripts.test is `<command> --test <patterns...>` with nothing after the patterns.
import { spawnSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A shell-ish word split: whitespace separates, "double" and 'single' quotes group. */
export function shellWords(command) {
  const words = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(command)) !== null) {
    words.push(match[1] ?? match[2] ?? match[3]);
  }
  return words;
}

/** The argv of a `scripts.<script>` command (default test): runner words up to --test, then the glob patterns. */
export function testCommand(packageJson, script = 'test') {
  const command = packageJson?.scripts?.[script];
  if (typeof command !== 'string') throw new Error(`package.json has no scripts.${script}`);
  const words = shellWords(command);
  const at = words.indexOf('--test');
  if (at === -1) throw new Error(`scripts.${script} has no --test flag: ${command}`);
  const patterns = words.slice(at + 1);
  if (patterns.length === 0) throw new Error(`scripts.${script} has no patterns: ${command}`);
  return { runner: words.slice(0, at + 1), patterns };
}

/** Every test file the patterns match under `dir`: sorted, deduplicated, forward slashes. */
export function listTestFiles(dir, patterns) {
  const files = new Set();
  for (const pattern of patterns) {
    for (const file of globSync(pattern, { cwd: dir })) {
      files.add(file.split('\\').join('/'));
    }
  }
  return [...files].sort();
}

/** `count` shard lists: the file at index i lands in shard (i % count) + 1. */
export function partition(files, count) {
  const shards = Array.from({ length: count }, () => []);
  files.forEach((file, index) => shards[index % count].push(file));
  return shards;
}

/** Parses "2/3" into { shard: 2, of: 3 }; shards count from 1. */
export function parseShard(text) {
  const match = /^(\d+)\/(\d+)$/.exec(text ?? '');
  if (!match) throw new Error(`shard must look like <number>/<of>, got ${JSON.stringify(text)}`);
  const shard = Number(match[1]);
  const of = Number(match[2]);
  if (shard < 1 || shard > of) throw new Error(`shard ${text} is out of range`);
  return { shard, of };
}

/** The sorted file list of one shard of a workspace's scripts.test. */
export function shardFiles(dir, shard, of, script = 'test') {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const { patterns } = testCommand(pkg, script);
  return partition(listTestFiles(dir, patterns), of)[shard - 1];
}

function scriptName(value) {
  if (value === undefined || value.startsWith('--'))
    throw new Error('--script needs a script name');
  return value;
}

/** Splits argv into the --run flag, the --script <name> option and the positional arguments. */
export function parseArgs(args) {
  const positional = [];
  let run = false;
  let script = 'test';
  for (let at = 0; at < args.length; at++) {
    if (args[at] === '--run') run = true;
    else if (args[at] === '--script') script = scriptName(args[++at]);
    else positional.push(args[at]);
  }
  return { run, script, positional };
}

function main() {
  const args = process.argv.slice(2);
  const { run, script, positional } = parseArgs(args);
  const [dir = '.', shardText] = positional;
  const { shard, of } = parseShard(shardText);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const { runner, patterns } = testCommand(pkg, script);
  const all = listTestFiles(dir, patterns);
  const files = partition(all, of)[shard - 1];
  if (!run) {
    for (const file of files) console.log(file);
    return;
  }
  if (files.length === 0) {
    console.error(`shard ${shard}/${of} has no test files; the split is misconfigured`);
    process.exit(1);
  }
  console.error(`shard ${shard}/${of}: ${files.length} of ${all.length} files`);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const bins = [join(root, 'node_modules', '.bin'), join(dir, 'node_modules', '.bin')];
  const env = { ...process.env, PATH: [...bins, process.env.PATH].join(delimiter) };
  const child = spawnSync(runner[0], [...runner.slice(1), ...files], {
    cwd: dir,
    env,
    stdio: 'inherit',
  });
  if (child.error) {
    console.error(`test-shard.mjs: failed to start ${runner[0]}: ${child.error.message}`);
    process.exit(1);
  }
  process.exit(child.status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`test-shard.mjs: ${error.message}`);
    process.exit(2);
  }
}
