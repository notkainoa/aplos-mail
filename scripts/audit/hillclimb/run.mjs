#!/usr/bin/env node
// Hill-climb harness CLI. Usage:
//   node scripts/audit/hillclimb/run.mjs <config.json> [--dry-run] [--rounds <n>] [--attempts <n>] [--run-id <id>]
// Improves a target area in rounds against automatic scorers and gates, running parallel
// attempts in throwaway git worktrees (never the user's checkout). Leaves a local
// hillclimb/<name>/<runId>/best branch — squashed to one commit on the starting commit — and
// prints its name. Never pushes, never opens a PR. --dry-run validates the config, scores the
// baseline and prints the plan without starting any agent.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { briefFor, filteredEnv, runAgent } from './agent.mjs';
import { evaluateScorers, runHillClimb } from './loop.mjs';
import { loadConfig, resolveBrief } from './config.mjs';
import { withCheckSlot } from './lock.mjs';
import { dryRunLines, roundTable, summaryLines } from './report.mjs';
import { runGate, runScorer } from './steps.mjs';
import {
  addWorktree,
  attemptBranch,
  attemptDir,
  cleanupRun,
  commitAll,
  currentHead,
  diffBetween,
  gitShow,
  linkNodeModules,
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
  const cleanupAll = () =>
    cleanupRun(repoRoot, {
      runId,
      name: config.name,
      dirs: state.dirs,
      branches: state.branches,
    });
  return {
    repoRoot,
    runId,
    configPath: repoRelPath,
    startCommit: currentHead(repoRoot),
    withCheckSlot: fn => withCheckSlot(fn),
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
        onSpawn: child => {
          state.procs.add(child);
          child.on('close', () => state.procs.delete(child));
        },
      });
    },
    async finalizeAttempt(ctx) {
      commitAll(ctx.dir, `hillclimb ${config.name} ${ctx.id}`);
      const changes = diffBetween(ctx.dir, ctx.baseCommit);
      const leftover = statusPorcelain(ctx.dir).map(entry => entry.path);
      return { head: currentHead(ctx.dir), changes, leftover };
    },
    readOld: (ctx, path) => gitShow(ctx.dir, ctx.baseCommit, path),
    readNew: (ctx, path) => {
      const file = join(ctx.dir, path);
      return existsSync(file) ? readFileSync(file, 'utf8') : null;
    },
    runGate: (gate, workdir, logPath) => runGate(gate, { workdir, logPath }),
    runScorer: (scorer, workdir, logPath) => runScorer(scorer, { workdir, logPath }),
    async removeAttempt(ctx) {
      if (ctx.dir) removeWorktree(repoRoot, ctx.dir);
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
  const runId = options.runId ?? newRunId();
  const artifactsDir = join(repoRoot, 'artifacts', 'hillclimb', runId);
  mkdirSync(artifactsDir, { recursive: true });
  const state = { dirs: [], branches: [], procs: new Set() };
  const deps = realDeps({ config, repoRelPath, runId, artifactsDir, state });

  const onSignal = signal => {
    // Kill live attempt process groups first so nothing keeps running in a deleted worktree.
    for (const child of state.procs) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already exited.
      }
    }
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

  if (options.dryRun) {
    const baseline = await evaluateScorers(repoRoot, config, deps, 'baseline');
    for (const line of dryRunLines(config, baseline, repoRelPath)) console.log(line);
    return;
  }
  const result = await runHillClimb(config, deps);
  for (const line of summaryLines(result, artifactsDir)) console.log(line);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`hillclimb: ${error.message}`);
    process.exit(2);
  });
}
