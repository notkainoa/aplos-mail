import { chromium, type Browser } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Theme } from '../states';
import { openState } from '../support/gallery';
import { repoRoot, visualDir } from '../support/paths';
import {
  isFresh,
  log,
  parseArgs,
  parseSize,
  printScore,
  shotPath,
  stateList,
  type ScorerArgs,
  type ScorerState,
} from './common';
import { startGalleryServer } from './server';
import {
  DEFAULT_MODEL,
  criterionIds,
  dataStatesOf,
  judgeState,
  loadRubric,
  mockupStateQuery,
  parseMockupRef,
  summarise,
  type Judge,
  type JudgeImage,
  type StateJudgement,
} from './taste-score';

// Hill-climb scorer: Claude Sonnet judges screenshots against a condensed rubric of plans/DESIGN.md
// (taste.rubric.md) and the matching mockup. Usage: npx tsx tests/visual/scorers/taste.score.ts
// [--size 1440x900] [--state prefix] [--theme light|dark|both] [--reuse] [--samples N] [--runs K].
// --state overrides the default list in taste.sample.json; --samples N keeps the first N states;
// --runs K asks K times per state (a different cache entry each) and takes the median per criterion.
// One judge call per state per run covers both themes. Needs a logged-in `claude` (env CLAUDE_BIN).

const HERE = import.meta.dirname;
const CACHE_DIR = join(visualDir, 'judge-cache');
const REFERENCE_DIR = join(visualDir, 'judge-ref');
const JUDGE_TIMEOUT_MS = 300_000;
const CONCURRENCY = 2;

interface TasteArgs {
  base: ScorerArgs;
  samples: number;
  runs: number;
}

function parseTasteArgs(argv: readonly string[]): TasteArgs {
  const rest: string[] = [];
  let samples = 0;
  let runs = 1;
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = (argv[i] ?? '').split('=', 2);
    const value = (): number => Number(inline ?? argv[++i]);
    if (flag === '--samples') samples = value();
    else if (flag === '--runs') runs = value();
    else rest.push(argv[i] as string);
  }
  if (!Number.isInteger(samples) || samples < 0)
    throw new Error('--samples must be a whole number');
  if (!Number.isInteger(runs) || runs < 1)
    throw new Error('--runs must be a whole number of 1 or more');
  return { base: parseArgs(rest), samples, runs };
}

function sampleStates(args: TasteArgs): ScorerState[] {
  let entries: ScorerState[];
  if (args.base.state) entries = stateList(args.base.state);
  else {
    const listed = JSON.parse(readFileSync(join(HERE, 'taste.sample.json'), 'utf8')) as {
      states: string[];
    };
    const all = stateList();
    entries = listed.states.flatMap(id => all.find(entry => entry.id === id) ?? []);
  }
  if (entries.length === 0) throw new Error(`no state matches "${args.base.state}"`);
  return args.samples ? entries.slice(0, args.samples) : entries;
}

