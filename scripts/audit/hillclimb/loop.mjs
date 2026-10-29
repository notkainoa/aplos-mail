// The hill-climb loop. runHillClimb(config, deps) keeps every effect behind an injectable
// dep (agent runner, gate/scorer runners, git operations, the check-slot wrapper, logging) so
// tests drive the whole loop with fakes and no git, process or network is needed.
//
// Round: score the current best, run attemptsPerRound attempts in parallel worktrees seeded
// from the best commit, guard + gate + score each, keep the single best attempt when its
// combined score strictly improves, every gate passed and no noRegress scorer dipped. Stop
// after stopAfterNoGain consecutive fruitless rounds or at roundLimit. At the end the kept
// head is squashed into ONE commit on the best branch; everything else is removed.
import { composeBrief } from './brief.mjs';
import { checkDiff } from './diffguard.mjs';

export function combinedScore(scorers, scoresByName) {
  return scorers.reduce((sum, scorer) => sum + scorer.weight * scoresByName[scorer.name], 0);
}

const toMap = scores => Object.fromEntries(scores.map(s => [s.name, s.score]));

/** Runs gates then scorers in `dir`, each inside the check slot. Shared by baseline + attempts. */
export async function evaluate(dir, config, deps, stepId) {
  const gates = [];
  for (const gate of config.gates) {
    const logPath = deps.logPath(stepId, `gate-${gate.name}`);
    const res = await deps.withCheckSlot(() => deps.runGate(gate, dir, logPath));
    gates.push({ name: gate.name, logPath, ...res });
    if (!res.ok) {
      return { gates, gatesOk: false, gateFail: { name: gate.name, logPath, ...res } };
    }
  }
  return { gates, gatesOk: true, ...(await evaluateScorers(dir, config, deps, stepId)) };
}

