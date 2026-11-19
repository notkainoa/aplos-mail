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
import { defaults } from './config.mjs';
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
  // There is no sandbox: the agent and gate commands could reach back into the user's own
  // checkout. Any change there rejects this attempt AND aborts the whole run — the sandbox
  // has failed and nothing that follows is trustworthy.
  const intact = async () => {
    try {
      await deps.verifyMainIntact?.(ctx);
      return true;
    } catch (error) {
      rec.verdict = `rejected: ${trimReason(error.message)}`;
      rec.abort = true;
      return false;
    }
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
    if (agent.logOverflow) {
      rec.verdict = `rejected: agent log exceeded ${config.maxLogMB ?? defaults.maxLogMB} MB cap (process group killed)`;
      return rec;
    }
    if (agent.timedOut) {
      rec.verdict = `rejected: agent timed out after ${config.attempt.timeoutSec}s`;
      return rec;
    }
    if (agent.code !== 0) {
      rec.verdict = `rejected: agent exited ${agent.code ?? agent.signal}`;
      return rec;
    }
    if (!(await intact())) return rec;
    const fin = await deps.finalizeAttempt(ctx);
    if (fin.flagged?.length) {
      rec.verdict = `rejected: index flags hide changes (${fin.flagged.slice(0, 3).join(', ')})`;
      return rec;
    }
    if (fin.leftover.length) {
      rec.verdict = `rejected: uncommitted changes remain (${fin.leftover.slice(0, 3).join(', ')})`;
      return rec;
    }
    rec.files = fileCount(fin.changes);
    const guard = checkDiff({
      changes: fin.changes,
      allowedPaths: config.allowedPaths,
      allowedTestPaths: config.allowedTestPaths,
      allowDirectives: config.allowDirectives ?? [],
      allowBinary: config.allowBinary ?? [],
      addedLines: fin.addedLines ?? [],
      binaryPaths: fin.binaryPaths ?? [],
      treePaths: fin.treePaths ?? [],
      fileSize: path => deps.fileSize?.(ctx, path),
      maxAddedFileKB: config.maxAddedFileKB,
      configPath: deps.configPath ?? null,
      readOldFile: path => deps.readOld(ctx, path),
      readNewFile: path => deps.readNew(ctx, path),
    });
    if (!guard.ok) {
      rec.verdict = `rejected: ${trimReason(guard.reasons.join('; '))}`;
      return rec;
    }
    rec.head = fin.head;
    ctx.head = fin.head;
    // Gates and scorers run in a FRESH worktree checked out at the attempt's commit — never
    // the agent's working tree, where uncommitted leftovers, ignored files (.env, dist,
    // coverage) and index flags could make tampered state pass the gates.
    const evalDir = await deps.prepareEval(ctx);
    const scored = await evaluate(evalDir, config, deps, ctx.id);
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
    if (!(await intact())) return rec;
    rec.verdict = 'candidate';
    return rec;
  } catch (error) {
    rec.verdict = `rejected: ${trimReason(error.message)}`;
    return rec;
  } finally {
    // The sandbox audit runs even when the attempt bailed early (timeout, non-zero exit,
    // a thrown dep): a breaching agent's damage matters more than its exit status, and a
    // failure here turns this attempt's verdict into rejected + aborts the run.
    await intact();
    await deps.removeAttempt(ctx).catch(() => {});
  }
}

function judgeRound(attempts, best, config) {
  const candidates = attempts.filter(a => a.verdict === 'candidate');
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.combined)) {
      candidate.verdict = 'rejected: combined score is not finite';
    }
  }
  // noRegress applies to EVERY candidate first — the best of the survivors wins, so a
  // dipping leader can no longer knock a valid second-best out of the round.
  const survivors = candidates
    .filter(a => a.verdict === 'candidate')
    .sort((a, b) => b.combined - a.combined)
    .filter(candidate => {
      const dipped = config.scorers.find(scorer => {
        if (!scorer.noRegress) return false;
        const score = candidate.scores[scorer.name];
        const base = best.scores[scorer.name];
        return !Number.isFinite(score) || (Number.isFinite(base) && score < base);
      });
      if (dipped) candidate.verdict = `rejected: noRegress scorer ${dipped.name} worsened`;
      return !dipped;
    });
  const winner = survivors[0];
  let kept = null;
  if (winner) {
    if (!(winner.combined > best.combined)) {
      winner.verdict = 'not kept: no gain over best';
    } else {
      winner.verdict = 'kept';
      kept = winner;
    }
    for (const other of survivors.slice(1)) other.verdict = 'not kept: lower score';
  }
  return { kept, gain: kept !== null };
}

