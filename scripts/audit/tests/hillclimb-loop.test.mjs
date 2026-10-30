import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { describe, it } from 'node:test';
import { runHillClimb } from '../hillclimb/loop.mjs';

// The loop's deps are all fakes; checkDiff itself is real, so diffguard cases here exercise
// the actual guard against fabricated change lists.
const config = {
  name: 'demo',
  allowedPaths: ['src/**'],
  allowedTestPaths: [],
  gates: [{ name: 'g', command: 'true', timeoutSec: 1 }],
  scorers: [{ name: 's', command: 'true', weight: 1, noRegress: false, timeoutSec: 1 }],
  attempt: { agent: 'command', brief: 'x', timeoutSec: 60, command: 'true' },
  attemptsPerRound: 2,
  roundLimit: 3,
  stopAfterNoGain: 2,
  maxConcurrent: 2,
};

const GOOD_CHANGE = [{ status: 'M', path: 'src/a.ts', oldMode: '100644', newMode: '100644' }];

// script: { baselineScore, baselineGateOk, baselineScorerOk,
//           attempts: { <id>: { score, gateOk, scorerOk, changes, leftover, flagged,
//                              addedLines, agentCode, breach } } }
function fakes(script = {}) {
  const calls = {
    prepared: [],
    evalPrepared: [],
    evalRemoved: [],
    gateDirs: [],
    scorerDirs: [],
    removed: [],
    promoted: null,
    cleaned: false,
    intact: 0,
  };
  const at = id => script.attempts?.[id] ?? {};
  const deps = {
    repoRoot: '/repo',
    runId: 't1',
    startCommit: 'C0',
    configPath: null,
    withCheckSlot: fn => fn(),
    logPath: (id, step) => `/logs/${id}-${step}.log`,
    print: () => {},
    async prepareAttempt(ctx) {
      ctx.dir = `/wt/${ctx.id}`;
      calls.prepared.push({ id: ctx.id, commit: ctx.commit });
    },
    async prepareEval(ctx) {
      ctx.evalDir = `/eval/${ctx.id}`;
      calls.evalPrepared.push(ctx.id);
      return ctx.evalDir;
    },
    async removeEval(ctx) {
      calls.evalRemoved.push(ctx.id);
    },
    async verifyMainIntact(ctx) {
      calls.intact++;
      const breach = at(ctx?.id).breach;
      if (breach) throw new Error(breach);
    },
    async runAttemptAgent(ctx) {
      const b = at(ctx.id);
      return {
        code: b.agentCode ?? 0,
        timedOut: b.agentTimedOut ?? false,
        logOverflow: b.logOverflow ?? false,
      };
    },
    async finalizeAttempt(ctx) {
      const b = at(ctx.id);
      ctx.head = `H-${ctx.id}`;
      return {
        head: ctx.head,
        changes: b.changes ?? GOOD_CHANGE,
        addedLines: b.addedLines ?? [],
        binaryPaths: b.binaryPaths ?? [],
        treePaths: b.treePaths ?? [],
        flagged: b.flagged ?? [],
        leftover: b.leftover ?? [],
      };
    },
    readOld: () => null,
    readNew: () => null,
    fileSize: (ctx, path) => at(ctx.id).sizes?.[path] ?? null,
    async runGate(_gate, dir) {
      calls.gateDirs.push(dir);
      if (basename(dir) === 'baseline') {
        const ok = script.baselineGateOk ?? true;
        return ok ? { ok: true } : { ok: false, reason: 'exit 1', failLine: 'lint blew up' };
      }
      const okGate = at(basename(dir)).gateOk ?? true;
      return okGate ? { ok: true } : { ok: false, reason: 'exit 1', failLine: 'g failed' };
    },
    async runScorer(_scorer, dir) {
      calls.scorerDirs.push(dir);
      if (basename(dir) === 'baseline') {
        if (script.baselineScorerOk === false) {
          return { ok: false, reason: 'last line is not JSON' };
        }
        return { ok: true, score: script.baselineScore ?? 10, details: ['d'] };
      }
      const b = at(basename(dir));
      if (b.scorerOk === false) return { ok: false, reason: 'last line is not JSON' };
      return { ok: true, score: b.score ?? 10, details: [] };
    },
    async removeAttempt(ctx) {
      calls.removed.push(ctx.id);
    },
    async promote({ fromSha, toSha }) {
      calls.promoted = { fromSha, toSha };
      return { branch: 'hillclimb/demo/t1/best', sha: 'BESTSHA' };
    },
    async cleanup() {
      calls.cleaned = true;
    },
  };
  return { deps, calls };
}

