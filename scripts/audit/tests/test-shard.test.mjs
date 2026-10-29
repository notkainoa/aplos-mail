import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  listTestFiles,
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

  // The CI split names the workspaces with a test script explicitly: the desktop matrix job
  // and the packages job's -w list. A new workspace with scripts.test fails here until ci.yml
  // gains a job for it, so `npm test` coverage cannot silently drift from CI coverage.
  it('every workspace with scripts.test has a unit job in ci.yml', () => {
    const tested = [
      '@aplos/desktop',
      '@aplos/engine',
      '@aplos/contract',
      '@aplos/contract-fixture',
      '@aplos/emulators',
    ];
    const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const withTests = globSync(rootPkg.workspaces, { cwd: root })
      .map(dir => join(root, dir, 'package.json'))
      .filter(existsSync)
      .map(file => JSON.parse(readFileSync(file, 'utf8')))
      .filter(pkg => typeof pkg?.scripts?.test === 'string')
      .map(pkg => pkg.name)
      .sort();
    assert.deepEqual(withTests, [...tested].sort());
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