/**
 * @param {object} config - validated target config
 * @param {object} deps - injected effects; see run.mjs for the real wiring:
 *   startCommit, configPath, prepareAttempt(ctx), prepareEval(ctx), runAttemptAgent(ctx, brief),
 *   finalizeAttempt(ctx) -> { head, changes, leftover, flagged, addedLines, binaryPaths,
 *   treePaths }, readOld(ctx, path), readNew(ctx, path), fileSize(ctx, path),
 *   removeAttempt(ctx), removeEval(ctx),
 *   verifyMainIntact(ctx), cleanup(), promote({fromSha, toSha, message}) -> {branch, sha},
 *   withCheckSlot(fn), runGate, runScorer, logPath(stepId, step), repoRoot, print(line)
 */
export async function runHillClimb(config, deps) {
  const { startCommit } = deps;
  try {
    // The baseline is scored in a clean worktree at the start commit — the same machinery
    // the attempts get — never in the user's checkout, where uncommitted changes would
    // poison every comparison.
    const baseCtx = { id: 'baseline', head: startCommit };
    let baseline;
    try {
      const baseDir = await deps.prepareEval(baseCtx);
      baseline = await evaluate(baseDir, config, deps, 'baseline');
    } finally {
      await deps.removeEval?.(baseCtx);
    }
    deps.print?.(
      `baseline: combined ${baseline.combined ?? 'n/a'}${baseline.gatesOk ? '' : ' (gates FAIL)'}`,
    );
    if (!baseline.gatesOk) {
      const fail = baseline.gateFail;
      throw new Error(`baseline gate ${fail.name} failed: ${fail.reason} (log ${fail.logPath})`);
    }
    if (baseline.scorerFail) {
      const fail = baseline.scorerFail;
      throw new Error(
        `baseline scorer ${fail.name} unusable: ${fail.reason} (log ${fail.logPath})`,
      );
    }
    if (!Number.isFinite(baseline.combined)) {
      throw new Error('baseline combined score is not finite — check scorer weights');
    }
    let best = {
      commit: startCommit,
      combined: baseline.combined,
      scores: toMap(baseline.scores),
      scoreList: baseline.scores,
    };
    const rounds = [];
    let noGain = 0;
    for (let round = 1; round <= config.roundLimit && noGain < config.stopAfterNoGain; round++) {
      const indexes = Array.from({ length: config.attemptsPerRound }, (_, i) => i + 1);
      const attempts = await pool(indexes, config.maxConcurrent, index =>
        runAttempt({ id: `r${round}a${index}`, round, index }, config, best, deps),
      );
      const breach = attempts.find(a => a.abort);
      if (breach) {
        throw new Error(`aborting run: ${breach.verdict}`);
      }
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
    // One last audit before the kept commit is promoted: the last attempt's checks ran
    // before judging, and only harness code ran since — verify nothing moved anyway.
    await deps.verifyMainIntact?.();
    const promoted = await deps.promote({
      fromSha: startCommit,
      toSha: best.commit,
      message: `hillclimb ${config.name} run ${deps.runId}: combined ${baseline.combined} -> ${best.combined}`,
    });
    return {
      startCommit,
      bestCommit: best.commit,
      bestBranch: promoted.branch,
      bestSha: promoted.sha,
      baseline,
      endCombined: best.combined,
      rounds,
    };
  } finally {
    await deps.cleanup?.();
  }
}
