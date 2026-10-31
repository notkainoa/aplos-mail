// Composes the brief each attempt agent receives: the configured brief plus the target name,
// allowed paths, the forbidden paths in plain words, the current scores and worst findings,
// and the working rules (small safe changes, targeted tests only, commit nothing). It only ever
// contains this structured input — never environment values or file contents — so an agent
// cannot learn a secret from its own prompt.
import { SUPPRESSION_HINT } from './diffguard.mjs';

const FORBIDDEN_WORDS = [
  'scripts/audit/ and tools/lint/ (the harness and lint tooling that score you)',
  'the target config file',
  'config and dotfile names: *.config.*, *.setup.*, budgets.json, stylelint*, tsconfig*.json(c), package.json, package-lock.json, .npmrc, .prettierrc*, .eslintrc*, .stylelintrc*, .eslintignore, .prettierignore, .stylelintignore, .editorconfig, Makefile, *.lock, .node-version, .nvmrc, in any workspace',
  'any file whose name contains baseline, snapshot or golden, and anything under __snapshots__/, __mocks__/ or fixtures/',
  '.github/, mockups/, plans/, .husky/, scripts/hooks/ and every .git* file',
  'existing test files (*.test.*, *.spec.*, test/, tests/, __tests__/, e2e/) unless the config lists them under allowedTestPaths',
  SUPPRESSION_HINT,
  'suppression-by-comment directives in added lines (eslint-disable, /* eslint rule: */ inline config, eslint-env, @ts-ignore, @ts-nocheck, @ts-expect-error, istanbul/c8/v8 ignore, stylelint-disable, prettier-ignore, biome-ignore, tslint:disable, nosonar, noqa, node:coverage, Stryker disable, __stryker identifiers, @knipignore/@lintignore) unless the config allows them',
  'symlinks, gitlinks and executable-bit changes',
];

export const RULES = [
  'Make small, safe improvements. Keep behaviour identical; this is refactoring, not a rewrite.',
  'Stay strictly inside the allowed paths; the harness rejects the whole attempt if you touch anything forbidden.',
  'Do NOT run the full gate suites yourself — the harness runs them under its own check lock; run only small, targeted checks on the files you touch.',
  "You run with the harness user's privileges — there is no sandbox: your permissions (dangerous mode / bypassPermissions under the real HOME) can reach other worktrees, ~/.gitconfig and the credential helper. Stay inside your worktree; never touch other checkouts, the main repo or its node_modules.",
  'Commit nothing — the harness reviews and commits your changes itself.',
];

const fmt = value => (Number.isInteger(value) ? String(value) : value.toFixed(2));

/**
 * @param {object} input
 * @param {object} input.config - validated target config (with .brief already resolved to text)
 * @param {number} input.combined - current combined score of the best code
 * @param {Array} input.scores - [{ name, score, details }] for the best code
 * @param {number} [input.round] - round number for context
 */
export function composeBrief({ config, combined, scores = [], round }) {
  const lines = [];
  lines.push(`# Hill-climb attempt: ${config.name}`);
  if (round != null) lines.push(`Round ${round} of ${config.roundLimit}.`);
  lines.push('', config.attempt.brief.trim(), '');
  lines.push('## Paths you may change');
  for (const glob of config.allowedPaths) lines.push(`- ${glob}`);
  if (config.allowedTestPaths.length) {
    lines.push('Test files you may also change:');
    for (const glob of config.allowedTestPaths) lines.push(`- ${glob}`);
  }
  lines.push('', '## You may NOT touch');
  for (const item of FORBIDDEN_WORDS) lines.push(`- ${item}`);
  lines.push('', '## Current scores (higher is better; improve them)');
  lines.push(`- combined: ${fmt(combined)}`);
  for (const scorer of scores) {
    lines.push(`- ${scorer.name}: ${fmt(scorer.score)}`);
  }
  const details = scores.flatMap(scorer => scorer.details ?? []).slice(0, 10);
  if (details.length) {
    lines.push('', '## Worst findings in the current best code');
    for (const detail of details) {
      lines.push(`- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    }
  }
  lines.push('', '## Gates (must all pass)');
  for (const gate of config.gates) lines.push(`- ${gate.name}: ${gate.command}`);
  lines.push('', '## How to work');
  for (const rule of RULES) lines.push(`- ${rule}`);
  return `${lines.join('\n')}\n`;
}
