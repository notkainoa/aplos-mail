// CLI surface tests for run.mjs: --run-id lands in branch names and tmpdir names, so it is
// validated as a safe slug before anything is created; and the harness's own process.env
// is scrubbed to the eval/agent allow-lists before anything can spawn.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { parseArgs, realDeps, scrubProcessEnv } from '../hillclimb/run.mjs';

describe('parseArgs --run-id', () => {
  it('accepts a valid slug', () => {
    const options = parseArgs(['config.json', '--run-id', 'r7-2026-02']);
    assert.equal(options.runId, 'r7-2026-02');
  });

  it('rejects ids that are not safe slugs', () => {
    const bad = ['-x', 'A', 'a_b', 'a/b', 'a b', 'a'.repeat(42), 'Ω', ''];
    for (const value of bad) {
      assert.throws(
        () => parseArgs(['config.json', '--run-id', value]),
        /--run-id/,
        JSON.stringify(value),
      );
    }
  });
});

describe('scrubProcessEnv', () => {
  it('deletes every variable not on the eval or agent allow-lists', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/h',
      NODE_OPTIONS: '--max-old-space-size=4096',
      npm_config_cache: '/c',
      XDG_CONFIG_HOME: '/cfg', // agent-only name, kept so agents can be spawned
      DEVIN_CONFIG_DIR: '/dc',
      NODE_AUTH_TOKEN: 'nt',
      NODE_PATH: '/x',
      DEVIN_API_KEY: 'dk',
      GITHUB_TOKEN: 'ghp_x',
      SSH_AUTH_SOCK: '/sock',
      AWS_SECRET_ACCESS_KEY: 'x',
      npm_config_registry: 'https://registry',
      'npm_config_//registry.npmjs.org/:_authToken': 'tok',
      LC_TIME: 'en_US.UTF-8',
    };
    scrubProcessEnv(env);
    assert.deepEqual(
      Object.keys(env).sort(),
      [
        'PATH',
        'HOME',
        'NODE_OPTIONS',
        'npm_config_cache',
        'XDG_CONFIG_HOME',
        'DEVIN_CONFIG_DIR',
      ].sort(),
    );
  });

  it('also scrubs NODE_OPTIONS carrying injection flags', () => {
    const env = { PATH: '/usr/bin', NODE_OPTIONS: '--require ./evil.js' };
    scrubProcessEnv(env);
    assert.deepEqual(env, { PATH: '/usr/bin' });
  });
});

describe('realDeps', () => {
  it('is exported and wires log paths, the slot timeout and the git snapshot', () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'hillclimb-deps-'));
    const state = { dirs: [], branches: [], procs: new Set() };
    const deps = realDeps({
      config: { name: 'demo', lockWaitMin: 5, maxLogMB: 7 },
      repoRelPath: null,
      runId: 'deps-t',
      artifactsDir,
      state,
    });
    assert.equal(deps.logPath('r1a1', 'gate-g'), join(artifactsDir, 'r1a1-gate-g.log'));
    assert.equal(typeof deps.withCheckSlot, 'function');
    assert.equal(typeof deps.runAttemptAgent, 'function');
    assert.equal(typeof deps.verifyMainIntact, 'function');
    rmSync(artifactsDir, { recursive: true, force: true });
  });
});

// A REAL run.mjs subprocess inside a throwaway repo: the harness sources are mirrored to
// <repo>/scripts/audit/hillclimb/ so run.mjs resolves the temp repo as its root, and
// TMPDIR is pointed inside the temp dir so the run root and check-slot lock are isolated.
describe('run.mjs as a subprocess', () => {
  const harnessSrc = dirname(fileURLToPath(new URL('../hillclimb/run.mjs', import.meta.url)));
  const tmp = mkdtempSync(join(tmpdir(), 'hillclimb-sub-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  const seedRun = (name, config) => {
    const repo = join(tmp, name);
    const scriptDir = join(repo, 'scripts', 'audit', 'hillclimb');
    mkdirSync(join(scriptDir, 'scorers'), { recursive: true });
    for (const file of readdirSync(harnessSrc)) {
      if (file.endsWith('.mjs')) copyFileSync(join(harnessSrc, file), join(scriptDir, file));
    }
    const scorers = join(harnessSrc, 'scorers');
    if (existsSync(scorers)) {
      for (const file of readdirSync(scorers)) {
        copyFileSync(join(scorers, file), join(scriptDir, 'scorers', file));
      }
    }
    writeFileSync(join(repo, 'package.json'), '{"name":"sub","workspaces":[]}');
    writeFileSync(join(repo, 'count.txt'), '1\n');
    // The config is committed with the seed: run.mjs refuses to start on a dirty
    // checkout, and an untracked config.json would trip that check.
    writeFileSync(join(repo, 'config.json'), JSON.stringify(config));
    const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git(['init', '-q', '-b', 'main']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
    // TMPDIR for the child — outside the repo so its lock/run dirs stay untracked.
    const slot = join(tmp, `${name}-slot`);
    mkdirSync(slot, { recursive: true });
    return { repo, scriptDir, git, slot };
  };

  const spawnRun = (repo, scriptDir, slot, extra = []) =>
    spawn(
      process.execPath,
      [join(scriptDir, 'run.mjs'), join(repo, 'config.json'), '--run-id', 'sig-t', ...extra],
      {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: slot },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

  it('SIGTERM mid-gate kills the process group, releases the slot, removes worktrees', async () => {
    const marker = join(tmp, 'sigterm-gate-finished');
    const { repo, scriptDir, git, slot } = seedRun('sigterm-gate', {
      name: 'sig',
      allowedPaths: ['**'],
      // The gate sleeps inside the check slot: SIGTERM lands with the slot held and the
      // gate's process group alive — exactly the state cleanup has to drain.
      gates: [{ name: 'g', command: `sleep 47; touch ${marker}`, timeoutSec: 60 }],
      scorers: [{ name: 's', command: 'echo {"score":1,"details":[]}', weight: 1, timeoutSec: 10 }],
      attempt: { agent: 'command', command: 'sleep 60', timeoutSec: 90, brief: 'x' },
      attemptsPerRound: 1,
      roundLimit: 1,
      stopAfterNoGain: 1,
      maxConcurrent: 1,
    });
    const child = spawnRun(repo, scriptDir, slot);
    const slotDir = join(slot, 'aplos-check-slot.lock');
    const runRootDir = join(slot, 'hillclimb-sig-t');
    for (let i = 0; i < 300 && !existsSync(slotDir); i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(existsSync(slotDir), 'check-slot lock never appeared (gate never ran)');
    child.kill('SIGTERM');
    const [code] = await new Promise(resolve => child.on('close', (...a) => resolve(a)));
    assert.equal(code, 143);
    assert.equal(existsSync(slotDir), false, 'check-slot lock left behind');
    assert.equal(existsSync(runRootDir), false, 'run root left behind');
    assert.throws(
      () => execFileSync('pgrep', ['-f', 'sleep 47']),
      /Command failed|exit code 1/,
      'gate process group survived the kill',
    );
    assert.equal(existsSync(marker), false, 'gate completed despite the kill');
    const worktrees = git(['worktree', 'list', '--porcelain']);
    assert.equal(worktrees.trim().split('\n\n').length, 1, `worktrees left behind: ${worktrees}`);
    assert.equal(git(['for-each-ref', 'hillclimb/sig-t']).trim(), '', 'branches left');
  });
});
