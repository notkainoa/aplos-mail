// End-to-end: a real temp git repo, real worktrees, the real diff guard and the real
// gate/scorer runners; only the check-slot lock dir and the log dir are test-local. The
// `command` agent branches on its worktree name: r1a1 shrinks the count (score -10 -> -5,
// kept), r1a2 writes a file under scripts/audit/ which the always-forbidden rule rejects
// even though this config's allowedPaths includes it. Tamper scenarios live in
// hillclimb-e2e-tamper.test.mjs; both files share hillclimb-e2e-shared.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { runHillClimb } from '../hillclimb/loop.mjs';
import {
  addedLines,
  addWorktree,
  commitAll,
  currentHead,
  diffBetween,
  gitShow,
  indexFlagViolations,
  linkNodeModules,
  removeWorktree,
  statusPorcelain,
} from '../hillclimb/worktree.mjs';
import { setupE2E } from './hillclimb-e2e-shared.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'hillclimb-e2e-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const { git, seedRepo, makeDeps, config } = setupE2E(tmp);

describe('hill-climb end to end', () => {
  it('keeps the improving attempt, rejects the forbidden one, leaves one squashed best commit', async () => {
    seedRepo();
    const logs = join(tmp, 'logs1');
    mkdirSync(logs);
    const { deps, root } = makeDeps({
      runConfig: config,
      runId: `e2e-${process.pid.toString(36)}-a`,
      logs,
    });

    const result = await runHillClimb(config, deps);

    const [a1, a2] = result.rounds[0].attempts;
    assert.equal(a1.verdict, 'kept', JSON.stringify(a1));
    assert.equal(a1.combined, -5);
    assert.match(a2.verdict, /rejected:.*scripts\/audit\/evil\.mjs/);

    // The best branch carries exactly one squashed commit on top of the start commit.
    const best = result.bestBranch;
    const count = Number(git(['rev-list', '--count', `${result.startCommit}..${best}`]).trim());
    assert.equal(count, 1);
    assert.equal(git(['show', `${best}:main/count.txt`]).trim(), '5');

    // No attempt worktrees or branches survive; the run dir is gone.
    assert.equal(existsSync(root), false);
    const branches = git(['branch', '--list', 'hillclimb/*', '--format=%(refname:short)'])
      .split('\n')
      .filter(Boolean);
    assert.deepEqual(branches, [best]);
  });
});

describe('harness git plumbing (real repos)', () => {
  const fresh = name => {
    const dir = join(tmp, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const init = dir => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'],
      { cwd: dir },
    );
  };

  it('commitAll never stages a node_modules symlink, even under a dirs-only .gitignore', () => {
    const r = fresh('wt-mods');
    init(r);
    writeFileSync(join(r, '.gitignore'), 'node_modules/\n'); // the old directories-only form
    writeFileSync(join(r, 'package.json'), '{"name":"t","workspaces":[]}');
    execFileSync('git', ['add', '-A'], { cwd: r });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed'], {
      cwd: r,
    });
    const wt = join(tmp, 'wt-mods-wt');
    addWorktree(r, { dir: wt, branch: 'wt-mods-b', commit: currentHead(r) });
    mkdirSync(join(r, 'node_modules'), { recursive: true });
    linkNodeModules(r, wt); // populates a real wt/node_modules of links into r's
    writeFileSync(join(wt, 'a.txt'), 'change\n');
    const head = commitAll(wt, 'attempt');
    assert.ok(head, 'a commit was created');
    assert.deepEqual(statusPorcelain(wt), [], 'symlink is not a leftover');
    assert.equal(gitShow(wt, 'HEAD', 'node_modules'), null, 'symlink not committed');
    assert.deepEqual(
      diffBetween(wt, `${head}^`, head).map(c => c.path),
      ['a.txt'],
    );
    removeWorktree(r, wt);
  });

  it('commitAll commits despite a failing repo pre-commit hook', () => {
    const r = fresh('wt-hooks');
    init(r);
    // The hook must be committed so it exists inside the attempt worktree (a relative
    // core.hooksPath resolves there, as scripts/hooks does in the real repo).
    const hooks = join(r, 'hooks');
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    execFileSync('git', ['add', '-A'], { cwd: r });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'hook'], {
      cwd: r,
    });
    execFileSync('git', ['config', 'core.hooksPath', 'hooks'], { cwd: r });
    const wt = join(tmp, 'wt-hooks-wt');
    addWorktree(r, { dir: wt, branch: 'wt-hooks-b', commit: currentHead(r) });
    writeFileSync(join(wt, 'b.txt'), 'x\n');
    // A plain commit would die in the hook; the harness commit must not.
    assert.ok(commitAll(wt, 'attempt'));
    assert.equal(gitShow(wt, 'HEAD', 'b.txt'), 'x\n');
    removeWorktree(r, wt);
  });

  it('indexFlagViolations reports assume-unchanged and skip-worktree entries', () => {
    const r = fresh('wt-flags');
    init(r);
    writeFileSync(join(r, 'a.txt'), 'a\n');
    writeFileSync(join(r, 'b.txt'), 'b\n');
    execFileSync('git', ['add', '-A'], { cwd: r });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'files'], {
      cwd: r,
    });
    assert.deepEqual(indexFlagViolations(r), []);
    execFileSync('git', ['update-index', '--assume-unchanged', 'a.txt'], { cwd: r });
    execFileSync('git', ['update-index', '--skip-worktree', 'b.txt'], { cwd: r });
    assert.deepEqual(indexFlagViolations(r).sort(), ['a.txt', 'b.txt']);
  });

  it('addedLines returns only + lines of base..HEAD', () => {
    const r = fresh('wt-added');
    init(r);
    writeFileSync(join(r, 'f.txt'), 'old line\n');
    execFileSync('git', ['add', '-A'], { cwd: r });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed'], {
      cwd: r,
    });
    const base = currentHead(r);
    writeFileSync(join(r, 'f.txt'), 'new line\nold line\n');
    execFileSync('git', ['add', '-A'], { cwd: r });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'work'], {
      cwd: r,
    });
    assert.deepEqual(addedLines(r, base, 'HEAD'), ['new line']);
  });
});
