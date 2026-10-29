// Shared plumbing for the hill-climb scorers (roadmap 5.1c). A scorer is a CLI whose last
// non-empty stdout line is {"score": <finite number, higher is better>, "details": [<worst
// findings, worst first, at most 10>]}. Exit 0 means the score is valid; a tooling failure is
// one stderr line and a non-zero exit. Raw tool output never reaches stdout: it is appended to
// artifacts/hillclimb/scorers/<name>.log (artifacts/ is git-ignored).
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// The glob semantics are the boundary rule's: `dir/**` matches `dir` itself and everything below.
import { globToRegExp } from '../../../../tools/lint/eslint-plugin-aplos.mjs';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const artifactsDir = join(repoRoot, 'artifacts', 'hillclimb', 'scorers');

/** Files that never contain scorable code; skipped while walking so --scope can stay fast. */
const PRUNE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'release',
  'coverage',
  'artifacts',
  '.stryker-tmp',
]);

/** Every file under `dir`, sorted, as repo-relative posix paths. PRUNE_DIRS are not descended. */
export function repoFiles(root = repoRoot, dir = '') {
  const abs = join(root, dir);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!PRUNE_DIRS.has(entry.name)) files.push(...repoFiles(root, rel));
    } else if (entry.isFile()) files.push(rel);
  }
  return files;
}

/** The repo-relative files matching at least one glob, sorted and de-duplicated. */
export function expandGlobs(globs, root = repoRoot) {
  const res = globs.map(glob => globToRegExp(glob));
  return repoFiles(root).filter(file => res.some(re => re.test(file)));
}

/** Does `file` (repo-relative posix path) match the scope? An empty scope matches everything. */
export function inScope(file, scopes) {
  return scopes.length === 0 || scopes.some(glob => globToRegExp(glob).test(file));
}

/** Keeps only the members of `files` inside the scope. */
export function scoped(files, scopes) {
  return files.filter(file => inScope(file, scopes));
}

export class ScorerError extends Error {}

/**
 * Argument parsing shared by the scorers. `values` maps repeatable `--flag <v>` to a list key,
 * `flags` maps `--flag` to a boolean key, and `numbers`/`strings` map `--flag <v>` to
 * `{ key, default, oneOf? }`. Anything else is a ScorerError (exit 2, one stderr line).
 */
export function parseArgs(argv, { values = {}, flags = {}, numbers = {}, strings = {} } = {}) {
  const options = {};
  for (const key of Object.values(values)) options[key] = [];
  for (const def of Object.values(numbers)) options[def.key] = def.default;
  for (const def of Object.values(strings)) options[def.key] = def.default;
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg in values) {
      const value = args.shift();
      if (value === undefined) throw new ScorerError(`${arg} needs a value`);
      options[values[arg]].push(value);
    } else if (arg in numbers) {
      const value = Number(args.shift());
      if (!Number.isFinite(value) || value <= 0)
        throw new ScorerError(`${arg} needs a positive number`);
      options[numbers[arg].key] = value;
    } else if (arg in strings) {
      const def = strings[arg];
      const value = args.shift();
      if (value === undefined) throw new ScorerError(`${arg} needs a value`);
      if (def.oneOf && !def.oneOf.includes(value))
        throw new ScorerError(`${arg} must be one of ${def.oneOf.join(', ')}`);
      options[def.key] = value;
    } else if (arg in flags) options[flags[arg]] = true;
    else throw new ScorerError(`unknown argument ${arg}`);
  }
  return options;
}

/**
 * Runs `argv` with stdout+stderr appended to artifacts/hillclimb/scorers/<name>.log.
 * Returns { status, signal, error, stdout, stderr }; a timeout gives error 'ETIMEDOUT'.
 */
export function runLogged(name, argv, { cwd = repoRoot, timeoutMs = 0, env = {} } = {}) {
  mkdirSync(artifactsDir, { recursive: true });
  const started = Date.now();
  // NODE_TEST_CONTEXT marks a subprocess as belonging to a node --test run; a scorer run from
  // inside test:audit would otherwise make its own `node --test` skip every test file.
  const parentEnv = { ...process.env };
  delete parentEnv.NODE_TEST_CONTEXT;
  const run = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs || undefined,
    env: { ...parentEnv, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const header = `\n=== ${new Date().toISOString()} ${argv.join(' ')} (exit ${run.status ?? run.signal ?? run.error?.code}) ===\n`;
  appendFileSync(
    join(artifactsDir, `${name}.log`),
    header + (run.stdout ?? '') + (run.stderr ?? ''),
  );
  return { ...run, elapsedMs: Date.now() - started };
}

/** Reads a JSON file or throws a ScorerError naming why it is unusable. */
export function readJsonFile(file, what) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new ScorerError(`${what} was not written at ${file}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ScorerError(`${what} at ${file} is not JSON`);
  }
}

/** The repo-relative posix form of an absolute path (or the input if it is already relative). */
export function toRepoPath(file, root = repoRoot) {
  const rel = relative(root, file);
  return rel.split(sep).join('/');
}

/** The scorer's single stdout line: last line wins by contract, so nothing else may print. */
export function emitScore(score, details) {
  if (!Number.isFinite(score)) throw new ScorerError('computed score is not finite');
  const trimmed = [...details].slice(0, 10).map(line => String(line).slice(0, 200));
  process.stdout.write(`${JSON.stringify({ score, details: trimmed })}\n`);
}

/** Runs `main` when this file is the CLI entry point; failures exit non-zero with one line. */
export function runCli(importMetaUrl, main) {
  if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(importMetaUrl)) {
    main(process.argv.slice(2)).catch(error => {
      console.error(String(error.message ?? error).split('\n')[0]);
      process.exit(2);
    });
  }
}
