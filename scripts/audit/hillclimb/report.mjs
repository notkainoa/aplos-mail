// Console reporting for the hill-climb harness: one table per round plus a final summary.
// Raw command output is never printed — failures show a log path and one truncated line.
const fmt = value =>
  value == null ? '-' : Number.isInteger(value) ? String(value) : value.toFixed(2);

function pad(rows) {
  const widths = rows[0].map((_, col) => Math.max(...rows.map(row => String(row[col]).length)));
  return rows.map(row =>
    row
      .map((cell, col) => String(cell).padEnd(widths[col]))
      .join('  ')
      .trimEnd(),
  );
}

/** One fixed-width table for a round: attempt, agent, files, gates, per-scorer, combined, verdict. */
export function roundTable(roundResult, scorerNames) {
  const header = ['attempt', 'agent', 'files', 'gates', ...scorerNames, 'combined', 'verdict'];
  const rows = [header];
  for (const attempt of roundResult.attempts) {
    rows.push([
      attempt.id,
      attempt.agent,
      attempt.files,
      attempt.gates,
      ...scorerNames.map(name => fmt(attempt.scores?.[name])),
      fmt(attempt.combined),
      attempt.verdict,
    ]);
  }
  return pad(rows);
}

/** The final summary block: start/end score, rounds, branch, logs. */
export function summaryLines(result, artifactsDir) {
  const lines = [
    'hill-climb summary',
    `  combined: ${fmt(result.baseline.combined)} -> ${fmt(result.endCombined)}`,
    `  rounds run: ${result.rounds.length} (${result.rounds.filter(r => r.gain).length} with a kept attempt)`,
    `  best branch: ${result.bestBranch} (${result.bestSha.slice(0, 10)})`,
    `  logs: ${artifactsDir}`,
  ];
  return lines;
}

/** What --dry-run prints: the baseline scores and the plan, no agent started. */
export function dryRunLines(config, baseline, repoRelPath) {
  const lines = [
    `dry run: ${config.name} (config ${repoRelPath})`,
    `  baseline combined: ${fmt(baseline.combined)}`,
    ...baseline.scores.map(s => `    ${s.name}: ${fmt(s.score)}`),
    `  plan: ${config.roundLimit} round(s) x ${config.attemptsPerRound} attempt(s),`,
    `        stop after ${config.stopAfterNoGain} no-gain round(s), ${config.maxConcurrent} in parallel`,
    `  gates: ${config.gates.map(g => g.name).join(', ') || '(none)'} (would run, skipped in dry run)`,
    `  agent: ${config.attempt.agent}${config.attempt.model ? ` (${config.attempt.model})` : ''}`,
    '  no agents started.',
  ];
  return lines;
}