describe('runHillClimb', () => {
  it('keeps an attempt with a strictly better combined score', async () => {
    const { deps, calls } = fakes({ attempts: { r1a1: { score: 20 }, r1a2: { score: 15 } } });
    const result = await runHillClimb(config, deps);
    const [a1, a2] = result.rounds[0].attempts;
    assert.equal(a1.verdict, 'kept');
    assert.equal(a2.verdict, 'not kept: lower score');
    assert.deepEqual(calls.promoted, { fromSha: 'C0', toSha: 'H-r1a1' });
    assert.equal(result.endCombined, 20);
    assert.equal(calls.cleaned, true);
    for (const id of ['r1a1', 'r1a2', 'r2a1', 'r2a2', 'r3a1', 'r3a2']) {
      assert.ok(calls.removed.includes(id), `worktree of ${id} removed`);
    }
  });

  it('does not keep a tie', async () => {
    const { deps } = fakes({ attempts: { r1a1: { score: 10 }, r1a2: { score: 9 } } });
    const result = await runHillClimb(config, deps);
    assert.equal(result.rounds[0].attempts[0].verdict, 'not kept: no gain over best');
    assert.equal(result.rounds.length, 2); // two no-gain rounds stop the run
  });

  it('rejects an attempt whose gate fails', async () => {
    const { deps } = fakes({
      attempts: { r1a1: { score: 30, gateOk: false }, r1a2: { score: 11 } },
    });
    const result = await runHillClimb(config, deps);
    const [a1] = result.rounds[0].attempts;
    assert.equal(a1.gates, 'fail');
    assert.match(a1.verdict, /rejected: gate g failed.*g failed/);
  });

  it('rejects a noRegress violation even when combined improves', async () => {
    const noRegress = {
      ...config,
      scorers: [
        { name: 's', command: 't', weight: 1, noRegress: true, timeoutSec: 1 },
        { name: 't', command: 't', weight: 1, noRegress: false, timeoutSec: 1 },
      ],
    };
    const { deps, calls } = fakes({});
    // Baseline: s=10, t=10 (combined 20). Attempt: s dips to 8 but t=30 (combined 38) -> reject.
    // ('/repo' covers the pre-eval-worktree baseline dir so this test fails on old code for
    // the right reason only.)
    deps.runScorer = async (scorer, dir) => {
      if (['baseline', 'repo'].includes(basename(dir))) {
        return { ok: true, score: 10, details: [] };
      }
      return { ok: true, score: scorer.name === 's' ? 8 : 30, details: [] };
    };
    const result = await runHillClimb(noRegress, deps);
    assert.match(result.rounds[0].attempts[0].verdict, /noRegress scorer s worsened/);
    assert.equal(result.endCombined, 20); // never kept
    assert.equal(calls.promoted.toSha, 'C0');
  });

  it('keeps the best SURVIVING candidate when the leader breaks noRegress', async () => {
    const noRegress = {
      ...config,
      scorers: [
        { name: 's', command: 't', weight: 1, noRegress: true, timeoutSec: 1 },
        { name: 't', command: 't', weight: 1, noRegress: false, timeoutSec: 1 },
      ],
    };
    const { deps } = fakes({});
    // Baseline s=t=10. r1a1: s dips to 8, t=40 (combined 48) -> out. r1a2: s=10, t=12 -> kept.
    deps.runScorer = async (scorer, dir) => {
      const id = basename(dir);
      if (['baseline', 'repo'].includes(id)) return { ok: true, score: 10, details: [] };
      if (id === 'r1a1') return { ok: true, score: scorer.name === 's' ? 8 : 40, details: [] };
      return { ok: true, score: scorer.name === 's' ? 10 : 12, details: [] };
    };
    const result = await runHillClimb({ ...noRegress, roundLimit: 1 }, deps);
    const [a1, a2] = result.rounds[0].attempts;
    assert.match(a1.verdict, /noRegress scorer s worsened/);
    assert.equal(a2.verdict, 'kept');
    assert.equal(result.endCombined, 22);
  });

  it('rejects a candidate whose combined score is not finite', async () => {
    const { deps } = fakes({ attempts: { r1a1: { score: Number.POSITIVE_INFINITY } } });
    const result = await runHillClimb({ ...config, roundLimit: 1 }, deps);
    assert.match(result.rounds[0].attempts[0].verdict, /not finite/);
  });

  it('rejects an attempt flagged by assume-unchanged or skip-worktree bits', async () => {
    const { deps } = fakes({
      attempts: { r1a1: { score: 99, flagged: ['src/a.ts'] }, r1a2: { score: 11 } },
    });
    const result = await runHillClimb({ ...config, roundLimit: 1 }, deps);
    assert.match(result.rounds[0].attempts[0].verdict, /index flags hide changes.*src\/a\.ts/);
    assert.equal(result.rounds[0].attempts[1].verdict, 'kept');
  });

  it('rejects added suppression directives unless the config allows them', async () => {
    const attempt = {
      score: 30,
      addedLines: ['const x = 1; // eslint-disable-next-line no-unused-vars'],
    };
    const { deps } = fakes({ attempts: { r1a1: attempt, r1a2: { score: 11 } } });
    const result = await runHillClimb({ ...config, roundLimit: 1 }, deps);
    assert.match(result.rounds[0].attempts[0].verdict, /rejected:.*eslint-disable/);

    const allowed = { ...config, roundLimit: 1, allowDirectives: ['eslint-disable'] };
    const { deps: deps2 } = fakes({ attempts: { r1a1: attempt } });
    const result2 = await runHillClimb(allowed, deps2);
    assert.equal(result2.rounds[0].attempts[0].verdict, 'kept');
  });

  it('aborts the whole run when the main checkout is touched (sandbox breach)', async () => {
    const { deps, calls } = fakes({
      attempts: {
        r1a1: { breach: 'main checkout dirtied during the run (package.json): sandbox breach' },
        r1a2: { score: 99 },
      },
    });
    await assert.rejects(
      runHillClimb({ ...config, roundLimit: 1 }, deps),
      /aborting run.*sandbox breach/,
    );
    assert.equal(calls.promoted, null); // nothing is promoted after a breach
    assert.equal(calls.cleaned, true); // but cleanup still ran
  });

  it('runs the sandbox audit even when the agent bails early (timeout, exit)', async () => {
    const { deps, calls } = fakes({
      attempts: {
        r1a1: { agentTimedOut: true, breach: 'node_modules write-through (x.js): sandbox breach' },
        r1a2: { agentCode: 137 },
      },
    });
    await assert.rejects(
      runHillClimb({ ...config, roundLimit: 1 }, deps),
      /aborting run.*write-through/,
    );
    assert.equal(calls.promoted, null);
  });

  it('audits the main checkout once more before promoting the best', async () => {
    const { deps, calls } = fakes({ attempts: { r1a1: { score: 20 } } });
    // A breach surfacing only after the attempts (e.g. a timed-out agent's delayed
    // write) must still stop the promotion.
    const inner = deps.verifyMainIntact;
    deps.verifyMainIntact = async ctx => {
      if (!ctx) throw new Error('main checkout dirtied (late write): sandbox breach');
      return inner(ctx);
    };
    await assert.rejects(
      runHillClimb({ ...config, roundLimit: 1 }, deps),
      /late write.*sandbox breach/,
    );
    assert.equal(calls.promoted, null);
  });

  it('rejects an attempt whose tree has case/unicode-colliding paths', async () => {
    const { deps } = fakes({
      attempts: {
        r1a1: {
          score: 99,
          treePaths: ['src/Foo.test.ts', 'src/foo.test.ts', 'src/ok.ts'],
        },
        r1a2: { score: 11 },
      },
    });
    const result = await runHillClimb({ ...config, roundLimit: 1 }, deps);
    const [a1, a2] = result.rounds[0].attempts;
    assert.match(a1.verdict, /rejected:.*collide.*Foo\.test\.ts/);
    assert.equal(a2.verdict, 'kept');
  });

  it('rejects an attempt adding a binary file or one over maxAddedFileKB', async () => {
    const { deps } = fakes({
      attempts: {
        r1a1: {
          score: 99,
          changes: [{ status: 'A', path: 'src/x.bin', oldMode: '000000', newMode: '100644' }],
          binaryPaths: ['src/x.bin'],
        },
        r1a2: {
          score: 88,
          changes: [{ status: 'A', path: 'src/huge.ts', oldMode: '000000', newMode: '100644' }],
          sizes: { 'src/huge.ts': 600 * 1024 },
        },
      },
    });
    const result = await runHillClimb({ ...config, roundLimit: 1 }, deps);
    const [a1, a2] = result.rounds[0].attempts;
    assert.match(a1.verdict, /rejected:.*binary file/);
    assert.match(a2.verdict, /rejected:.*exceeds 512 KB/);
  });

  it('aborts with a clear error when the baseline gate fails', async () => {
    const { deps, calls } = fakes({ baselineGateOk: false });
    await assert.rejects(runHillClimb(config, deps), /baseline gate g failed.*exit 1/);
    assert.equal(calls.prepared.length, 0); // no attempts were ever spawned
    assert.equal(calls.promoted, null);
    assert.equal(calls.cleaned, true);
  });

  it('aborts with a clear error when the baseline scorer is unusable', async () => {
    const { deps } = fakes({ baselineScorerOk: false });
    await assert.rejects(runHillClimb(config, deps), /baseline scorer s unusable.*not JSON/);
  });

  it('gates and scores the baseline in a clean eval worktree, not the repo', async () => {
    const { deps, calls } = fakes({ attempts: { r1a1: { score: 20 } } });
    await runHillClimb({ ...config, roundLimit: 1 }, deps);
    assert.ok(calls.evalPrepared.includes('baseline'));
    assert.ok(calls.evalRemoved.includes('baseline'));
    // The repo checkout is never handed to a gate or scorer.
    assert.ok(!calls.gateDirs.includes('/repo'));
    assert.ok(!calls.scorerDirs.includes('/repo'));
    assert.ok(calls.gateDirs.includes('/eval/baseline'));
  });

  it("runs each attempt's gates in a fresh eval worktree, not the agent dir", async () => {
    const { deps, calls } = fakes({ attempts: { r1a1: { score: 20 }, r1a2: { score: 11 } } });
    await runHillClimb({ ...config, roundLimit: 1 }, deps);
    for (const dir of calls.gateDirs) assert.match(dir, /^\/eval\//);
    for (const dir of calls.scorerDirs) assert.match(dir, /^\/eval\//);
    assert.ok(calls.gateDirs.includes('/eval/r1a1'));
  });

  it('rejects an attempt that touches forbidden files', async () => {
    const { deps } = fakes({
      attempts: {
        r1a1: {
          score: 99,
          changes: [
            ...GOOD_CHANGE,
            { status: 'M', path: 'package.json', oldMode: '100644', newMode: '100644' },
          ],
        },
        r1a2: { score: 11 },
      },
    });
    const result = await runHillClimb(config, deps);
    assert.match(result.rounds[0].attempts[0].verdict, /rejected:.*package\.json/);
  });

  it('rejects an attempt whose scorer output is unusable', async () => {
    const { deps } = fakes({
      attempts: { r1a1: { scorerOk: false }, r1a2: { score: 11 } },
    });
    const result = await runHillClimb(config, deps);
    assert.match(result.rounds[0].attempts[0].verdict, /scorer s unusable.*not JSON/);
  });

  it('rejects an attempt that fails the agent step or leaves changes', async () => {
    const { deps } = fakes({
      attempts: {
        r1a1: { agentCode: 137 },
        r1a2: { leftover: ['src/left.ts'] },
      },
    });
    const result = await runHillClimb(config, deps);
    assert.match(result.rounds[0].attempts[0].verdict, /agent exited 137/);
    assert.match(result.rounds[0].attempts[1].verdict, /uncommitted changes remain/);
  });

  it('rejects an attempt whose log overran the cap before judging exit code', async () => {
    const { deps } = fakes({
      attempts: {
        r1a1: { logOverflow: true, agentCode: null },
      },
    });
    const result = await runHillClimb({ ...config, maxLogMB: 7 }, deps);
    assert.match(result.rounds[0].attempts[0].verdict, /log exceeded 7 MB cap/);
  });

  it('stops after stopAfterNoGain consecutive fruitless rounds', async () => {
    const { deps } = fakes({}); // everything scores the baseline 10: no gain ever
    const result = await runHillClimb({ ...config, roundLimit: 9, stopAfterNoGain: 2 }, deps);
    assert.equal(result.rounds.length, 2);
  });

  it('runs to roundLimit while every round gains', async () => {
    const { deps } = fakes({
      attempts: {
        r1a1: { score: 20 },
        r1a2: { score: 10 },
        r2a1: { score: 30 },
        r2a2: { score: 10 },
        r3a1: { score: 40 },
        r3a2: { score: 10 },
      },
    });
    const result = await runHillClimb(config, deps);
    assert.equal(result.rounds.length, 3);
    assert.equal(result.endCombined, 40);
  });

  it('picks the best of several candidates', async () => {
    const { deps } = fakes({
      attempts: { r1a1: { score: 12 }, r1a2: { score: 25 } },
    });
    const result = await runHillClimb({ ...config, attemptsPerRound: 4 }, deps);
    assert.equal(result.rounds[0].attempts.length, 4);
    const kept = result.rounds[0].attempts.find(a => a.verdict === 'kept');
    assert.equal(kept.id, 'r1a2');
  });

  it('seeds round 2 attempts from the kept commit', async () => {
    const { deps, calls } = fakes({
      attempts: {
        r1a1: { score: 20 },
        r1a2: { score: 10 },
        r2a1: { score: 21 },
        r2a2: { score: 10 },
      },
    });
    await runHillClimb({ ...config, roundLimit: 2 }, deps);
    const roundTwo = calls.prepared.filter(p => p.id.startsWith('r2'));
    assert.ok(roundTwo.length > 0);
    for (const p of roundTwo) assert.equal(p.commit, 'H-r1a1');
  });

  it('still promotes a no-improvement run into a best branch on the start commit', async () => {
    const { deps, calls } = fakes({});
    const result = await runHillClimb({ ...config, roundLimit: 1 }, deps);
    assert.deepEqual(calls.promoted, { fromSha: 'C0', toSha: 'C0' });
    assert.equal(result.bestBranch, 'hillclimb/demo/t1/best');
  });
});
