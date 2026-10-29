// Anti-gaming diff guard for the hill-climb harness. Pure functions over a change list
// ({status, path, oldPath?, oldMode?, newMode?} as produced by parseRawDiff in worktree.mjs
// plus untracked files as {status:'A'}) so every rule is unit-testable without git.
//
// An attempt is REJECTED when it touches anything outside allowedPaths, touches an always-
// forbidden path (audit and lint tooling, baselines, configs, hooks, plans, .github, .git*),
// modifies or deletes an existing test file outside allowedTestPaths, touches a suppressions
// file in any way that is not strictly shrinking it, adds a symlink/gitlink, or changes an
// executable bit. The guard errs toward rejecting: a false positive costs one attempt, a
// false negative lets an agent rewrite the scoreboard it is measured by.
// Glob matching for the guard. node:path.matchesGlob keeps two POSIX behaviours that are
// wrong for an anti-gaming check: '*' and '**' never match a leading dot (so ".baseline"
// escaped the forbidden-name list and "src/.env" escaped "src/**") and matching is
// case-sensitive ("PACKAGE.JSON" slipped past "package.json"). matchGlob compiles globs to
// regexes where '*'/'**' match dots too, supports '?', [...] classes and {a,b} braces, and
// both sides are slash-, NFC- and case-normalised before matching.
const expandBraces = glob => {
  const open = glob.indexOf('{');
  if (open === -1) {
    if (glob.includes('}')) throw new Error(`unbalanced "}" in glob "${glob}"`);
    return [glob];
  }
  const close = glob.indexOf('}', open);
  if (close === -1) throw new Error(`unbalanced "{" in glob "${glob}"`);
  const inner = glob.slice(open + 1, close);
  if (inner.includes('{') || inner.includes('}')) {
    throw new Error(`nested braces are not supported in glob "${glob}"`);
  }
  return inner
    .split(',')
    .flatMap(alt => expandBraces(glob.slice(0, open) + alt + glob.slice(close + 1)));
};

const ESCAPE = /[.*+^${}()|[\]\\]/g;
const lit = char => char.replace(ESCAPE, '\\$&');

const compileBody = glob => {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        while (glob[i] === '*') i++;
        if (glob[i] === '/') {
          i++;
          re += '(?:[^/]+/)*'; // "**/" = zero or more directories
        } else {
          re += '.*'; // trailing or sandwiched "**" crosses separators
        }
      } else {
        re += '[^/]*'; // '*' matches anything but '/', dots included
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '[') {
      let j = i + 1;
      const neg = glob[j] === '!' || glob[j] === '^';
      if (neg) j++;
      let cls = '';
      if (glob[j] === ']') {
        cls += ']';
        j++;
      }
      while (j < glob.length && glob[j] !== ']') {
        cls += glob[j] === '\\' ? '\\\\' : glob[j];
        j++;
      }
      if (j >= glob.length) throw new Error(`unterminated "[" in glob "${glob}"`);
      i = j + 1;
      re += neg ? `[^${cls}/]` : `[${cls}]`;
    } else if (c === '\\' && i + 1 < glob.length) {
      re += lit(glob[i + 1]);
      i += 2;
    } else {
      re += lit(c);
      i++;
    }
  }
  return re;
};

const compileGlob = glob => {
  const bodies = expandBraces(glob).map(compileBody);
  return new RegExp(`^(?:${bodies.join('|')})$`);
};

const globCache = new Map();
const compiled = glob => {
  let re = globCache.get(glob);
  if (!re) {
    re = compileGlob(glob);
    globCache.set(glob, re);
  }
  return re;
};

const slash = path => path.split('\\').join('/');
const norm = path => slash(path).normalize('NFC').toLowerCase();
const segments = path => slash(path).split('/');

/** Case-insensitive, dotfile-aware glob match; throws on a malformed glob. */
export function matchGlob(path, glob) {
  return compiled(norm(glob)).test(norm(path));
}

/** Syntax check used by config validation; false (never throws) for malformed globs. */
export function validGlob(glob) {
  try {
    compileGlob(glob);
    return true;
  } catch {
    return false;
  }
}

const matchesAny = (path, globs) => globs.some(glob => matchGlob(path, glob));
const nameMatches = (path, globs) => segments(path).some(segment => matchesAny(segment, globs));

