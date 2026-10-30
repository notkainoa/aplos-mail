import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs, scoreSuppressions } from '../hillclimb/scorers/eslint-suppressions.mjs';

const scorer = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'hillclimb',
  'scorers',
  'eslint-suppressions.mjs',
);
const tmp = mkdtempSync(join(tmpdir(), 'hillclimb-scorer-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const fixture = {
  'apps/desktop/src/main/a.ts': {
    'aplos/boundaries': { count: 5 },
    complexity: { count: 2 },
  },
  'apps/desktop/src/main/b.ts': {
    'aplos/boundaries': { count: 3 },
  },
  'apps/desktop/src/renderer/c.tsx': {
    'aplos/boundaries': { count: 7 },
    'no-console': { count: 1 },
  },
};
const fixturePath = join(tmp, 'eslint-suppressions.json');
writeFileSync(fixturePath, JSON.stringify(fixture));

describe('scoreSuppressions', () => {
  it('negates the total count and lists worst rules first', () => {
    const { score, details } = scoreSuppressions(fixture);
    assert.equal(score, -18);
    assert.equal(details[0], 'aplos/boundaries: 15 in 3 files');
    assert.equal(details.length, 3);
  });

  it('counts only files matching a scope glob', () => {
    const { score, details } = scoreSuppressions(fixture, ['apps/desktop/src/main/**']);
    assert.equal(score, -10);
    assert.equal(details[0], 'aplos/boundaries: 8 in 2 files');
    assert.equal(details.length, 2);
  });

  it('honours several scopes', () => {
    const { score } = scoreSuppressions(fixture, [
      'apps/desktop/src/main/a.ts',
      'apps/desktop/src/renderer/**',
    ]);
    assert.equal(score, -15);
  });

  it('caps details at ten entries', () => {
    const many = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`f${i}.ts`, { [`r${i}`]: { count: i } }]),
    );
    assert.equal(scoreSuppressions(many).details.length, 10);
  });

  it('throws on counts that are not non-negative integers', () => {
    for (const bad of [-1, 1.5, '3', null]) {
      assert.throws(
        () => scoreSuppressions({ 'a.ts': { 'rule-x': { count: bad } } }),
        /non-negative integer/,
        JSON.stringify(bad),
      );
    }
  });
});

describe('scorer CLI', () => {
  const run = args => spawnSync('node', [scorer, ...args], { encoding: 'utf8' });

  it('prints the contract JSON as the last line', () => {
    const out = run(['--file', fixturePath]);
    assert.equal(out.status, 0, out.stderr);
    const last = out.stdout.trim().split('\n').at(-1);
    assert.deepEqual(JSON.parse(last).score, -18);
  });

  it('applies --scope from the command line', () => {
    const out = run(['--file', fixturePath, '--scope', 'apps/desktop/src/main/**']);
    assert.equal(JSON.parse(out.stdout.trim().split('\n').at(-1)).score, -10);
  });

  it('exits non-zero with one stderr line when a scope matches no entries', () => {
    const out = run(['--file', fixturePath, '--scope', 'apps/web/**']);
    assert.notEqual(out.status, 0);
    assert.equal(out.stdout.trim(), '');
    assert.equal(out.stderr.trim().split('\n').length, 1);
    assert.match(out.stderr, /no suppressions entry matches/);
  });

  it('exits non-zero when a scoped run sees an empty suppressions file', () => {
    writeFileSync(join(tmp, 'empty.json'), '{}');
    const out = run(['--file', join(tmp, 'empty.json'), '--scope', 'apps/**']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /no suppressions entry matches/);
    // But the same empty file with no scope is an honest zero.
    const unscoped = run(['--file', join(tmp, 'empty.json')]);
    assert.equal(unscoped.status, 0);
    assert.deepEqual(JSON.parse(unscoped.stdout.trim().split('\n').at(-1)).score, 0);
  });

  it('exits non-zero on a missing file (attempt invalid)', () => {
    const out = run(['--file', join(tmp, 'absent.json')]);
    assert.notEqual(out.status, 0);
  });

  it('exits non-zero on malformed JSON', () => {
    writeFileSync(join(tmp, 'bad.json'), '{oops');
    assert.notEqual(run(['--file', join(tmp, 'bad.json')]).status, 0);
  });

  it('exits non-zero on a negative or fractional count', () => {
    writeFileSync(join(tmp, 'neg.json'), JSON.stringify({ 'a.ts': { 'rule-x': { count: -5 } } }));
    assert.notEqual(run(['--file', join(tmp, 'neg.json')]).status, 0);
    writeFileSync(join(tmp, 'frac.json'), JSON.stringify({ 'a.ts': { 'rule-x': { count: 2.5 } } }));
    assert.notEqual(run(['--file', join(tmp, 'frac.json')]).status, 0);
  });
});

describe('parseArgs', () => {
  it('collects repeated scopes and --file', () => {
    assert.deepEqual(parseArgs(['--file', 'x.json', '--scope', 'a/**', '--scope', 'b/**']), {
      file: 'x.json',
      scopes: ['a/**', 'b/**'],
    });
  });
  it('rejects unknown flags and missing values', () => {
    assert.throws(() => parseArgs(['--nope']), /unknown argument/);
    assert.throws(() => parseArgs(['--file']), /needs a value/);
  });
});