async function shoot(
  browser: Browser,
  origin: string,
  size: string,
  entry: ScorerState,
  theme: Theme,
): Promise<string> {
  const file = shotPath(size, entry.id, theme);
  const context = await browser.newContext({
    baseURL: origin,
    viewport: parseSize(size),
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    await openState(page, entry.state, { theme });
    mkdirSync(dirname(file), { recursive: true });
    await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
    return file;
  } finally {
    await context.close();
  }
}

/** The mockup page for a state, shot like mockups/shoot.cjs does; null with the reason when skipped. */
async function shootReference(
  browser: Browser,
  size: string,
  entry: ScorerState,
  theme: Theme,
): Promise<{ path: string } | { skip: string }> {
  const ref = parseMockupRef(entry.mockup);
  if (!ref) return { skip: `mockup "${entry.mockup}" has no file and state` };
  const page = join(repoRoot, 'mockups', ref.file);
  if (!existsSync(page)) return { skip: `${ref.file} does not exist` };
  const query = mockupStateQuery(ref.state, dataStatesOf(readFileSync(page, 'utf8')));
  if (query === null) return { skip: `${ref.file} has no state "${ref.state}"` };
  const file = join(
    REFERENCE_DIR,
    size,
    `${ref.file.replace('.html', '')}-${query || 'default'}.${theme}.png`,
  );
  const context = await browser.newContext({
    viewport: parseSize(size),
    deviceScaleFactor: 1,
    colorScheme: theme,
  });
  try {
    const tab = await context.newPage();
    await tab.goto(`file://${page}?shot=1&theme=${theme}${query ? `&state=${query}` : ''}`);
    await tab.evaluate(() => document.fonts.ready);
    await tab.waitForTimeout(700);
    mkdirSync(dirname(file), { recursive: true });
    await tab.screenshot({ path: file });
    return { path: file };
  } finally {
    await context.close();
  }
}

interface Prepared {
  entry: ScorerState;
  images: JudgeImage[];
  referenceNote?: string;
  skipped?: string;
}

async function prepare(
  browser: Browser,
  origin: string,
  args: TasteArgs,
  entry: ScorerState,
): Promise<Prepared> {
  const { size, themes, reuse } = args.base;
  const images: JudgeImage[] = [];
  for (const theme of themes) {
    const existing = shotPath(size, entry.id, theme);
    const path =
      reuse && isFresh(existing) ? existing : await shoot(browser, origin, size, entry, theme);
    images.push({ label: `SHOT ${theme} (the view under review)`, path });
  }
  const references: JudgeImage[] = [];
  let skip = '';
  for (const theme of themes) {
    const reference = await shootReference(browser, size, entry, theme);
    if ('path' in reference)
      references.push({
        label: `REFERENCE MOCKUP ${theme} (the visual target)`,
        path: reference.path,
      });
    else skip = reference.skip;
  }
  if (references.length === themes.length) return { entry, images: [...images, ...references] };
  return {
    entry,
    images,
    referenceNote: 'no reference mockup is attached; score fidelity null.',
    skipped: skip,
  };
}

/** Runs `claude -p` headless with only the Read tool and returns the model's text answer. */
function claudeJudge(model: string, imageDirs: readonly string[]): Judge {
  const bin = process.env.CLAUDE_BIN || 'claude';
  const cwd = mkdtempSync(join(tmpdir(), 'aplos-taste-'));
  process.once('exit', () => rmSync(cwd, { recursive: true, force: true }));
  return prompt =>
    new Promise((resolvePromise, reject) => {
      const flags = [
        '-p',
        '--model',
        model,
        '--output-format',
        'json',
        '--tools',
        'Read',
        '--allowedTools',
        'Read',
      ];
      const extra = [
        '--no-session-persistence',
        '--disable-slash-commands',
        '--max-budget-usd',
        '2',
      ];
      const dirs = imageDirs.flatMap(dir => ['--add-dir', dir]);
      // The prompt goes in on stdin: --allowedTools takes a list and would swallow a positional one.
      const child = spawn(bin, [...flags, ...extra, ...dirs], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), JUDGE_TIMEOUT_MS);
      child.stdout.on('data', chunk => (out += chunk));
      child.stderr.on('data', chunk => (err += chunk));
      child.on('error', error => reject(new Error(`cannot run ${bin}: ${error.message}`)));
      child.on('close', code => {
        clearTimeout(timer);
        try {
          resolvePromise(readClaudeResult(out, code, err));
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(prompt);
    });
}

function readClaudeResult(out: string, code: number | null, err: string): string {
  let parsed: { is_error?: boolean; result?: unknown; total_cost_usd?: number } | null = null;
  try {
    parsed = JSON.parse(out.trim().split('\n').pop() ?? '');
  } catch {
    parsed = null;
  }
  if (!parsed) throw new Error(`claude exit ${code}: ${(err || out).trim().slice(0, 300)}`);
  if (typeof parsed.total_cost_usd === 'number')
    log(`judge call cost $${parsed.total_cost_usd.toFixed(3)}`);
  if (parsed.is_error || typeof parsed.result !== 'string')
    throw new Error(`claude reported an error: ${String(parsed.result ?? err).slice(0, 300)}`);
  return parsed.result;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++)
      results[index] = await work(items[index] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main(): Promise<void> {
  const args = parseTasteArgs(process.argv.slice(2));
  const entries = sampleStates(args);
  const rubric = loadRubric(join(HERE, 'taste.rubric.md'));
  const criteria = criterionIds(rubric);
  const model = process.env.TASTE_MODEL || DEFAULT_MODEL;
  log(`taste: ${entries.length} states, ${args.runs} run(s) each, model ${model}`);

  const server = await startGalleryServer();
  const browser = await chromium.launch({ headless: true });
  let results: StateJudgement[];
  const notes: string[] = [];
  try {
    const prepared = await mapLimit(entries, CONCURRENCY, entry =>
      prepare(browser, server.origin, args, entry),
    );
    for (const item of prepared)
      if (item.skipped) notes.push(`${item.entry.id}: no mockup reference (${item.skipped})`);
    const dirs = [
      ...new Set(prepared.flatMap(item => item.images.map(image => resolve(dirname(image.path))))),
    ];
    const judge = claudeJudge(model, dirs);
    results = await mapLimit(prepared, CONCURRENCY, item =>
      judgeState({
        stateId: item.entry.id,
        title: item.entry.title,
        rubric,
        criteria,
        model,
        images: item.images,
        referenceNote: item.referenceNote,
        runs: args.runs,
        judge,
        cacheDir: CACHE_DIR,
      }),
    );
  } finally {
    await browser.close();
    server.stop();
  }

  const calls = results.reduce((sum, result) => sum + result.calls, 0);
  const hits = results.reduce((sum, result) => sum + result.cacheHits, 0);
  log(`taste: ${hits} judge cache hits, ${calls} judge calls`);
  for (const result of results)
    log(
      `  ${result.stateId}: ${result.ok ? (result.score as number).toFixed(1) : `FAILED ${result.error}`}`,
    );
  const summary = summarise(results, notes);
  if (summary.failures === results.length) {
    log(`taste: every state failed, nothing to score. ${summary.details[0] ?? ''}`);
    process.exit(1);
  }
  printScore(summary.score, summary.details);
  process.exit(0);
}

main().catch(error => {
  log(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
