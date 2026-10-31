import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STATES, THEMES, type Theme, type VisualState } from '../states';
import { repoRoot, visualDir } from '../support/paths';

// Shared by every scorer in this folder. A scorer prints, as its last stdout line, one JSON object
// `{"score": 0..100, "details": [...]}` and exits 0 even when the score is low (see README.md).

export const MAX_DETAILS = 20;
export const DEFAULT_SIZE = '1440x900';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Clamps to 0..100 and rounds to 0.01. NaN scores 0. */
export function clampScore(score: number): number {
  if (Number.isNaN(score)) return 0;
  return Math.round(Math.min(100, Math.max(0, score)) * 100) / 100;
}

/** The single JSON line, without printing it. */
export function scoreLine(score: number, details: readonly string[]): string {
  const clean = details.slice(0, MAX_DETAILS).map(line => stripAnsi(String(line)).trim());
  return JSON.stringify({ score: clampScore(score), details: clean });
}

let shuttingDown = false;

/** Set by the signal handlers: from then on no score line is printed (the run was cut short). */
export function markShuttingDown(): void {
  shuttingDown = true;
}

/** Prints the score line. Call it last and write nothing else to stdout afterwards. */
export function printScore(score: number, details: readonly string[]): void {
  if (shuttingDown) return;
  process.stdout.write(`${scoreLine(score, details)}\n`);
}

/** Progress and diagnostics go to stderr so stdout stays clean for the harness. */
export function log(message: string): void {
  process.stderr.write(`${stripAnsi(message)}\n`);
}

export interface ScorerArgs {
  size: string;
  /** State id prefix; empty means every state. */
  state: string;
  themes: readonly Theme[];
  /** Skip re-shooting when fresh PNGs exist (scorers that shoot only). */
  reuse: boolean;
}

/** `--size 1440x900`, `--state <prefix>`, `--theme light|dark|both`, `--reuse`. Throws on bad input. */
export function parseArgs(argv: readonly string[]): ScorerArgs {
  const args: ScorerArgs = { size: DEFAULT_SIZE, state: '', themes: THEMES, reuse: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = (argv[i] ?? '').split('=', 2);
    const value = (): string => inline ?? argv[++i] ?? '';
    if (flag === '--size') args.size = value();
    else if (flag === '--state') args.state = value();
    else if (flag === '--theme') args.themes = parseThemes(value());
    else if (flag === '--reuse') args.reuse = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!/^\d+x\d+$/.test(args.size))
    throw new Error(`--size must look like 1440x900, got ${args.size}`);
  return args;
}

function parseThemes(value: string): readonly Theme[] {
  if (value === 'both') return THEMES;
  if (value === 'light' || value === 'dark') return [value];
  throw new Error(`--theme must be light, dark or both, got ${value}`);
}

export function parseSize(size: string): { width: number; height: number } {
  const [width, height] = size.split('x').map(Number);
  return { width: width ?? 1440, height: height ?? 900 };
}

export interface ScorerState {
  id: string;
  title: string;
  mockup: string;
  state: VisualState;
}

/** The states from tests/visual/states.ts whose id starts with the prefix (all when empty). */
export function stateList(prefix = ''): ScorerState[] {
  return STATES.filter(state => state.id.startsWith(prefix)).map(state => ({
    id: state.id,
    title: state.title,
    mockup: state.mockup,
    state,
  }));
}

/** Where the harness writes shots for a size: artifacts/visual/shots/<size>. */
export function shotsDir(size = DEFAULT_SIZE): string {
  return join(visualDir, 'shots', size);
}

export function shotPath(size: string, stateId: string, theme: Theme): string {
  return join(shotsDir(size), `${stateId}.${theme}.png`);
}

/** What a shot is rendered from: the renderer, the gallery and its support code, the shared packages. */
export const SOURCE_PATHS: readonly string[] = [
  join(repoRoot, 'apps', 'desktop', 'src', 'renderer'),
  join(repoRoot, 'packages'),
  join(repoRoot, 'tests', 'visual', 'gallery'),
  join(repoRoot, 'tests', 'visual', 'support'),
  join(repoRoot, 'tests', 'visual', 'vite.config.ts'),
  join(repoRoot, 'tests', 'visual', 'states.ts'),
];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git']);

/** The newest mtime (ms) of any file under the paths; 0 when none exist. */
export function newestMtime(paths: readonly string[]): number {
  let newest = 0;
  const visit = (path: string): void => {
    let info;
    try {
      info = statSync(path);
    } catch {
      return;
    }
    if (!info.isDirectory()) {
      newest = Math.max(newest, info.mtimeMs);
      return;
    }
    for (const name of readdirSync(path)) if (!SKIPPED_DIRS.has(name)) visit(join(path, name));
  };
  paths.forEach(visit);
  return newest;
}

let sourceMtimeMs: number | undefined;

/** The newest source mtime, computed once per process. */
export function newestSourceMtime(): number {
  sourceMtimeMs ??= newestMtime(SOURCE_PATHS);
  return sourceMtimeMs;
}

/**
 * True when the shot exists, is younger than `maxAgeMs` (default 1 hour) and is not older than the
 * newest source file it is rendered from, so `--reuse` can never score a screenshot of stale code.
 */
export function isFresh(
  path: string,
  maxAgeMs = 3_600_000,
  newestSourceMs = newestSourceMtime(),
): boolean {
  if (!existsSync(path)) return false;
  const modified = statSync(path).mtimeMs;
  return Date.now() - modified < maxAgeMs && modified >= newestSourceMs;
}
