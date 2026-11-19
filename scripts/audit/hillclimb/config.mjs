// Target config loading and strict validation for the hill-climb harness.
// Every unknown key is an error that names the key: a misspelled option must never be
// silently ignored, because an ignored "allowedTestPaths" or "noRegress" would weaken the
// safety rules the harness is built around.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { SUPPRESSION_DIRECTIVES, validGlob } from './diffguard.mjs';

export const defaults = {
  attemptsPerRound: 4,
  roundLimit: 5,
  stopAfterNoGain: 2,
  maxConcurrent: 4,
  gateTimeoutSec: 300,
  scorerTimeoutSec: 300,
  attemptTimeoutSec: 1800,
  lockWaitMin: 180, // matches lock.mjs defaultTimeoutMs (3 h)
  maxAddedFileKB: 512,
  maxLogMB: 50,
};

export const agents = ['swe-2', 'claude', 'command'];

export class ConfigError extends Error {}

const TOP_KEYS = new Set([
  'name',
  'allowedPaths',
  'allowedTestPaths',
  'allowDirectives',
  'allowBinary',
  'maxAddedFileKB',
  'gates',
  'scorers',
  'attempt',
  'attemptsPerRound',
  'roundLimit',
  'stopAfterNoGain',
  'maxConcurrent',
  'lockWaitMin',
  'maxLogMB',
]);
const GATE_KEYS = new Set(['name', 'command', 'timeoutSec']);
const SCORER_KEYS = new Set(['name', 'command', 'weight', 'noRegress', 'timeoutSec']);
const ATTEMPT_KEYS = new Set(['agent', 'model', 'brief', 'timeoutSec', 'command']);

function unknownKeys(object, known, where) {
  for (const key of Object.keys(object)) {
    if (!known.has(key)) throw new ConfigError(`${where}: unknown key "${key}"`);
  }
}

function needString(value, where, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && value.trim() === '')) {
    throw new ConfigError(`${where} must be a non-empty string`);
  }
  return value;
}

function needTimeout(value, where, fallback, unit = 'seconds') {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${where} must be a positive number of ${unit}`);
  }
  return value;
}

function needPositiveInt(value, where, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${where} must be a positive integer`);
  }
  return value;
}

// Attempt log size lives between "always enough for debugging" and "a disk-fill attack":
// an integer megabyte count, bounded so a stray zero or absurd number fails at load time.
function needLogMB(value) {
  if (value === undefined) return defaults.maxLogMB;
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new ConfigError('maxLogMB must be an integer between 1 and 500');
  }
  return value;
}

function needStringList(value, where, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min) {
    throw new ConfigError(`${where} must be an array of at least ${min} glob(s)`);
  }
  return value.map((entry, i) => needString(entry, `${where}[${i}]`));
}

function needDirectives(value) {
  const list = needStringList(value, 'allowDirectives');
  for (const name of list) {
    if (!(name in SUPPRESSION_DIRECTIVES)) {
      throw new ConfigError(
        `allowDirectives: unknown directive "${name}" (known: ${Object.keys(SUPPRESSION_DIRECTIVES).join(', ')})`,
      );
    }
  }
  return list;
}

function needGate(entry, i) {
  const where = `gates[${i}]`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new ConfigError(`${where} must be an object`);
  }
  unknownKeys(entry, GATE_KEYS, where);
  return {
    name: needString(entry.name, `${where}.name`),
    command: needString(entry.command, `${where}.command`),
    timeoutSec: needTimeout(entry.timeoutSec, `${where}.timeoutSec`, defaults.gateTimeoutSec),
  };
}

function needGateList(value) {
  if (!Array.isArray(value)) throw new ConfigError('gates must be an array');
  return value.map(needGate);
}

function needScorer(entry, i) {
  const where = `scorers[${i}]`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new ConfigError(`${where} must be an object`);
  }
  unknownKeys(entry, SCORER_KEYS, where);
  const weight = entry.weight === undefined ? 1 : entry.weight;
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight === 0) {
    throw new ConfigError(`${where}.weight must be a non-zero finite number`);
  }
  if (entry.noRegress !== undefined && typeof entry.noRegress !== 'boolean') {
    throw new ConfigError(`${where}.noRegress must be a boolean`);
  }
  return {
    name: needString(entry.name, `${where}.name`),
    command: needString(entry.command, `${where}.command`),
    weight,
    noRegress: entry.noRegress ?? false,
    timeoutSec: needTimeout(entry.timeoutSec, `${where}.timeoutSec`, defaults.scorerTimeoutSec),
  };
}