// Touched in ANY way = rejected, even when a target lists them under allowedPaths.
// Directory globs are `**/`-anchored so they catch these roots nested under apps/desktop too;
// name globs are matched against the basename and every path segment, because "*golden*"
// must catch deep/golden/file.ts, not just a file literally called golden.
const FORBIDDEN_PATH_GLOBS = [
  '**/scripts/audit/**',
  '**/tools/lint/**',
  '**/.github/**',
  '**/mockups/**',
  '**/plans/**',
  '**/.husky/**',
  '**/scripts/hooks/**',
];
const FORBIDDEN_NAME_GLOBS = [
  'budgets.json',
  '*baseline*',
  '*snapshot*',
  '*golden*',
  'eslint.config.*',
  'stylelint*',
  'tsconfig*.json',
  'tsconfig*.jsonc',
  'package.json',
  'package-lock.json',
  '.git*',
  '*.config.*',
  '.npmrc',
  '.prettierrc*',
  '.eslintrc*',
  '.stylelintrc*',
  '.editorconfig',
  'vitest.config.*',
  'jest.config.*',
  'makefile',
  '*.lock',
  '.node-version',
  '.nvmrc',
];
const SUPPRESSION_NAMES = new Set(['eslint-suppressions.json', 'stylelint-suppressions.json']);
// Shared wording for the attempt brief; the rule itself lives in isShrinkOnly below.
export const SUPPRESSION_HINT =
  'eslint-suppressions.json and stylelint-suppressions.json except to shrink counts (no new files, rules or higher counts)';
const TEST_NAME_GLOBS = ['*.test.*', '*.spec.*'];
const SNAPSHOT_DIR = '__snapshots__';
const TEST_DIRS = new Set(['tests', '__tests__']);
const FORBIDDEN_MODES = new Set(['120000', '160000']); // symlink, gitlink
const EXECUTABLE = '100755';

// Suppression-by-comment: an attempt must not silence the linters it is scored by. Any of
// these appearing in an ADDED diff line rejects the attempt unless the target config's
// allowDirectives names it. Keys are the allowDirectives vocabulary.
export const SUPPRESSION_DIRECTIVES = {
  'eslint-disable': /eslint-disable/i,
  'ts-ignore': /@ts-ignore/i,
  'ts-nocheck': /@ts-nocheck/i,
  'ts-expect-error': /@ts-expect-error/i,
  'istanbul-ignore': /istanbul ignore/i,
  'c8-ignore': /c8 ignore/i,
  'stylelint-disable': /stylelint-disable/i,
  'prettier-ignore': /prettier-ignore/i,
};

/** True for files an attempt may not modify or delete unless allowedTestPaths allows it. */
export function isTestPath(path) {
  if (nameMatches(path, TEST_NAME_GLOBS)) return true;
  return segments(path).some(segment => TEST_DIRS.has(segment));
}

const isSuppressionPath = path => SUPPRESSION_NAMES.has(norm(segments(path).at(-1)));

const isSnapshotPath = path => segments(path).includes(SNAPSHOT_DIR);

/**
 * The reason a single path is always forbidden, or null. Suppression files are exempt from
 * the name list ("stylelint*" would match stylelint-suppressions.json) because rule (d)
 * governs them entirely.
 */
export function forbiddenReason(path, configPath) {
  const clean = norm(path);
  if (configPath && clean === norm(configPath)) return 'the target config file itself';
  if (isSuppressionPath(path)) return null;
  if (matchesAny(clean, FORBIDDEN_PATH_GLOBS)) {
    return 'always-forbidden path (audit/lint tooling, .github, mockups, plans or hooks)';
  }
  if (isSnapshotPath(clean)) return 'a file under __snapshots__/';
  if (nameMatches(clean, FORBIDDEN_NAME_GLOBS)) {
    return 'always-forbidden name (config, budget, baseline, snapshot, golden or .git*)';
  }
  return null;
}

function parseSuppressions(text, side) {
  try {
    const value = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { error: `${side} suppressions file is not a JSON object` };
    }
    return { value };
  } catch {
    return { error: `${side} suppressions file does not parse as JSON` };
  }
}

const asRules = (value, file, side) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: `${side} suppressions entry for ${file} is not an object` };
  }
  return { value };
};

const validCount = count => Number.isInteger(count) && count >= 0;
const countReason = (rule, file, side) =>
  `${side} count for ${rule} in ${file} is not a non-negative integer`;

/**
 * Shrink-only check for eslint/stylelint suppressions files. The new file must parse, add no
 * file or rule key the old one lacked, and never raise a count. EVERY count on both sides
 * must be an integer >= 0 — a negative or fractional count is gaming surface, not data.
 * `oldText` null means the file did not exist, so any content is an addition.
 */
