#!/usr/bin/env node
// Hill-climb harness CLI. Usage:
//   node scripts/audit/hillclimb/run.mjs <config.json> [--dry-run] [--rounds <n>] [--attempts <n>] [--run-id <id>]
// Improves a target area in rounds against automatic scorers and gates, running parallel
// attempts in throwaway git worktrees (never the user's checkout). Leaves a local
// hillclimb/<name>/<runId>/best branch — squashed to one commit on the starting commit — and
// prints its name. Never pushes, never opens a PR. --dry-run validates the config, scores the
// baseline and prints the plan without starting any agent.
//
// THERE IS NO SANDBOX — the accepted risk, verbatim from ACCEPTED-RISK.md:
//
//   "Attempt agents and gate/scorer commands run with the operator's full privileges,
//   and nothing stops an agent writing outside its worktree. swe-2 runs with
//   --permission-mode dangerous and claude with --permission-mode bypassPermissions,
//   both under the real HOME: an attempt process can reach other worktrees and the main
//   checkout, ~/.gitconfig and the rest of global tooling config, and the credential
//   helper along with whatever logins the CLIs keep in HOME. The protections in this
//   directory are tripwires that detect and reject tampering; they are not walls that
//   prevent it. For anything heavier than a smoke run, use the dedicated Linux machine
//   or wrap the run in sandbox-exec. A full run is the default; --dry-run is opt-in."
//
// Cheap mitigations in place of a sandbox: the run refuses to start on a dirty main
// checkout, and after every attempt verifies the main checkout's HEAD and status are
// untouched; any change aborts the whole run. Run this from a dedicated clone with
// its own .git (git clone --reference <your checkout> <url> /tmp/hc-clone), not a
// linked worktree: other worktrees change the shared git dir and would read as a
// sandbox breach.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentEnv, briefFor, evalEnv, runAgent } from './agent.mjs';
import { evaluateScorers, runHillClimb } from './loop.mjs';
import { loadConfig, resolveBrief } from './config.mjs';
import { releaseHeldSlots, withCheckSlot } from './lock.mjs';
import { dryRunLines, roundTable, summaryLines } from './report.mjs';
import { runGate, runScorer } from './steps.mjs';
import {
  addedLines,
  addWorktree,
  assertDedicatedClone,
  attemptBranch,
  attemptDir,
  binaryPaths,
  blobSize,
  cleanupRun,
  commitAll,
  currentHead,
  diffBetween,
  gitShow,
  indexFlagViolations,
  lastLinkStats,
  linkNodeModules,
  lsTreePaths,
  mainCheckoutIntact,
  removeWorktree,
  runRoot,
  snapshotGitDir,
  snapshotModuleTrees,
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
 * Scrubs the harness's own environment at startup: every variable not on the eval or agent
 * allow-lists is deleted so a credential sitting in process.env can never leak into a gate,
 * scorer, agent or git child through an inherited name nobody forwarded on purpose.
 */
export function scrubProcessEnv(env = process.env) {
  const keep = new Set([...Object.keys(agentEnv(env)), ...Object.keys(evalEnv(env))]);
  for (const name of Object.keys(env)) {
    if (!keep.has(name)) delete env[name];
  }
}

/**
 * The real deps for runHillClimb: git worktrees under the run's tmpdir, gate/scorer commands
 * logged to artifacts/hillclimb/<runId>/ and serialized through the check-slot lock, and the
 * attempt agent spawned with a secret-free environment. `state` tracks dirs and branches so
 * cleanup (normal or signal) can remove them.
 */
export function realDeps({ config, repoRelPath, runId, artifactsDir, state }) {
  const root = runRoot(runId);
  const startCommit = currentHead(repoRoot);
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
  // Link a worktree's node_modules and report the file strategy when it changes — the
  // first call's answer (clone vs hardlink) normally stands for the whole run.
  const linkModules = dir => {
    const roots = linkNodeModules(repoRoot, dir);
    const { line } = lastLinkStats();
    if (line && state.lastModulesLine !== line) {
      state.lastModulesLine = line;
      console.log(`  ${line}`);
    }
    return roots.map(r => join(repoRoot, r, 'node_modules'));
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
      // The real node_modules dirs these links write through to — the post-attempt
      // write-through scan walks exactly this set.
      ctx.moduleRoots = linkModules(ctx.dir);
    },
    // A clean detached worktree checked out at a commit — where the baseline and every
    // attempt are actually gated and scored, free of uncommitted leftovers, ignored files
    // and index-flag tricks the agent's working tree could hide.
    async prepareEval(ctx) {
      ctx.evalDir = join(root, `${ctx.id}-eval`);
      addWorktree(repoRoot, { dir: ctx.evalDir, commit: ctx.head });
      state.dirs.push(ctx.evalDir);
      const evalRoots = linkModules(ctx.evalDir);
      ctx.moduleRoots = [...new Set([...(ctx.moduleRoots ?? []), ...evalRoots])];
      // Newly watched roots are baselined NOW — before the eval worktree's gates and
      // scorers run — so a write-through into them is evidence like any other. ONLY the new
      // eval roots: the roots watched since before the agent ran must never be passed again
      // (a post-run baseline is exactly how a swapped root would be adopted).
      if (ctx.moduleSnapshot) snapshotModuleTrees(evalRoots, ctx.moduleSnapshot);
      return ctx.evalDir;
    },
    async runAttemptAgent(ctx, briefText) {
      // The brief file sits next to the worktree, not inside it: inside, it would land in the
      // diff the guard analyses (and an agent could edit its own instructions mid-run).
      const briefFile = join(root, `${ctx.id}-brief.md`);
      writeFileSync(briefFile, briefText);
      // The module-tree + git-dir snapshots define "before the agent ran": afterwards
      // the sandbox audit re-walks the linked node_modules roots for ANY difference —
      // a restored mtime no longer hides a write — and re-hashes the shared git dir.
      ctx.moduleSnapshot = snapshotModuleTrees(ctx.moduleRoots ?? []);
      ctx.gitSnapshot = snapshotGitDir(ctx.dir);
      return runAgent(config.attempt, {
        briefFile,
        briefText: briefFor(config.attempt, briefFile),
        workdir: ctx.dir,
        env: agentEnv(),
        logPath: join(artifactsDir, `${ctx.id}-agent.log`),
        maxLogBytes: config.maxLogMB * 1024 * 1024,
        onSpawn: track,
      });
    },
    async finalizeAttempt(ctx) {
      commitAll(ctx.dir, `hillclimb ${config.name} ${ctx.id}`);
      ctx.head = currentHead(ctx.dir);
      // Everything the guard inspects is pinned to this attempt's explicit sha — the
      // commit the eval worktree is checked out at — never to a movable HEAD.
      const changes = diffBetween(ctx.dir, ctx.baseCommit, ctx.head);
      const added = addedLines(ctx.dir, ctx.baseCommit, ctx.head);
      const binary = binaryPaths(ctx.dir, ctx.baseCommit, ctx.head);
      const treePaths = lsTreePaths(ctx.dir, ctx.head);
      const flagged = indexFlagViolations(ctx.dir);
      const leftover = statusPorcelain(ctx.dir).map(entry => entry.path);
      return {
        head: ctx.head,
        changes,
        addedLines: added,
        binaryPaths: binary,
        treePaths,
        flagged,
        leftover,
      };
    },
    readOld: (ctx, path) => gitShow(ctx.dir, ctx.baseCommit, path),
    // "New" contents always come from the attempt's COMMIT, never the working tree: whatever
    // an agent left dirty, ignored or index-flagged cannot impersonate committed state.
    readNew: (ctx, path) => gitShow(ctx.dir, ctx.head, path),
    fileSize: (ctx, path) => blobSize(ctx.dir, ctx.head, path),
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
    verifyMainIntact: mainCheckoutIntact(repoRoot, startCommit),
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
  // Everything the harness itself needs was already read (argv); drop every env variable
  // that is not allow-listed before any child could inherit it.
  scrubProcessEnv();
  const { config, repoRelPath } = loadConfig(options.config, repoRoot);
  config.attempt.brief = resolveBrief(config.attempt.brief, repoRoot);
  if (options.rounds) config.roundLimit = options.rounds;
  if (options.attempts) config.attemptsPerRound = options.attempts;
  // The shared-git-dir snapshot is only meaningful when that dir is private to this
  // checkout: a sibling worktree's ordinary push/pull writes it mid-run and reads as
  // a breach. A linked worktree is refused outright — there is no override.
  assertDedicatedClone(repoRoot);
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
    process.exit(128 + (osConstants.signals[signal] ?? 15));
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

// realpath both sides: invoked as `node /var/.../run.mjs` on macOS, argv[1] keeps the
// symlinked spelling while import.meta.url carries the resolved one — comparing raw
// strings would skip main() entirely and exit 0 having done nothing.
if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
  main().catch(error => {
    console.error(`hillclimb: ${error.message}`);
    process.exit(2);
  });
}