/** Scorers only — the baseline for --dry-run and the second half of evaluate(). */
export async function evaluateScorers(dir, config, deps, stepId) {
  const scores = [];
  for (const scorer of config.scorers) {
    const logPath = deps.logPath(stepId, `scorer-${scorer.name}`);
    const res = await deps.withCheckSlot(() => deps.runScorer(scorer, dir, logPath));
    if (!res.ok) {
      return { scores, combined: null, scorerFail: { name: scorer.name, logPath, ...res } };
    }
    scores.push({ name: scorer.name, score: res.score, details: res.details ?? [] });
  }
  return { scores, combined: combinedScore(config.scorers, toMap(scores)) };
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

const fileCount = changes =>
  new Set(changes.flatMap(c => [c.path, c.oldPath]).filter(Boolean)).size;

const trimReason = (text, max = 300) => (text.length > max ? `${text.slice(0, max)}…` : text);

async function runAttempt(ctx, config, best, deps) {
  const rec = {
    id: ctx.id,
    agent: config.attempt.agent,
    files: 0,
    gates: '-',
    scores: {},
    combined: null,
    verdict: 'rejected: unfinished',
  };
  try {
    // The ctx tells deps where to seed the worktree (the round's best) and what "old" means.
    ctx.commit = best.commit;
    ctx.baseCommit = deps.startCommit;
    await deps.prepareAttempt(ctx);
    const brief = composeBrief({
      config,
      combined: best.combined,
      scores: best.scoreList,
      round: ctx.round,
    });
    const agent = await deps.runAttemptAgent(ctx, brief);
    if (agent.timedOut) {
      rec.verdict = `rejected: agent timed out after ${config.attempt.timeoutSec}s`;
      return rec;
    }
    if (agent.code !== 0) {
      rec.verdict = `rejected: agent exited ${agent.code ?? agent.signal}`;
      return rec;
    }
    const fin = await deps.finalizeAttempt(ctx);
    if (fin.leftover.length) {
      rec.verdict = `rejected: uncommitted changes remain (${fin.leftover.slice(0, 3).join(', ')})`;
      return rec;
    }
    rec.files = fileCount(fin.changes);
    const guard = checkDiff({
      changes: fin.changes,
      allowedPaths: config.allowedPaths,
      allowedTestPaths: config.allowedTestPaths,
      configPath: deps.configPath ?? null,
      readOldFile: path => deps.readOld(ctx, path),
      readNewFile: path => deps.readNew(ctx, path),
    });
    if (!guard.ok) {
      rec.verdict = `rejected: ${trimReason(guard.reasons.join('; '))}`;
      return rec;
    }
    rec.head = fin.head;
    const scored = await evaluate(ctx.dir, config, deps, ctx.id);
    rec.gates = scored.gatesOk ? 'pass' : 'fail';
    if (!scored.gatesOk) {
      const fail = scored.gateFail;
      rec.verdict = `rejected: gate ${fail.name} failed (${fail.reason}${fail.failLine ? `: ${fail.failLine}` : ''}; log ${fail.logPath})`;
      return rec;
    }
    if (scored.scorerFail) {
      const fail = scored.scorerFail;
      rec.verdict = `rejected: scorer ${fail.name} unusable (${fail.reason}; log ${fail.logPath})`;
      return rec;
    }
    rec.scores = toMap(scored.scores);
    rec.scoreList = scored.scores;
    rec.combined = scored.combined;
    rec.verdict = 'candidate';
    return rec;
  } catch (error) {
    rec.verdict = `rejected: ${trimReason(error.message)}`;
    return rec;
  } finally {
    await deps.removeAttempt(ctx).catch(() => {});
  }
}

function judgeRound(attempts, best, config) {
  const candidates = attempts
    .filter(a => a.verdict === 'candidate')
    .sort((a, b) => b.combined - a.combined);
  const winner = candidates[0];
  if (!winner) return { kept: null, gain: false };
  const dipped = config.scorers.find(
    scorer => scorer.noRegress && winner.scores[scorer.name] < best.scores[scorer.name],
  );
  let kept = null;
  if (dipped) {
    winner.verdict = `rejected: noRegress scorer ${dipped.name} worsened`;
  } else if (winner.combined <= best.combined) {
    winner.verdict = 'not kept: no gain over best';
  } else {
    winner.verdict = 'kept';
    kept = winner;
  }
  for (const other of candidates.slice(1)) other.verdict = 'not kept: lower score';
  return { kept, gain: kept !== null };
}

/**
 * @param {object} config - validated target config
 * @param {object} deps - injected effects; see run.mjs for the real wiring:
 *   startCommit, configPath, prepareAttempt(ctx), runAttemptAgent(ctx, brief),
 *   finalizeAttempt(ctx) -> { head, changes, leftover }, readOld(ctx, path), readNew(ctx, path),
 *   removeAttempt(ctx), cleanup(), promote({fromSha, toSha, message}) -> {branch, sha},
 *   withCheckSlot(fn), runGate, runScorer, logPath(stepId, step), repoRoot, print(line)
 */
export async function runHillClimb(config, deps) {
  const { repoRoot, startCommit } = deps;
  const baseline = await evaluate(repoRoot, config, deps, 'baseline');
  deps.print?.(
    `baseline: combined ${baseline.combined ?? 'n/a'}${baseline.gatesOk ? '' : ' (gates FAIL)'}`,
  );
  let best = {
    commit: startCommit,
    combined: baseline.combined ?? Number.NEGATIVE_INFINITY,
    scores: baseline.scores ? toMap(baseline.scores) : {},
    scoreList: baseline.scores ?? [],
  };
  const rounds = [];
  let noGain = 0;
  for (let round = 1; round <= config.roundLimit && noGain < config.stopAfterNoGain; round++) {
    const indexes = Array.from({ length: config.attemptsPerRound }, (_, i) => i + 1);
    const attempts = await pool(indexes, config.maxConcurrent, index =>
      runAttempt({ id: `r${round}a${index}`, round, index }, config, best, deps),
    );
    const { kept, gain } = judgeRound(attempts, best, config);
    if (gain) {
      best = {
        commit: kept.head,
        combined: kept.combined,
        scores: kept.scores,
        scoreList: kept.scoreList,
      };
      noGain = 0;
    } else {
      noGain++;
    }
    rounds.push({ round, attempts, gain });
    deps.onRound?.(
      rounds.at(-1),
      config.scorers.map(scorer => scorer.name),
    );
  }
  const promoted = await deps.promote({
    fromSha: startCommit,
    toSha: best.commit,
    message: `hillclimb ${config.name} run ${deps.runId}: combined ${baseline.combined} -> ${best.combined}`,
  });
  await deps.cleanup?.();
  return {
    startCommit,
    bestCommit: best.commit,
    bestBranch: promoted.branch,
    bestSha: promoted.sha,
    baseline,
    endCombined: best.combined,
    rounds,
  };
}
