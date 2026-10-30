#!/usr/bin/env node
// Hill-climb harness CLI. Usage:
//   node scripts/audit/hillclimb/run.mjs <config.json> [--dry-run] [--rounds <n>] [--attempts <n>] [--run-id <id>]
// Improves a target area in rounds against automatic scorers and gates, running parallel
// attempts in throwaway git worktrees (never the user's checkout). Leaves a local
// hillclimb/<name>/<runId>/best branch — squashed to one commit on the starting commit — and
// prints its name. Never pushes, never opens a PR. --dry-run validates the config, scores the
// baseline and prints the plan without starting any agent.
//
// THERE IS NO SANDBOX. Attempt agents and gate/scorer commands run with this user's
// privileges — trusted agents and configs only. Cheap mitigations in place of a sandbox:
// the run refuses to start on a dirty main checkout, and after every attempt verifies the
// main checkout's HEAD and status are untouched; any change aborts the whole run.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { briefFor, filteredEnv, runAgent } from './agent.mjs';
import { evaluateScorers, runHillClimb } from './loop.mjs';
import { loadConfig, resolveBrief } from './config.mjs';
import { releaseHeldSlots, withCheckSlot } from './lock.mjs';
import { dryRunLines, roundTable, summaryLines } from './report.mjs';
import { runGate, runScorer } from './steps.mjs';
import {
  addedLines,
  addWorktree,
  assertMainIntact,
  attemptBranch,
  attemptDir,
  cleanupRun,
  commitAll,
  currentHead,
  diffBetween,
  gitShow,
  indexFlagViolations,
  linkNodeModules,
  mainSnapshot,
  removeWorktree,
  runRoot,
  squashToBest,
  statusPorcelain,
} from './worktree.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function parseArgs(argv) {
  const options = { dryRun: false };
  const args = [...argv];
  options.config = args.shift();
  if (!options.config || options.config.startsWith('--')) {
    throw new Error(
      'usage: run.mjs <config.json> [--dry-run] [--rounds <n>] [--attempts <n>] [--run-id <id>]',
    );
  }
  while (args.length) {
    const arg = args.shift();
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--rounds') options.rounds = positiveInt(arg, args.shift());
    else if (arg === '--attempts') options.attempts = positiveInt(arg, args.shift());
    else if (arg === '--run-id') {
      options.runId = args.shift();
      if (!options.runId) throw new Error('--run-id needs a value');
      // The id lands in tmpdir names and branch names; keep it a safe slug.
      if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(options.runId)) {
        throw new Error('--run-id must match ^[a-z0-9][a-z0-9-]{0,40}$');
      }
    } else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

