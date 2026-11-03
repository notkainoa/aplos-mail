import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  listTestFiles,
  parseArgs,
  parseShard,
  partition,
  shardFiles,
  shellWords,
  testCommand,
} from '../test-shard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const script = join(here, '..', 'test-shard.mjs');
const temps = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'test-shard-'));
  temps.push(dir);
  return dir;
};
after(() => temps.forEach(dir => rmSync(dir, { recursive: true, force: true })));

const touch = (dir, file) => {
  mkdirSync(join(dir, dirname(file)), { recursive: true });
  writeFileSync(join(dir, file), '');
};

const fixtureTest = 'tsx --test "tests/*.test.ts" \'tests/*/**/*.test.mjs\' tests/deep/*.test.ts';
const fixtureFiles = [
  'tests/a.test.ts',
  'tests/b.test.ts',
  'tests/deep/d.test.ts',
  'tests/deep/e.test.ts',
  'tests/sub/c.test.mjs',
];

// A workspace whose scripts.test mixes quoted and unquoted patterns.
const workspace = () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: fixtureTest } }));
  for (const file of [
    ...fixtureFiles,
    'tests/f.test.tsx', // not matched by *.test.ts
    'tests/notes.txt',
  ])
    touch(dir, file);
  return dir;
};

const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts'];

describe('test-shard command parsing', () => {
  it('splits words on whitespace and keeps quoted parts together', () => {
    assert.deepEqual(shellWords('tsx --test "a b" \'c\'  d/*.test.ts'), [
      'tsx',
      '--test',
      'a b',
      'c',
      'd/*.test.ts',
    ]);
  });

  it('returns the runner words and the patterns after --test', () => {
    const parsed = testCommand({ scripts: { test: 'tsx --test "a/*.ts" b/*.ts' } });
    assert.deepEqual(parsed.runner, ['tsx', '--test']);
    assert.deepEqual(parsed.patterns, ['a/*.ts', 'b/*.ts']);
    assert.throws(() => testCommand({ scripts: { test: 'vitest run' } }), /--test/);
    assert.throws(() => testCommand({ scripts: { test: 'tsx --test' } }), /no patterns/);
    assert.throws(() => testCommand({ scripts: {} }), /scripts\.test/);
  });
});

describe('test-shard arguments', () => {
  it('reads --run and --script anywhere among the positional arguments', () => {
    assert.deepEqual(parseArgs(['.', '1/3', '--script', 'test:engine', '--run']), {
      run: true,
      script: 'test:engine',
      positional: ['.', '1/3'],
    });
    assert.deepEqual(parseArgs(['apps/desktop', '2/2']), {
      run: false,
      script: 'test',
      positional: ['apps/desktop', '2/2'],
    });
  });

  it('rejects --script without a name', () => {
    assert.throws(() => parseArgs(['.', '1/3', '--script']), /needs a script name/);
    assert.throws(() => parseArgs(['.', '1/3', '--script', '--run']), /needs a script name/);
  });

  it('names the script in its errors', () => {
    const pkg = { scripts: { 'test:x': 'vitest run', 'test:y': 'tsx --test' } };
    assert.throws(() => testCommand(pkg, 'test:x'), /scripts\.test:x has no --test/);
    assert.throws(() => testCommand(pkg, 'test:y'), /scripts\.test:y has no patterns/);
  });

  it('testCommand reads a named script', () => {
    const parsed = testCommand(
      { scripts: { 'test:engine': 'node x.mjs --test "a/*.ts"' } },
      'test:engine',
    );
    assert.deepEqual(parsed.runner, ['node', 'x.mjs', '--test']);
    assert.throws(() => testCommand({ scripts: {} }, 'test:engine'), /scripts\.test:engine/);
  });
});

describe('test-shard file list', () => {
  it("expands a workspace's own patterns, sorted and deduplicated", () => {
    const { patterns } = testCommand({ scripts: { test: fixtureTest } });
    assert.deepEqual(listTestFiles(workspace(), patterns), fixtureFiles);
  });
});