function needAttempt(entry) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new ConfigError('attempt must be an object');
  }
  unknownKeys(entry, ATTEMPT_KEYS, 'attempt');
  const agent = needString(entry.agent, 'attempt.agent');
  if (!agents.includes(agent)) {
    throw new ConfigError(`attempt.agent must be one of ${agents.join(', ')}, got "${agent}"`);
  }
  if (agent === 'command' && (entry.command === undefined || entry.command.trim() === '')) {
    throw new ConfigError('attempt.command is required when attempt.agent is "command"');
  }
  if (agent !== 'command' && entry.command !== undefined) {
    throw new ConfigError('attempt.command is only allowed when attempt.agent is "command"');
  }
  if (entry.model !== undefined) needString(entry.model, 'attempt.model');
  return {
    agent,
    model: entry.model,
    brief: needString(entry.brief, 'attempt.brief'),
    timeoutSec: needTimeout(entry.timeoutSec, 'attempt.timeoutSec', defaults.attemptTimeoutSec),
    command: entry.command,
  };
}

// A name becomes a path segment in hillclimb/<name>/<runId>/ branches and a log folder, so it
// must be a slug git and every filesystem accept.
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Validates raw parsed JSON into a normalized config. Throws ConfigError naming the offending
 * key. `allowedTestPaths` defaults to [], loop counts to `defaults`.
 */
export function validateConfig(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('config must be a JSON object');
  }
  unknownKeys(raw, TOP_KEYS, 'config');
  const name = needString(raw.name, 'name');
  if (!NAME_PATTERN.test(name)) {
    throw new ConfigError(`name must match ${NAME_PATTERN} (used in branch names), got "${name}"`);
  }
  if (!Array.isArray(raw.scorers) || raw.scorers.length === 0) {
    throw new ConfigError('scorers must be a non-empty array');
  }
  const attempt = needAttempt(raw.attempt);
  const config = {
    name,
    allowedPaths: needStringList(raw.allowedPaths, 'allowedPaths', { min: 1 }),
    allowedTestPaths: raw.allowedTestPaths
      ? needStringList(raw.allowedTestPaths, 'allowedTestPaths')
      : [],
    allowDirectives: raw.allowDirectives ? needDirectives(raw.allowDirectives) : [],
    allowBinary: raw.allowBinary ? needStringList(raw.allowBinary, 'allowBinary') : [],
    gates: needGateList(raw.gates),
    scorers: raw.scorers.map(needScorer),
    attempt,
    attemptsPerRound: needPositiveInt(
      raw.attemptsPerRound,
      'attemptsPerRound',
      defaults.attemptsPerRound,
    ),
    roundLimit: needPositiveInt(raw.roundLimit, 'roundLimit', defaults.roundLimit),
    stopAfterNoGain: needPositiveInt(
      raw.stopAfterNoGain,
      'stopAfterNoGain',
      defaults.stopAfterNoGain,
    ),
    maxConcurrent: needPositiveInt(raw.maxConcurrent, 'maxConcurrent', defaults.maxConcurrent),
    maxAddedFileKB: needPositiveInt(raw.maxAddedFileKB, 'maxAddedFileKB', defaults.maxAddedFileKB),
    lockWaitMin: needTimeout(raw.lockWaitMin, 'lockWaitMin', defaults.lockWaitMin, 'minutes'),
    maxLogMB: needLogMB(raw.maxLogMB),
  };
  // Sanity check the globs now, not mid-run when an attempt is rejected for the wrong
  // reason — with the same matcher the diff guard uses, so a valid glob here is a valid
  // glob there.
  for (const [where, globs] of [
    ['allowedPaths', config.allowedPaths],
    ['allowedTestPaths', config.allowedTestPaths],
    ['allowBinary', config.allowBinary],
  ]) {
    for (const glob of globs) {
      if (!validGlob(glob)) throw new ConfigError(`${where}: invalid glob "${glob}"`);
    }
  }
  return config;
}

/**
 * Reads and validates a config file. Returns { config, configPath, repoRelPath } where
 * repoRelPath is the file's path relative to repoRoot (used by the diff guard; null when the
 * config lives outside the repo).
 */
export function loadConfig(path, repoRoot) {
  const configPath = resolve(path);
  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new ConfigError(`cannot read config ${path}: ${error.message}`);
  }
  const config = validateConfig(raw);
  const rel = relative(repoRoot, configPath);
  const repoRelPath = rel.startsWith('..') || isAbsolute(rel) ? null : rel.split(sep).join('/');
  return { config, configPath, repoRelPath };
}

/**
 * The brief text an attempt agent receives. A value ending in ".md" is a repo-relative path
 * that must exist; anything else is inline text. This rule is deliberately dumb so a config
 * can never accidentally inline a file's contents or read outside the repo.
 */
export function resolveBrief(brief, repoRoot) {
  if (!brief.endsWith('.md')) return brief;
  const file = resolve(repoRoot, brief);
  const rel = relative(repoRoot, file);
  if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(file)) {
    throw new ConfigError(`attempt.brief: no such brief file "${brief}" relative to repo root`);
  }
  return readFileSync(file, 'utf8');
}