const positiveInt = (flag, value) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${flag} needs a positive integer`);
  }
  return number;
};

const newRunId = () =>
  `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${process.pid.toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * The real deps for runHillClimb: git worktrees under the run's tmpdir, gate/scorer commands
 * logged to artifacts/hillclimb/<runId>/ and serialized through the check-slot lock, and the
 * attempt agent spawned with a secret-free environment. `state` tracks dirs and branches so
 * cleanup (normal or signal) can remove them.
 */
function realDeps({ config, repoRelPath, runId, artifactsDir, state }) {
  const root = runRoot(runId);
  const startCommit = currentHead(repoRoot);
  // Snapshot the user's checkout once — every verifyMainIntact compares against this.
  const snapshot = mainSnapshot(repoRoot);
  const cleanupAll = () =>
    cleanupRun(repoRoot, {
      runId,
      name: config.name,
      dirs: state.dirs,
      branches: state.branches,
    });
  const track = child => {
    state.procs.add(child);
    const drop = () => state.procs.delete(child);
    child.on('close', drop);
    child.on('error', drop);
  };
  return {
    repoRoot,
    runId,
    configPath: repoRelPath,
    startCommit,
    withCheckSlot: fn => withCheckSlot(fn, { timeoutMs: config.lockWaitMin * 60_000 }),
    logPath: (stepId, step) => join(artifactsDir, `${stepId}-${step}.log`),
    print: line => console.log(line),
    onRound: (round, scorerNames) => {
      for (const line of roundTable(round, scorerNames)) console.log(`  ${line}`);
      console.log('');
    },
    async prepareAttempt(ctx) {
      ctx.dir = attemptDir(root, ctx.round, ctx.index);
      ctx.branch = attemptBranch(config.name, runId, ctx.round, ctx.index);
      addWorktree(repoRoot, { dir: ctx.dir, branch: ctx.branch, commit: ctx.commit });
      state.dirs.push(ctx.dir);
      state.branches.push(ctx.branch);
      linkNodeModules(repoRoot, ctx.dir);
    },
    // A clean detached worktree checked out at a commit — where the baseline and every
    // attempt are actually gated and scored, free of uncommitted leftovers, ignored files
    // and index-flag tricks the agent's working tree could hide.
    async prepareEval(ctx) {
      ctx.evalDir = join(root, `${ctx.id}-eval`);
      addWorktree(repoRoot, { dir: ctx.evalDir, commit: ctx.head });
      state.dirs.push(ctx.evalDir);
      linkNodeModules(repoRoot, ctx.evalDir);
      return ctx.evalDir;
    },
    async runAttemptAgent(ctx, briefText) {
      // The brief file sits next to the worktree, not inside it: inside, it would land in the
      // diff the guard analyses (and an agent could edit its own instructions mid-run).
      const briefFile = join(root, `${ctx.id}-brief.md`);
      writeFileSync(briefFile, briefText);
      return runAgent(config.attempt, {
        briefFile,
        briefText: briefFor(config.attempt, briefFile),
        workdir: ctx.dir,
        env: filteredEnv(),
        logPath: join(artifactsDir, `${ctx.id}-agent.log`),
        onSpawn: track,
      });
    },
    async finalizeAttempt(ctx) {
      commitAll(ctx.dir, `hillclimb ${config.name} ${ctx.id}`);
      ctx.head = currentHead(ctx.dir);
      const changes = diffBetween(ctx.dir, ctx.baseCommit);
      const added = addedLines(ctx.dir, ctx.baseCommit);
      const flagged = indexFlagViolations(ctx.dir);
      const leftover = statusPorcelain(ctx.dir).map(entry => entry.path);
      return { head: ctx.head, changes, addedLines: added, flagged, leftover };
    },
    readOld: (ctx, path) => gitShow(ctx.dir, ctx.baseCommit, path),
    // "New" contents always come from the attempt's COMMIT, never the working tree: whatever
    // an agent left dirty, ignored or index-flagged cannot impersonate committed state.
    readNew: (ctx, path) => gitShow(ctx.dir, ctx.head ?? 'HEAD', path),
    runGate: (gate, workdir, logPath) => runGate(gate, { workdir, logPath, onSpawn: track }),
    runScorer: (scorer, workdir, logPath) =>
      runScorer(scorer, { workdir, logPath, onSpawn: track }),
    async removeAttempt(ctx) {
      if (ctx.evalDir) removeWorktree(repoRoot, ctx.evalDir);
      if (ctx.dir) removeWorktree(repoRoot, ctx.dir);
    },
    async removeEval(ctx) {
      if (ctx.evalDir) removeWorktree(repoRoot, ctx.evalDir);
    },
    async verifyMainIntact() {
      assertMainIntact(repoRoot, snapshot);
    },
    async promote({ fromSha, toSha, message }) {
      return squashToBest(repoRoot, { name: config.name, runId, fromSha, toSha, message });
    },
    async cleanup() {
      cleanupAll();
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { config, repoRelPath } = loadConfig(options.config, repoRoot);
  config.attempt.brief = resolveBrief(config.attempt.brief, repoRoot);
  if (options.rounds) config.roundLimit = options.rounds;
  if (options.attempts) config.attemptsPerRound = options.attempts;
  // No sandbox: refuse to start on a dirty main checkout so the baseline can't be poisoned
  // and later sandbox checks have a clean reference point.
  if (statusPorcelain(repoRoot).length) {
    throw new Error('main checkout is not clean — commit or stash before a hill-climb run');
  }
  const runId = options.runId ?? newRunId();
  const artifactsDir = join(repoRoot, 'artifacts', 'hillclimb', runId);
  mkdirSync(artifactsDir, { recursive: true });
  const state = { dirs: [], branches: [], procs: new Set() };
  const deps = realDeps({ config, repoRelPath, runId, artifactsDir, state });

  const onSignal = signal => {
    // Kill live process groups first — agents, gates and scorers — so nothing keeps running
    // in a deleted worktree or holds the check-slot lock.
    for (const child of state.procs) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already exited.
      }
    }
    releaseHeldSlots();
    cleanupRun(repoRoot, {
      runId,
      name: config.name,
      dirs: state.dirs,
      branches: state.branches,
    });
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGHUP', () => onSignal('SIGHUP'));

  try {
    if (options.dryRun) {
      // The dry-run baseline uses the same clean-worktree machinery as a real run.
      const baseCtx = { id: 'baseline', head: deps.startCommit };
      let baseline;
      try {
        const dir = await deps.prepareEval(baseCtx);
        baseline = await evaluateScorers(dir, config, deps, 'baseline');
      } finally {
        await deps.removeEval(baseCtx);
      }
      if (baseline.scorerFail) {
        const fail = baseline.scorerFail;
        throw new Error(
          `baseline scorer ${fail.name} unusable: ${fail.reason} (log ${fail.logPath})`,
        );
      }
      for (const line of dryRunLines(config, baseline, repoRelPath)) console.log(line);
      return;
    }
    const result = await runHillClimb(config, deps);
    for (const line of summaryLines(result, artifactsDir)) console.log(line);
  } finally {
    // Whatever happened — kept, rejected, thrown — no worktree or branch outlives the run.
    cleanupRun(repoRoot, {
      runId,
      name: config.name,
      dirs: state.dirs,
      branches: state.branches,
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`hillclimb: ${error.message}`);
    process.exit(2);
  });
}
