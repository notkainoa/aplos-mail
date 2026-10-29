// End-to-end: a real temp git repo, real worktrees, the real diff guard and the real
// gate/scorer runners; only the check-slot lock dir and the log dir are test-local. The
// `command` agent branches on its worktree name: r1a1 shrinks the count (score -10 -> -5,
// kept), r1a2 writes a file under scripts/audit/ which the always-forbidden rule rejects
// even though this config's allowedPaths includes it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { runHillClimb } from '../hillclimb/loop.mjs';
import { withCheckSlot } from '../hillclimb/lock.mjs';
import { runAgent } from '../hillclimb/agent.mjs';
import { runGate, runScorer } from '../hillclimb/steps.mjs';
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
} from '../hillclimb/worktree.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'hillclimb-e2e-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const repo = join(tmp, 'repo');
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' });

const SCORER = `import { readFileSync } from 'node:fs';
const n = Number(readFileSync('main/count.txt', 'utf8').trim());
console.log(JSON.stringify({ score: -n, details: [] }));
`;

const AGENT_COMMAND =
  'case "$(basename "$PWD")" in *a1) echo 5 > main/count.txt;; *a2) mkdir -p scripts/audit && echo x > scripts/audit/evil.mjs;; esac';

const config = {
  name: 'e2e-demo',
  allowedPaths: ['main/**', 'scripts/audit/**'],
  allowedTestPaths: [],
  gates: [{ name: 'g', command: 'exit 0', timeoutSec: 30 }],
  scorers: [{ name: 's', command: 'node score.mjs', weight: 1, noRegress: false, timeoutSec: 30 }],
  attempt: { agent: 'command', brief: 'improve it', timeoutSec: 60, command: AGENT_COMMAND },
  attemptsPerRound: 2,
  roundLimit: 1,
  stopAfterNoGain: 1,
  maxConcurrent: 2,
};

function seedRepo() {
  mkdirSync(join(repo, 'main'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), '{"name":"e2e","workspaces":[]}');
  writeFileSync(join(repo, 'score.mjs'), SCORER);
  writeFileSync(join(repo, 'main', 'count.txt'), '10\n');
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
}

describe('hill-climb end to end', () => {
  it('keeps the improving attempt, rejects the forbidden one, leaves one squashed best commit', async () => {
    seedRepo();
    const runId = `e2e-${process.pid.toString(36)}`;
    const root = runRoot(runId);
    const state = { dirs: [], branches: [] };
    const logs = join(tmp, 'logs');
    mkdirSync(logs);
    const deps = {
      repoRoot: repo,
      runId,
      configPath: null,
      startCommit: currentHead(repo),
      withCheckSlot: fn => withCheckSlot(fn, { dir: join(tmp, 'slot.lock'), pollMs: 20 }),
      logPath: (id, step) => join(logs, `${id}-${step}.log`),
      print: () => {},
      async prepareAttempt(ctx) {
        ctx.dir = attemptDir(root, ctx.round, ctx.index);
        ctx.branch = attemptBranch(config.name, runId, ctx.round, ctx.index);
        addWorktree(repo, { dir: ctx.dir, branch: ctx.branch, commit: ctx.commit });
        state.dirs.push(ctx.dir);
        state.branches.push(ctx.branch);
        linkNodeModules(repo, ctx.dir);
      },
      async runAttemptAgent(ctx, brief) {
        const briefFile = join(root, `${ctx.id}-brief.md`);
        writeFileSync(briefFile, brief);
        return runAgent(config.attempt, {
          briefFile,
          workdir: ctx.dir,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
          logPath: join(logs, `${ctx.id}-agent.log`),
        });
      },
      async finalizeAttempt(ctx) {
        commitAll(ctx.dir, `hillclimb ${ctx.id}`);
        const changes = diffBetween(ctx.dir, ctx.baseCommit);
        const leftover = statusPorcelain(ctx.dir).map(entry => entry.path);
        return { head: currentHead(ctx.dir), changes, leftover };
      },
      readOld: (ctx, path) => gitShow(ctx.dir, ctx.baseCommit, path),
      readNew: (ctx, path) =>
        existsSync(join(ctx.dir, path)) ? gitShow(ctx.dir, 'HEAD', path) : null,
      runGate: (gate, workdir, logPath) => runGate(gate, { workdir, logPath }),
      runScorer: (scorer, workdir, logPath) => runScorer(scorer, { workdir, logPath }),
      async removeAttempt(ctx) {
        if (ctx.dir) removeWorktree(repo, ctx.dir);
      },
      async promote({ fromSha, toSha, message }) {
        return squashToBest(repo, { name: config.name, runId, fromSha, toSha, message });
      },
      async cleanup() {
        cleanupRun(repo, {
          runId,
          name: config.name,
          dirs: state.dirs,
          branches: state.branches,
        });
      },
    };

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
