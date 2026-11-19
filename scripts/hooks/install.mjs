// `npm run prepare`: point git at scripts/hooks so the pre-commit check runs, also in worktrees.
// Idempotent, and it never fails an install: every problem is printed and ignored.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function git(...args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

function install() {
  if (process.env.CI) return;
  const top = git('rev-parse', '--show-toplevel');
  if (top.status !== 0) return; // not a git checkout (for example an npm tarball)
  const root = top.stdout.trim();
  if (!existsSync(path.join(root, 'scripts/hooks/pre-commit'))) return;
  const current = git('config', '--get', 'core.hooksPath').stdout.trim();
  if (current === 'scripts/hooks') return;
  const set = git('config', 'core.hooksPath', 'scripts/hooks');
  if (set.status !== 0) throw new Error(set.stderr.trim());
  console.log('git hooks: core.hooksPath set to scripts/hooks');
}

try {
  install();
} catch (error) {
  console.log(`git hooks: not installed (${error.message})`);
}
