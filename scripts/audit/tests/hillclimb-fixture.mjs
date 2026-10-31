// Shared helpers for the hillclimb-scorer smoke tests: a throwaway fixture project in a temp
// dir (node_modules links at the repo's so the repo's tsx/knip/etc resolve inside it) and the
// scorer-CLI runners each smoke file uses.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from '../hillclimb/scorers/util.mjs';

// HILLCLIMB_SCORERS_DIR points the spawned scorer CLIs at another copy of the scorers (for
// example a checked-out earlier revision), so a test can be proven to fail on the old code.
export const scorers =
  process.env.HILLCLIMB_SCORERS_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), '..', 'hillclimb', 'scorers');
export const SLOW = process.env.HILLCLIMB_SLOW === '1';

export const run = (scorer, args, options = {}) =>
  spawnSync(process.execPath, [join(scorers, scorer), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  });

export const lastJson = run => {
  const lines = run.stdout.trim().split('\n').filter(Boolean);
  assert.ok(lines.length > 0, 'scorer printed nothing');
  return JSON.parse(lines.at(-1));
};

/** A throwaway project: package.json plus the given files; node_modules points at the repo's. */
export function fixtureProject(files) {
  const dir = mkdtempSync(join(tmpdir(), 'hillclimb-fixture-'));
  writeFileSync(join(dir, 'package.json'), '{ "name": "fixture", "private": true }\n');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  symlinkSync(join(repoRoot, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

export const removeFixture = dir => rmSync(dir, { recursive: true, force: true });
