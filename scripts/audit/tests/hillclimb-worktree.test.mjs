// Unit coverage for worktree.mjs against real git repos: the main-checkout drift
// snapshot/assert, node_modules linking and its invisibility to status/commits, and
// detached eval worktrees.
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setupE2E } from './hillclimb-e2e-shared.mjs';
import {
  addWorktree,
  assertMainIntact,
  commitAll,
  currentHead,
  linkNodeModules,
  mainSnapshot,
  removeWorktree,
  statusPorcelain,
} from '../hillclimb/worktree.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'hc-worktree-'));
const { repo, git, seedRepo } = setupE2E(tmp);
const worktreeDir = join(tmp, 'wt');

describe('mainSnapshot / assertMainIntact', () => {
  it('passes an untouched checkout and detects a dirtied one', () => {
    seedRepo();
    const snap = mainSnapshot(repo);
    assertMainIntact(repo, snap); // no throw
    writeFileSync(join(repo, 'main', 'extra.txt'), 'x');
    assert.throws(() => assertMainIntact(repo, snap), /dirtied during the run/);
  });

  it('detects a HEAD move', () => {
    seedRepo();
    const snap = mainSnapshot(repo);
    writeFileSync(join(repo, 'main', 'extra.txt'), 'x');
    git(['add', '-A']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'move']);
    assert.throws(() => assertMainIntact(repo, snap), /HEAD moved/);
  });

  it('detects writes inside node_modules that status cannot see', () => {
    seedRepo({ gitignore: 'node_modules\n' });
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    const snap = mainSnapshot(repo);
    // statusPorcelain excludes node_modules, so only the mtime notices this touch.
    assert.equal(statusPorcelain(repo).length, 0);
    utimesSync(join(repo, 'node_modules'), new Date(), new Date(Date.now() + 10_000));
    assert.throws(() => assertMainIntact(repo, snap), /node_modules touched/);
  });
});

describe('linkNodeModules + worktrees', () => {
  it('links the root node_modules and hides it from status', () => {
    seedRepo({ gitignore: 'node_modules\n' });
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'dep.txt'), 'x');
    addWorktree(repo, { dir: worktreeDir, commit: currentHead(repo) });
    const linked = linkNodeModules(repo, worktreeDir);
    assert.deepEqual(linked, ['.']);
    assert.ok(lstatSync(join(worktreeDir, 'node_modules')).isSymbolicLink());
    assert.equal(statusPorcelain(worktreeDir).length, 0);
    removeWorktree(repo, worktreeDir);
  });

  it('creates a detached eval worktree at the given commit', () => {
    seedRepo();
    const head = currentHead(repo);
    writeFileSync(join(repo, 'main', 'extra.txt'), 'x');
    git(['add', '-A']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'later']);
    addWorktree(repo, { dir: worktreeDir, commit: head });
    assert.equal(currentHead(worktreeDir), head);
    assert.match(git(['status', '--porcelain', '-b'], worktreeDir), /HEAD \(no branch\)|detached/);
    removeWorktree(repo, worktreeDir);
  });

  it('commitAll stages work but never a linked node_modules symlink', () => {
    seedRepo({ gitignore: 'node_modules\n' });
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'dep.txt'), 'x');
    addWorktree(repo, { dir: worktreeDir, commit: currentHead(repo) });
    linkNodeModules(repo, worktreeDir);
    writeFileSync(join(worktreeDir, 'main', 'count.txt'), '7\n');
    const sha = commitAll(worktreeDir, 'attempt');
    assert.ok(sha);
    const names = git(['show', '--name-only', '--format=', sha], worktreeDir);
    assert.match(names, /main\/count\.txt/);
    assert.doesNotMatch(names, /node_modules/);
    removeWorktree(repo, worktreeDir);
  });

  it('commitAll returns null on a clean worktree', () => {
    seedRepo();
    addWorktree(repo, { dir: worktreeDir, commit: currentHead(repo) });
    assert.equal(commitAll(worktreeDir, 'nothing'), null);
    removeWorktree(repo, worktreeDir);
  });
});

// A symlink placed by hand (not via linkNodeModules) must also stay unstaged under the
// bare "node_modules" ignore form.
describe('commitAll under bare node_modules ignore', () => {
  it('never stages a node_modules symlink', () => {
    seedRepo({ gitignore: 'node_modules\n' });
    mkdirSync(join(repo, 'real-modules'), { recursive: true });
    writeFileSync(join(repo, 'real-modules', 'dep.txt'), 'x');
    addWorktree(repo, { dir: worktreeDir, commit: currentHead(repo) });
    symlinkSync(join(repo, 'real-modules'), join(worktreeDir, 'node_modules'), 'dir');
    writeFileSync(join(worktreeDir, 'main', 'count.txt'), '7\n');
    const sha = commitAll(worktreeDir, 'attempt');
    const names = git(['show', '--name-only', '--format=', sha], worktreeDir);
    assert.match(names, /main\/count\.txt/);
    assert.doesNotMatch(names, /node_modules/);
    removeWorktree(repo, worktreeDir);
  });
});
