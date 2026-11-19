// Shared real-git wiring for the hill-climb end-to-end tests (not a test file itself).
// Each e2e test file creates its own tmp dir and repo via setupE2E so files can run in
// parallel — a full runHillClimb round costs several seconds of real spawns.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent } from '../hillclimb/agent.mjs';
import { withCheckSlot } from '../hillclimb/lock.mjs';
import { runGate, runScorer } from '../hillclimb/steps.mjs';
import {
  addedLines,
  addWorktree,
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
  linkNodeModules,
  lsTreePaths,
  mainCheckoutIntact,
  removeWorktree,
  runRoot,
  snapshotGitDir,
  snapshotModuleTrees,
  squashToBest,
  statusPorcelain,
} from '../hillclimb/worktree.mjs';

// Pure-shell scorer commands keep each e2e run to a single spawn per scorer invocation.
const SCORE_CMD = 'read n < main/count.txt; echo "{\\"score\\": $((-n)), \\"details\\": []}"';

// The tampered scorer: an ignored .env in the agent's worktree would report 999. A clean
// eval worktree only ever contains committed state, so it always sees -n.
const ENV_SCORE_CMD =
  'if [ -f .env ]; then echo "{\\"score\\": 999, \\"details\\": []}"; else read n < main/count.txt; echo "{\\"score\\": $((-n)), \\"details\\": []}"; fi';

const AGENT_COMMAND =
  'case "$(basename "$PWD")" in *a1) echo 5 > main/count.txt;; *a2) mkdir -p scripts/audit && echo x > scripts/audit/evil.mjs;; esac';

// a1 hides a change behind an index flag; a2 plants an ignored .env that would fool a scorer
// run in the dirty worktree into reporting 999 instead of -5.
const TAMPER_COMMAND =
  'case "$(basename "$PWD")" in *a1) git update-index --assume-unchanged main/count.txt && echo 5 > main/count.txt;; *a2) echo hacked > .env && echo 5 > main/count.txt;; esac';

const baseConfig = {
  name: 'e2e-demo',
  allowedPaths: ['main/**', 'scripts/audit/**'],
  allowedTestPaths: [],
  gates: [{ name: 'g', command: 'exit 0', timeoutSec: 30 }],
  scorers: [{ name: 's', command: SCORE_CMD, weight: 1, noRegress: false, timeoutSec: 30 }],
  attemptsPerRound: 2,
  roundLimit: 1,
  stopAfterNoGain: 1,
  maxConcurrent: 2,
};

export function setupE2E(tmp) {
  const repo = join(tmp, 'repo');
  const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' });

  function seedRepo({ gitignore = null } = {}) {
    rmSync(repo, { recursive: true, force: true });
    mkdirSync(join(repo, 'main'), { recursive: true });
    writeFileSync(join(repo, 'package.json'), '{"name":"e2e","workspaces":[]}');
    writeFileSync(join(repo, 'main', 'count.txt'), '10\n');
    if (gitignore) writeFileSync(join(repo, '.gitignore'), gitignore);
    git(['init', '-q']);
    git(['add', '-A']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  }

  // The same wiring run.mjs uses: agent worktree for the attempt, a fresh detached worktree
  // at the attempt's commit for gates/scorers, and a sandbox check on the main checkout.
  function makeDeps({ runConfig, runId, logs, linkOpts }) {
    const root = runRoot(runId);
    const startCommit = currentHead(repo);
    const state = { dirs: [], branches: [] };
    const deps = {
      repoRoot: repo,
      runId,
      configPath: null,
      startCommit,
      withCheckSlot: fn => withCheckSlot(fn, { dir: join(tmp, 'slot.lock'), pollMs: 20 }),
      logPath: (id, step) => join(logs, `${id}-${step}.log`),
      print: () => {},
      async prepareAttempt(ctx) {
        ctx.dir = attemptDir(root, ctx.round, ctx.index);
        ctx.branch = attemptBranch(runConfig.name, runId, ctx.round, ctx.index);
        addWorktree(repo, { dir: ctx.dir, branch: ctx.branch, commit: ctx.commit });
        state.dirs.push(ctx.dir);
        state.branches.push(ctx.branch);
        ctx.moduleRoots = linkNodeModules(repo, ctx.dir, linkOpts).map(r =>
          join(repo, r, 'node_modules'),
        );
      },
      async prepareEval(ctx) {
        ctx.evalDir = join(root, `${ctx.id}-eval`);
        addWorktree(repo, { dir: ctx.evalDir, commit: ctx.head });
        state.dirs.push(ctx.evalDir);
        ctx.moduleRoots = [
          ...new Set([
            ...(ctx.moduleRoots ?? []),
            ...linkNodeModules(repo, ctx.evalDir, linkOpts).map(r => join(repo, r, 'node_modules')),
          ]),
        ];
        // Baseline newly watched roots at link time, before eval gates/scorers run.
        if (ctx.moduleSnapshot) snapshotModuleTrees(ctx.moduleRoots, ctx.moduleSnapshot);
        return ctx.evalDir;
      },
      async removeEval(ctx) {
        if (ctx.evalDir) removeWorktree(repo, ctx.evalDir);
      },
      verifyMainIntact: mainCheckoutIntact(repo, startCommit),
      async runAttemptAgent(ctx, brief) {
        const briefFile = join(root, `${ctx.id}-brief.md`);
        writeFileSync(briefFile, brief);
        ctx.moduleSnapshot = snapshotModuleTrees(ctx.moduleRoots ?? []);
        ctx.gitSnapshot = snapshotGitDir(ctx.dir);
        return runAgent(runConfig.attempt, {
          briefFile,
          workdir: ctx.dir,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
          logPath: join(logs, `${ctx.id}-agent.log`),
        });
      },
      async finalizeAttempt(ctx) {
        commitAll(ctx.dir, `hillclimb ${ctx.id}`);
        ctx.head = currentHead(ctx.dir);
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
      readNew: (ctx, path) => gitShow(ctx.dir, ctx.head, path),
      fileSize: (ctx, path) => blobSize(ctx.dir, ctx.head, path),
      runGate: (gate, workdir, logPath) => runGate(gate, { workdir, logPath }),
      runScorer: (scorer, workdir, logPath) => runScorer(scorer, { workdir, logPath }),
      async removeAttempt(ctx) {
        if (ctx.evalDir) removeWorktree(repo, ctx.evalDir);
        if (ctx.dir) removeWorktree(repo, ctx.dir);
      },
      async promote({ fromSha, toSha, message }) {
        return squashToBest(repo, { name: runConfig.name, runId, fromSha, toSha, message });
      },
      async cleanup() {
        cleanupRun(repo, {
          runId,
          name: runConfig.name,
          dirs: state.dirs,
          branches: state.branches,
        });
      },
    };
    return { deps, root };
  }

  const config = {
    ...baseConfig,
    attempt: { agent: 'command', brief: 'improve it', timeoutSec: 60, command: AGENT_COMMAND },
  };
  const tamperConfig = {
    ...baseConfig,
    scorers: [{ name: 's', command: ENV_SCORE_CMD, weight: 1, noRegress: false, timeoutSec: 30 }],
    attempt: {
      agent: 'command',
      brief: 'improve it',
      timeoutSec: 60,
      command: TAMPER_COMMAND,
    },
  };

  return { repo, git, seedRepo, makeDeps, config, tamperConfig };
}
