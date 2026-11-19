import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const CODE = /\.(?:[cm]?[jt]sx?)$/;

/** The module path TypeScript resolves an import to: directory plus base name without its extension. */
export function modulePath(file: string): string {
  return file.replace(CODE, '').replace(/\.d$/, '');
}

/** Pairs of tracked code files whose module paths differ only in letter case (they collide on macOS and Windows). */
export function caseCollisions(files: readonly string[]): string[] {
  const seen = new Map<string, string>();
  const clashes: string[] = [];
  for (const file of files.filter(name => CODE.test(name))) {
    const path = modulePath(file);
    const key = path.toLowerCase();
    const other = seen.get(key);
    if (other !== undefined && other !== path) clashes.push(`${other} <-> ${path}`);
    else seen.set(key, path);
  }
  return clashes;
}

function trackedFiles(): string[] {
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const out = execFileSync('git', ['ls-files', '--', 'apps', 'packages', 'tests'], {
    cwd: top,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').filter(Boolean);
}

test('the collision finder reports names that differ only in case', () => {
  const files = [
    'a/LaterPicker.tsx',
    'a/laterPicker.ts',
    'a/other.ts',
    'b/Shell.tsx',
    'b/shell.css',
  ];
  assert.deepEqual(caseCollisions(files), ['a/LaterPicker <-> a/laterPicker']);
});

test('a .d.ts and its source of the same name are not a collision', () => {
  assert.deepEqual(caseCollisions(['a/x.ts', 'a/x.d.ts']), []);
});

test('no two tracked code modules differ only in letter case', () => {
  assert.deepEqual(caseCollisions(trackedFiles()), []);
});