export function isShrinkOnly(oldText, newText) {
  const newParsed = parseSuppressions(newText, 'new');
  if (newParsed.error) return { ok: false, reason: newParsed.error };
  const oldParsed = oldText == null ? { value: {} } : parseSuppressions(oldText, 'old');
  if (oldParsed.error) return { ok: false, reason: oldParsed.error };
  for (const [file, rules] of Object.entries(oldParsed.value)) {
    const oldRules = asRules(rules, file, 'old');
    if (oldRules.error) return { ok: false, reason: oldRules.error };
    for (const [rule, entry] of Object.entries(oldRules.value)) {
      if (!validCount(entry?.count)) {
        return { ok: false, reason: countReason(rule, file, 'old') };
      }
    }
  }
  for (const [file, rules] of Object.entries(newParsed.value)) {
    if (!(file in oldParsed.value)) {
      return { ok: false, reason: `adds suppressions for ${file}` };
    }
    const newRules = asRules(rules, file, 'new');
    if (newRules.error) return { ok: false, reason: newRules.error };
    const oldRules = { value: oldParsed.value[file] };
    for (const [rule, entry] of Object.entries(newRules.value)) {
      if (!(rule in oldRules.value)) {
        return { ok: false, reason: `adds suppressed rule ${rule} for ${file}` };
      }
      const newCount = entry?.count;
      if (!validCount(newCount)) {
        return { ok: false, reason: countReason(rule, file, 'new') };
      }
      const oldCount = oldRules.value[rule]?.count;
      if (newCount > oldCount) {
        return {
          ok: false,
          reason: `raises suppressed count of ${rule} in ${file} from ${oldCount} to ${newCount}`,
        };
      }
    }
  }
  return { ok: true };
}

function modeReason(change) {
  const { status, oldMode, newMode, path } = change;
  if (status === 'D') return null;
  if (FORBIDDEN_MODES.has(newMode)) {
    return `${path} is a ${newMode === '120000' ? 'symlink' : 'gitlink'}`;
  }
  if (
    oldMode &&
    newMode &&
    oldMode !== newMode &&
    (oldMode === EXECUTABLE || newMode === EXECUTABLE)
  ) {
    return `${path} changes executable bit (${oldMode} -> ${newMode})`;
  }
  return null;
}

// The "ends" a change touches: D touches only the old file, A only a new one, R/C both.
function endsOf(change) {
  const ends = [{ path: change.path, side: change.status === 'D' ? 'old' : 'new' }];
  if ((change.status === 'R' || change.status === 'C') && change.oldPath) {
    ends.push({ path: change.oldPath, side: 'old' });
  }
  return ends;
}

// A path that escapes the tree or plays normalisation tricks is rejected outright: after
// backslash->slash conversion, ".." segments and absolute forms are never legitimate here.
function unsafeReason(path) {
  if (path.startsWith('/') || /^[a-zA-Z]:\//.test(path)) return 'an absolute path';
  if (path.split('/').includes('..')) return 'a ".." segment';
  return null;
}

/**
 * Validates one attempt's change list. Options: changes, allowedPaths, allowedTestPaths,
 * configPath (repo-relative, forbidden always), allowDirectives (named suppression
 * directives the target permits), addedLines (added diff text for the directive scan),
 * readOldFile/readNewFile (path -> text or null, for the suppressions shrink check).
 * Returns { ok: true } or { ok: false, reasons }.
 */
export function checkDiff({
  changes,
  allowedPaths,
  allowedTestPaths = [],
  allowDirectives = [],
  addedLines = [],
  configPath = null,
  readOldFile,
  readNewFile,
}) {
  const reasons = [];
  const permitted = new Set(allowDirectives);
  for (const [name, pattern] of Object.entries(SUPPRESSION_DIRECTIVES)) {
    if (permitted.has(name)) continue;
    const hit = addedLines.find(line => pattern.test(line));
    if (hit) {
      reasons.push(
        `added line contains suppression directive "${name}": ${hit.trim().slice(0, 80)}`,
      );
    }
  }
  for (const change of changes) {
    const mode = modeReason(change);
    if (mode) reasons.push(mode);
    for (const end of endsOf(change)) {
      const path = slash(end.path);
      const unsafe = unsafeReason(path);
      if (unsafe) {
        reasons.push(`${path}: unsafe path (${unsafe})`);
        continue;
      }
      const forbidden = forbiddenReason(path, configPath);
      if (forbidden) {
        reasons.push(`${path}: forbidden (${forbidden})`);
        continue;
      }
      if (!matchesAny(path, allowedPaths)) {
        reasons.push(`${path}: outside allowedPaths`);
        continue;
      }
      if (isSuppressionPath(path)) {
        reasons.push(...suppressionReasons(change, end, { readOldFile, readNewFile }));
        continue;
      }
      const touchesExisting = end.side === 'old' || change.status === 'M';
      if (touchesExisting && isTestPath(path) && !matchesAny(path, allowedTestPaths)) {
        reasons.push(`${path}: existing test file not in allowedTestPaths`);
      }
    }
  }
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

function suppressionReasons(change, end, { readOldFile, readNewFile }) {
  const path = slash(end.path);
  // Deleting a suppressions file, or renaming one away, removes measurement instead of
  // shrinking it; the shrink check only makes sense old -> new on the same path.
  if (end.side === 'old') {
    return [`${path}: suppressions files may only shrink, not be deleted or renamed`];
  }
  const check = isShrinkOnly(readOldFile?.(path) ?? null, readNewFile?.(path) ?? '');
  return check.ok ? [] : [`${path}: ${check.reason}`];
}
