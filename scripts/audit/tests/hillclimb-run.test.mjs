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
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, describe, it } from 'node:test';
import { HARD_EXIT_PRELUDE, killTrackedChildren, trackChild } from './hillclimb-children.mjs';
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
const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Polls `condition` every 50 ms until it holds or `ceilingMs` passes (then fails with `message`). */
async function waitFor(condition, ceilingMs, message) {
  const until = Date.now() + ceilingMs;
  while (Date.now() < until) {
    if (condition()) return;
    await sleepMs(50);
  }
  assert.ok(condition(), message);
}

/** Resolves with `promise`, or kills `child` and fails with `message` after `ceilingMs`. */
async function withCeiling(promise, ceilingMs, message, child) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(message));
    }, ceilingMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The pids a gate wrote to `file` (its shell, then its sleep child); [] until both lines exist. */
function gatePids(file) {
  try {
    const pids = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number);
    return pids.length === 2 && pids.every(Number.isInteger) ? pids : [];
  } catch {
    return [];
  }
}

/** True while `pid` is a live process; a zombie (killed but not yet reaped) counts as dead. */
function pidRunning(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
      .trim()
      .startsWith('Z');
  } catch {
    return false;
  }
}

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

  // A failing test must not leave a run.mjs child behind (it would hold node:test's pipes).
  afterEach(killTrackedChildren);

  const spawnRun = (repo, scriptDir, slot, extra = []) =>
    trackChild(
      spawn(
        process.execPath,
        [join(scriptDir, 'run.mjs'), join(repo, 'config.json'), '--run-id', 'sig-t', ...extra],
        {
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: slot },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    );

  // Conventional exit codes are 128 + signal number: SIGINT 130, SIGTERM 143, SIGHUP 129.
  for (const [signal, code, sleeper] of [
    ['SIGTERM', 143, 47],
    ['SIGINT', 130, 48],
    ['SIGHUP', 129, 49],
  ]) {
    it(`${signal} mid-gate kills the process group, releases the slot, removes worktrees`, async () => {
      const marker = join(tmp, `${signal.toLowerCase()}-gate-finished`);
      // The gate records its own pid and its sleep child's pid: the test checks those two pids,
      // never a command-line pattern, so a concurrent run of this same test (another worktree's
      // test:audit on the same machine) cannot be mistaken for a survivor.
      const pids = join(tmp, `${signal.toLowerCase()}-gate-pids`);
      const { repo, scriptDir, git, slot } = seedRun(`${signal.toLowerCase()}-gate`, {
        name: 'sig',
        allowedPaths: ['**'],
        // The gate sleeps inside the check slot: the signal lands with the slot held
        // and the gate's process group alive — exactly the state cleanup has to drain.
        gates: [
          {
            name: 'g',
            command: `echo $$ > ${pids}; sleep ${sleeper} & echo $! >> ${pids}; wait; touch ${marker}`,
            timeoutSec: 60,
          },
        ],
        scorers: [
          { name: 's', command: 'echo {"score":1,"details":[]}', weight: 1, timeoutSec: 10 },
        ],
        attempt: { agent: 'command', command: 'sleep 60', timeoutSec: 90, brief: 'x' },
        attemptsPerRound: 1,
        roundLimit: 1,
        stopAfterNoGain: 1,
        maxConcurrent: 1,
      });
      const child = spawnRun(repo, scriptDir, slot);
      const slotDir = join(slot, 'aplos-check-slot.lock');
      const runRootDir = join(slot, 'hillclimb-sig-t');
      // Conditions, not fixed delays: a loaded machine can take a minute to start the gate and
      // seconds to finish cleanup (60 s ceilings, 50 ms polls).
      await waitFor(
        () => existsSync(slotDir),
        60_000,
        `check-slot lock never appeared under ${signal}`,
      );
      // The lock exists before the gate process does: signal only once the gate really runs, so
      // the test exercises the group kill and not the (separate) spawn-in-flight window.
      await waitFor(
        () => gatePids(pids).length === 2,
        60_000,
        `gate never started under ${signal}`,
      );
      const gate = gatePids(pids);
      const closed = new Promise(resolve => child.on('close', (...a) => resolve(a)));
      child.kill(signal);
      const [exit] = await withCeiling(
        closed,
        60_000,
        `run.mjs did not exit after ${signal}`,
        child,
      );
      assert.equal(exit, code, `${signal} exit code`);
      assert.equal(existsSync(slotDir), false, 'check-slot lock left behind');
      assert.equal(existsSync(runRootDir), false, 'run root left behind');
      // The kill is a group SIGKILL, delivered at once; on a loaded machine the processes can
      // linger briefly in the table (or as zombies when nothing reaps them), so poll.
      await waitFor(
        () => gate.every(pid => !pidRunning(pid)),
        30_000,
        `gate process group survived the kill (pids ${gate.join(', ')})`,
      );
      assert.equal(existsSync(marker), false, 'gate completed despite the kill');
      const worktrees = git(['worktree', 'list', '--porcelain']);
      assert.equal(worktrees.trim().split('\n\n').length, 1, `worktrees left behind: ${worktrees}`);
      assert.equal(git(['for-each-ref', 'hillclimb/sig-t']).trim(), '', 'branches left');
    });
  }

  it('realDeps drives attempt+eval worktrees, gates and scorers on a real repo', async () => {
    const { scriptDir, git, slot } = seedRun('realdeps', {
      name: 'deps-e2e',
      allowedPaths: ['**'],
      gates: [{ name: 'g', command: 'exit 0', timeoutSec: 10 }],
      scorers: [{ name: 's', command: 'echo {"score":3,"details":[]}', weight: 1, timeoutSec: 10 }],
      attempt: { agent: 'command', command: 'true', timeoutSec: 5, brief: 'x' },
      attemptsPerRound: 1,
      roundLimit: 1,
      stopAfterNoGain: 1,
      maxConcurrent: 1,
      lockWaitMin: 1,
      maxLogMB: 5,
    });
    // No agent: the child drives realDeps by hand — prepare an attempt worktree,
    // commit a change, gate+score it in an eval worktree through the check slot.
    const script = `
      const { realDeps } = await import(${JSON.stringify(join(scriptDir, 'run.mjs'))});
      const fs = await import('node:fs');
      const { join } = await import('node:path');
      const artifactsDir = join(${JSON.stringify(slot)}, 'artifacts');
      fs.mkdirSync(artifactsDir, { recursive: true });
      const state = { dirs: [], branches: [], procs: new Set() };
      const deps = realDeps({
        config: ${JSON.stringify({ name: 'deps-e2e', lockWaitMin: 1, maxLogMB: 5 })},
        repoRelPath: 'config.json',
        runId: 'deps-t',
        artifactsDir,
        state,
      });
      const out = { startCommit: deps.startCommit };
      const ctx = { id: 'r1a1', round: 1, index: 1, commit: deps.startCommit, baseCommit: deps.startCommit };
      await deps.prepareAttempt(ctx);
      out.attemptDirExists = fs.existsSync(ctx.dir);
      out.branch = ctx.branch;
      fs.writeFileSync(join(ctx.dir, 'note.txt'), 'hello\\n');
      const fin = await deps.finalizeAttempt(ctx);
      out.head = fin.head;
      out.added = fin.changes.filter(c => c.status === 'A').map(c => c.path);
      const base = { id: 'baseline', head: deps.startCommit };
      const evalDir = await deps.prepareEval(base);
      const gate = await deps.withCheckSlot(() =>
        deps.runGate({ name: 'g', command: 'exit 0', timeoutSec: 10 }, evalDir, join(artifactsDir, 'g.log')));
      const scoreCmd = 'echo ' + JSON.stringify(JSON.stringify({ score: 3, details: [] }));
      const score = await deps.withCheckSlot(() =>
        deps.runScorer({ name: 's', command: scoreCmd, timeoutSec: 10 }, evalDir, join(artifactsDir, 's.log')));
      out.gate = gate;
      out.score = score;
      out.mainIntact = await deps.verifyMainIntact().then(() => true, e => e.message);
      await deps.removeAttempt(ctx);
      await deps.removeEval(base);
      await deps.cleanup();
      console.log('RESULT ' + JSON.stringify(out));
    `;
    const child = trackChild(
      spawn('node', ['--input-type=module', '-e', HARD_EXIT_PRELUDE + script], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: slot },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    const closed = new Promise(resolve => child.on('close', (...a) => resolve(a)));
    const [code] = await withCeiling(closed, 120_000, 'realDeps child did not finish', child);
    assert.equal(code, 0, `realDeps child failed: ${stderr}`);
    const line = stdout.trim().split('\n').at(-1);
    assert.ok(line.startsWith('RESULT '), `no result line: ${stdout}`);
    const out = JSON.parse(line.slice(7));
    assert.equal(out.startCommit, git(['rev-parse', 'HEAD']).trim());
    assert.equal(out.attemptDirExists, true);
    assert.match(out.branch, /^hillclimb\/deps-e2e\/deps-t\//);
    assert.notEqual(out.head, out.startCommit, 'attempt commit not created');
    assert.deepEqual(out.added, ['note.txt']);
    assert.deepEqual(out.gate, { ok: true });
    assert.equal(out.score.ok, true);
    assert.equal(out.score.score, 3);
    assert.equal(out.mainIntact, true, 'main checkout changed');
    const worktrees = git(['worktree', 'list', '--porcelain']);
    assert.equal(worktrees.trim().split('\n\n').length, 1, `worktrees left behind: ${worktrees}`);
    assert.equal(git(['for-each-ref', 'hillclimb/deps-e2e']).trim(), '', 'branches left');
    assert.equal(existsSync(join(slot, 'hillclimb-deps-t')), false, 'run root left behind');
    assert.equal(existsSync(join(slot, 'aplos-check-slot.lock')), false, 'slot left');
  });
});