describe('test-shard partition', () => {
  it('parses shard specs and rejects bad ones', () => {
    assert.deepEqual(parseShard('1/2'), { shard: 1, of: 2 });
    assert.deepEqual(parseShard('3/3'), { shard: 3, of: 3 });
    assert.throws(() => parseShard('0/2'), /out of range/);
    assert.throws(() => parseShard('3/2'), /out of range/);
    assert.throws(() => parseShard('one'), /shard must look like/);
  });

  it('splits a sorted list round-robin into nearly equal shards', () => {
    const [first, second, third] = partition(files, 3);
    assert.deepEqual(first, ['a.test.ts', 'd.test.ts']);
    assert.deepEqual(second, ['b.test.ts', 'e.test.ts']);
    assert.deepEqual(third, ['c.test.ts']);
  });

  it('shards partition the full list: disjoint, and together complete', () => {
    for (const of of [1, 2, 3, 7]) {
      const flat = partition(files, of).flat();
      assert.equal(new Set(flat).size, flat.length, 'no file runs in two shards');
      assert.deepEqual([...flat].sort(), files, 'every file runs in exactly one shard');
    }
  });

  it('shardFiles is deterministic and covers the workspace list across shards', () => {
    const dir = workspace();
    assert.deepEqual(shardFiles(dir, 1, 2), shardFiles(dir, 1, 2));
    const shards = [shardFiles(dir, 1, 2), shardFiles(dir, 2, 2)];
    assert.equal(new Set(shards.flat()).size, shards.flat().length);
    assert.deepEqual(shards.flat().sort(), fixtureFiles);
  });

  it('shards of the real desktop workspace cover its scripts.test list', () => {
    const dir = join(root, 'apps', 'desktop');
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const all = listTestFiles(dir, testCommand(pkg).patterns);
    assert.ok(all.length > 0, 'desktop has test files');
    const shards = [shardFiles(dir, 1, 2), shardFiles(dir, 2, 2)];
    assert.equal(new Set(shards.flat()).size, all.length, 'no file in two shards');
    assert.deepEqual(shards.flat().sort(), all);
  });

  it('shards of the root test:engine script cover its list, so the Electron-Node job loses no file', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const all = listTestFiles(root, testCommand(pkg, 'test:engine').patterns);
    assert.ok(
      all.some(file => file.startsWith('packages/engine/tests/')),
      'engine tests listed',
    );
    const shards = [1, 2, 3].map(shard => shardFiles(root, shard, 3, 'test:engine'));
    assert.equal(new Set(shards.flat()).size, all.length, 'no file in two shards');
    assert.deepEqual(shards.flat().sort(), all);
  });

  // An expansion that does not go through test-shard.mjs: walk the workspace for anything that looks
  // like a test file and require that a shard runs it. A test file that no glob in scripts.test
  // matches (the 15 renderer/ui .test.tsx files were once in this state) fails here, by name.
  it('no *.test.{ts,tsx,mjs} file in the desktop workspace is left out of every shard', () => {
    const dir = join(root, 'apps', 'desktop');
    const skip = new Set(['node_modules', 'dist', 'release', 'artifacts', '.vite']);
    const walk = current =>
      readdirSync(current, { withFileTypes: true }).flatMap(entry => {
        if (skip.has(entry.name)) return [];
        const path = join(current, entry.name);
        return entry.isDirectory() ? walk(path) : [path];
      });
    const onDisk = walk(dir)
      .map(path => relative(dir, path).split(sep).join('/'))
      .filter(path => /\.test\.(ts|tsx|mjs)$/.test(path))
      // Playwright specs (*.spec.ts) and the visual harness run elsewhere; they are not matched here.
      .sort();
    // shardFiles returns paths relative to the workspace directory.
    const covered = new Set([shardFiles(dir, 1, 2), shardFiles(dir, 2, 2)].flat());
    const left = onDisk.filter(path => !covered.has(path));
    assert.deepEqual(left, [], `test files no shard runs: ${left.join(', ')}`);
  });

  // The CI split names the workspaces with a test script explicitly. This reads ci.yml itself: the
  // desktop matrix must call test-shard.mjs for apps/desktop, and every other workspace with a test
  // script must be named in a `npm test -w ...` line, so a new workspace fails here until it has a job.
  it('every workspace with scripts.test has a unit job in ci.yml', () => {
    const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const withTests = globSync(rootPkg.workspaces, { cwd: root })
      .map(dir => join(root, dir, 'package.json'))
      .filter(existsSync)
      .map(file => JSON.parse(readFileSync(file, 'utf8')))
      .filter(pkg => typeof pkg?.scripts?.test === 'string')
      .map(pkg => pkg.name)
      .sort();
    assert.ok(withTests.includes('@aplos/desktop'), 'found the desktop workspace');
    const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    const named = new Set(
      [...ci.matchAll(/npm test((?:\s+-w\s+\S+)+)/g)].flatMap(match =>
        [...match[1].matchAll(/-w\s+(\S+)/g)].map(workspaceMatch => workspaceMatch[1]),
      ),
    );
    // Sharded workspaces are named by directory in a test-shard.mjs line instead.
    const shardedDirs = { '@aplos/desktop': 'apps/desktop', '@aplos/engine': 'packages/engine' };
    const isSharded = name =>
      name in shardedDirs && new RegExp(`test-shard\\.mjs\\s+${shardedDirs[name]}\\b`).test(ci);
    const missing = withTests.filter(name => !isSharded(name) && !named.has(name));
    assert.deepEqual(
      missing,
      [],
      `workspaces with a test script but no unit job in ci.yml: ${missing.join(', ')}`,
    );
  });
});

describe('test-shard cli', () => {
  it('prints one shard file per line and fails on a bad shard', () => {
    const dir = workspace();
    const run = spawnSync(process.execPath, [script, dir, '1/2'], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.deepEqual(run.stdout.trim().split('\n'), shardFiles(dir, 1, 2));
    const bad = spawnSync(process.execPath, [script, dir, 'bogus'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /shard must look like/);
  });
});
